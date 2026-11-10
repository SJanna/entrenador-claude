/**
 * La parte privada de la página pública, en D1 (migración 0008): temporadas,
 * día D, plan semanal, hitos manuales, sesiones programadas y lo publicado.
 *
 * Nada de esto se sirve tal cual: lo lee el cálculo y lo que sale pasa por la
 * lista blanca de `esquema.ts`.
 */

import type { CumplimientoDia, HitoManual, PlanSemana, Temporada } from "./compute";

export class FaltaMigracionPublico extends Error {
  constructor() {
    super(
      "Falta la migración 0008 en la base de datos: la página pública todavía no tiene " +
        "dónde guardar temporadas ni plan. Aplícala con `npm run db:migrate`. El resto de la " +
        "app no se ve afectado.",
    );
    this.name = "FaltaMigracionPublico";
  }
}

function tablaAusente(exc: unknown): boolean {
  const mensaje = exc instanceof Error ? exc.message : String(exc);
  return /no such table/i.test(mensaje) && /publico_/i.test(mensaje);
}

async function conMigracion<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (exc) {
    if (tablaAusente(exc)) throw new FaltaMigracionPublico();
    throw exc;
  }
}

export interface FilaProgramada {
  programacion: string;
  fecha: string;
  categoria: string;
  segundos: number | null;
  cumplida: boolean;
}

export interface ConfigPublica {
  diaD: string;
  temporadas: Temporada[];
  cumplimientoHasta: string | null;
}

export interface CambiosPublicos {
  diaD?: string;
  temporadas?: Temporada[];
  plan?: PlanSemana[];
  hitos?: Array<{ clave: string; fecha: string | null }>;
}

export class PublicoStore {
  constructor(private db: D1Database) {}

  async config(): Promise<ConfigPublica> {
    return conMigracion(async () => {
      const [temporadas, ajustes] = await Promise.all([
        this.db
          .prepare("SELECT numero, nombre, desde, hasta FROM publico_temporadas ORDER BY numero")
          .all<Temporada>(),
        this.db.prepare("SELECT clave, valor FROM publico_config").all<{ clave: string; valor: string }>(),
      ]);
      const mapa = new Map((ajustes.results ?? []).map((f) => [f.clave, f.valor]));
      return {
        diaD: mapa.get("dia_d") ?? "",
        temporadas: temporadas.results ?? [],
        cumplimientoHasta: mapa.get("cumplimiento_hasta") ?? null,
      };
    });
  }

  async plan(): Promise<PlanSemana[]> {
    return conMigracion(async () => {
      const filas = await this.db
        .prepare("SELECT lunes, km FROM publico_plan_semanal ORDER BY lunes")
        .all<PlanSemana>();
      return filas.results ?? [];
    });
  }

  async hitosManuales(): Promise<HitoManual[]> {
    return conMigracion(async () => {
      const filas = await this.db
        .prepare("SELECT clave, fecha FROM publico_hitos_manuales ORDER BY clave")
        .all<HitoManual>();
      return filas.results ?? [];
    });
  }

  async programadas(desde: string): Promise<FilaProgramada[]> {
    return conMigracion(async () => {
      const filas = await this.db
        .prepare(
          "SELECT programacion, fecha, categoria, segundos, cumplida FROM publico_programadas " +
            "WHERE fecha >= ? ORDER BY fecha, programacion",
        )
        .bind(desde)
        .all<Omit<FilaProgramada, "cumplida"> & { cumplida: number }>();
      return (filas.results ?? []).map((f) => ({ ...f, cumplida: f.cumplida === 1 }));
    });
  }

  async cumplimientoDias(desde: string): Promise<CumplimientoDia[]> {
    return (await this.programadas(desde)).map((f) => ({ fecha: f.fecha, cumplida: f.cumplida }));
  }

  /** Último día guardado, para rellenar solo el hueco si el cron faltó días. */
  async ultimaProgramada(): Promise<string | null> {
    return conMigracion(async () => {
      const fila = await this.db
        .prepare("SELECT MAX(fecha) AS ultima FROM publico_programadas")
        .first<{ ultima: string | null }>();
      return fila?.ultima ?? null;
    });
  }

