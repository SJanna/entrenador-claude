/**
 * La cuenta de Garmin enlazada, en D1 y con los tokens cifrados.
 *
 * Dos decisiones que explican la forma de la tabla:
 *
 * - **Una fila o ninguna.** Un solo atleta. `id = 1` con CHECK: si algún día
 *   alguien intenta enlazar dos cuentas, falla la base, no la lógica.
 * - **La caducidad vive fuera del sobre.** Para saber si toca refrescar no hace
 *   falta descifrar nada, y así el panel puede decir «enlazado, caduca en 20
 *   minutos» sin tocar el token.
 */

import { abrir, sellar } from "./cripto";

/**
 * Error propio para la base atrasada. El 04/09/2026 se desplegó el código de la
 * migración 0006 sin aplicarla y el contrato murió con «no such column». La
 * lección quedó escrita en el README: el código tolera un esquema viejo y lo
 * dice, en vez de caerse con un mensaje de SQLite que no explica nada.
 */
export class FaltaMigracion extends Error {
  constructor() {
    super(
      "Falta la migración 0007 en la base de datos: Garmin todavía no tiene dónde " +
        "guardar la cuenta. Aplícala con `npm run db:migrate`. Nada de intervals.icu " +
        "se ve afectado.",
    );
    this.name = "FaltaMigracion";
  }
}

/** ¿Es el error de «la tabla no existe» y no otro problema de la base? */
function tablaAusente(exc: unknown): boolean {
  const mensaje = exc instanceof Error ? exc.message : String(exc);
  return /no such table/i.test(mensaje) && /garmin_cuenta/i.test(mensaje);
}

export interface TokensGarmin {
  accessToken: string;
  refreshToken: string;
  /** ms epoch en que caduca el access_token. */
  expiraEn: number;
}

export interface CuentaGarmin extends TokensGarmin {
  displayName: string;
  diClientId: string;
  enlazadoEn: string;
  actualizadoEn: string;
}

/** Lo que se puede contar sin descifrar nada: para el panel. */
export interface EstadoCuenta {
  enlazada: boolean;
  displayName: string;
  enlazadoEn: string;
  actualizadoEn: string;
  expiraEn: number;
}

export class GarminAlmacen {
  constructor(
    private readonly db: D1Database,
    private readonly sessionSecret: string,
  ) {}

  /** Estado para el panel: nunca abre el sobre. */
  async estado(): Promise<EstadoCuenta | null> {
    try {
      return await this.leerEstado();
    } catch (exc) {
      if (tablaAusente(exc)) throw new FaltaMigracion();
      throw exc;
    }
  }

  private async leerEstado(): Promise<EstadoCuenta | null> {
    const fila = await this.db
      .prepare(
        "SELECT display_name, enlazado_en, actualizado_en, expira_en FROM garmin_cuenta WHERE id = 1",
      )
      .first<{
        display_name: string;
        enlazado_en: string;
        actualizado_en: string;
        expira_en: number;
      }>();
    if (!fila) return null;
    return {
      enlazada: true,
      displayName: fila.display_name,
      enlazadoEn: fila.enlazado_en,
      actualizadoEn: fila.actualizado_en,
      expiraEn: Number(fila.expira_en),
    };
  }

  async leer(): Promise<CuentaGarmin | null> {
    let fila;
    try {
      fila = await this.leerFila();
    } catch (exc) {
      if (tablaAusente(exc)) throw new FaltaMigracion();
      throw exc;
    }
    if (!fila) return null;
    const claro = JSON.parse(await abrir(this.sessionSecret, fila.sobre)) as {
      accessToken: string;
      refreshToken: string;
    };
    return {
      accessToken: claro.accessToken,
      refreshToken: claro.refreshToken,
      expiraEn: Number(fila.expira_en),
      displayName: fila.display_name,
      diClientId: fila.di_client_id,
      enlazadoEn: fila.enlazado_en,
      actualizadoEn: fila.actualizado_en,
    };
  }

  /**
   * La fila se lee una vez por instancia (una petición o una ejecución del cron):
   * cada llamada a la API la pedía, y en el plan gratuito D1 admite 50 consultas
   * por invocación. Cualquier escritura de la cuenta la invalida.
   */
  private filaPromesa: ReturnType<GarminAlmacen["leerFilaDeVerdad"]> | null = null;

  private leerFila() {
    this.filaPromesa ??= this.leerFilaDeVerdad().catch((exc) => {
      this.filaPromesa = null;
      throw exc;
    });
    return this.filaPromesa;
  }

  private async leerFilaDeVerdad() {
    return this.db
      .prepare("SELECT * FROM garmin_cuenta WHERE id = 1")
      .first<{
        sobre: string;
        display_name: string;
        di_client_id: string;
        expira_en: number;
        enlazado_en: string;
        actualizado_en: string;
      }>();
  }

  /** Enlaza (o reenlaza) la cuenta. Conserva la fecha del primer enlace. */
  async guardar(datos: {
    tokens: TokensGarmin;
    displayName: string;
    diClientId: string;
    ahora?: string;
  }): Promise<void> {
    this.filaPromesa = null;
    const ahora = datos.ahora ?? new Date().toISOString();
    const sobre = await sellar(
      this.sessionSecret,
      JSON.stringify({
        accessToken: datos.tokens.accessToken,
        refreshToken: datos.tokens.refreshToken,
      }),
    );
    await this.db
      .prepare(
        `INSERT INTO garmin_cuenta
           (id, sobre, display_name, di_client_id, expira_en, enlazado_en, actualizado_en)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sobre = excluded.sobre,
           display_name = excluded.display_name,
           di_client_id = excluded.di_client_id,
           expira_en = excluded.expira_en,
           actualizado_en = excluded.actualizado_en`,
      )
      .bind(
        sobre,
        datos.displayName,
        datos.diClientId,
        datos.tokens.expiraEn,
        ahora,
        ahora,
      )
      .run();
    this.filaPromesa = null;
  }

  /** Tras refrescar: mismo enlace, tokens nuevos. */
  async refrescado(tokens: TokensGarmin, diClientId: string, ahora?: string): Promise<void> {
    this.filaPromesa = null;
    const sobre = await sellar(
      this.sessionSecret,
      JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
    );
    await this.db
      .prepare(
        `UPDATE garmin_cuenta
            SET sobre = ?, expira_en = ?, di_client_id = ?, actualizado_en = ?
          WHERE id = 1`,
      )
      .bind(sobre, tokens.expiraEn, diClientId, ahora ?? new Date().toISOString())
      .run();
    this.filaPromesa = null;
  }

  async borrar(): Promise<void> {
    this.filaPromesa = null;
    await this.db.prepare("DELETE FROM garmin_cuenta WHERE id = 1").run();
    this.filaPromesa = null;
  }
}