  /**
   * Guarda las sesiones de los días ya leídos y marca hasta dónde llega el dato.
   * Upsert: el mismo día se puede reescribir (Garmin sincroniza tarde), pero una
   * fila nunca se borra porque la cita desaparezca de Garmin.
   */
  async guardarProgramadas(filas: FilaProgramada[], hasta: string, ahora: string): Promise<void> {
    await conMigracion(async () => {
      const sentencias = filas.map((f) =>
        this.db
          .prepare(
            "INSERT INTO publico_programadas (programacion, fecha, categoria, segundos, cumplida, actualizado_en) " +
              "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(programacion) DO UPDATE SET " +
              "fecha = excluded.fecha, categoria = excluded.categoria, segundos = excluded.segundos, " +
              "cumplida = excluded.cumplida, actualizado_en = excluded.actualizado_en",
          )
          .bind(f.programacion, f.fecha, f.categoria, f.segundos, f.cumplida ? 1 : 0, ahora),
      );
      sentencias.push(this.ajuste("cumplimiento_hasta", hasta, ahora));
      for (let i = 0; i < sentencias.length; i += 100) {
        await this.db.batch(sentencias.slice(i, i + 100));
      }
    });
  }

  async guardarSnapshot(fecha: string, json: string, publicado: boolean, ahora: string): Promise<void> {
    await conMigracion(async () => {
      await this.db
        .prepare(
          "INSERT INTO publico_snapshots (fecha, json, publicado, creado_en) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(fecha) DO UPDATE SET json = excluded.json, " +
            "publicado = MAX(publicado, excluded.publicado), creado_en = excluded.creado_en",
        )
        .bind(fecha, json, publicado ? 1 : 0, ahora)
        .run();
    });
  }

  /** Todo o nada: la validación va antes, aquí solo se escribe en un batch. */
  async aplicar(cambios: CambiosPublicos, ahora: string): Promise<void> {
    await conMigracion(async () => {
      const sentencias: D1PreparedStatement[] = [];
      if (cambios.diaD) sentencias.push(this.ajuste("dia_d", cambios.diaD, ahora));
      for (const t of cambios.temporadas ?? []) {
        sentencias.push(
          this.db
            .prepare(
              "UPDATE publico_temporadas SET nombre = ?, desde = ?, hasta = ?, actualizado_en = ? WHERE numero = ?",
            )
            .bind(t.nombre, t.desde, t.hasta, ahora, t.numero),
        );
      }
      for (const p of cambios.plan ?? []) {
        sentencias.push(
          this.db
            .prepare(
              "INSERT INTO publico_plan_semanal (lunes, km, creado_en, actualizado_en) VALUES (?, ?, ?, ?) " +
                "ON CONFLICT(lunes) DO UPDATE SET km = excluded.km, actualizado_en = excluded.actualizado_en",
            )
            .bind(p.lunes, p.km, ahora, ahora),
        );
      }
      for (const h of cambios.hitos ?? []) {
        sentencias.push(
          h.fecha === null
            ? this.db.prepare("DELETE FROM publico_hitos_manuales WHERE clave = ?").bind(h.clave)
            : this.db
                .prepare(
                  "INSERT INTO publico_hitos_manuales (clave, fecha, actualizado_en) VALUES (?, ?, ?) " +
                    "ON CONFLICT(clave) DO UPDATE SET fecha = excluded.fecha, actualizado_en = excluded.actualizado_en",
                )
                .bind(h.clave, h.fecha, ahora),
        );
      }
      if (sentencias.length) await this.db.batch(sentencias);
    });
  }

  private ajuste(clave: string, valor: string, ahora: string): D1PreparedStatement {
    return this.db
      .prepare(
        "INSERT INTO publico_config (clave, valor, actualizado_en) VALUES (?, ?, ?) " +
          "ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en",
      )
      .bind(clave, valor, ahora);
  }
}
