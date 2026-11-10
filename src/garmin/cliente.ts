/**
 * Cliente de Garmin Connect: entrar una vez, vivir del refresco.
 *
 * Entrar cuesta ~2 s y pasa por la WAF de Garmin; las IPs de salida de
 * Cloudflare son compartidas, así que repetir el login es la vía más rápida de
 * acabar en su cubo de rate-limit. Por eso aquí solo se inicia sesión cuando el
 * atleta enlaza la cuenta a mano desde el panel: el resto del tiempo se refresca
 * el token, que es una llamada barata y sin desafíos.
 *
 * Adaptado de python-garminconnect (MIT) y garth (MIT). Ver docs/garmin.md.
 */

import {
  API_ORIGEN,
  CABECERAS_NATIVAS,
  CLIENTE_IOS,
  CLIENTES_DI,
  DI_GRANT,
  DI_TOKEN,
  FETCH_GLOBAL,
  LOGIN_MOVIL,
  PERFIL,
  SERVICIO_IOS,
  SSO_ORIGEN,
  UA_IOS,
  type Fetcher,
} from "./constantes";
import type { GarminAlmacen, TokensGarmin } from "./almacen";

export type CodigoGarmin =
  | "no_enlazada"
  | "credenciales"
  | "mfa_no_soportado"
  | "bloqueado"
  | "limitado"
  | "reenlazar"
  | "protocolo"
  | "red";

export class GarminError extends Error {
  constructor(
    readonly codigo: CodigoGarmin,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = "GarminError";
  }
}

const TIMEOUT_MS = 25_000;
/** Margen para no salir con un token que caduca a mitad de la petición. */
const MARGEN_MS = 60_000;

interface RespuestaDi {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

/** `exp` del JWT, por si Garmin no manda `expires_in`. */
function caducidadJwt(token: string): number {
  const partes = token.split(".");
  if (partes.length !== 3 || !partes[1]) return 0;
  try {
    const normal = partes[1].replaceAll("-", "+").replaceAll("_", "/");
    const carga = JSON.parse(atob(normal.padEnd(Math.ceil(normal.length / 4) * 4, "="))) as {
      exp?: unknown;
    };
    const exp = Number(carga.exp);
    return Number.isSafeInteger(exp) && exp > 0 ? exp * 1_000 : 0;
  } catch {
    return 0;
  }
}

function leerTokens(valor: unknown, ahora: number, refrescoPrevio?: string): TokensGarmin {
  if (!valor || typeof valor !== "object") {
    throw new GarminError("protocolo", "Garmin devolvió algo que no es un token.");
  }
  const cuerpo = valor as RespuestaDi;
  const accessToken = typeof cuerpo.access_token === "string" ? cuerpo.access_token : "";
  const refreshToken =
    typeof cuerpo.refresh_token === "string" ? cuerpo.refresh_token : (refrescoPrevio ?? "");
  const segundos = Number(cuerpo.expires_in);
  const expiraEn =
    Number.isSafeInteger(segundos) && segundos > 0
      ? ahora + segundos * 1_000
      : caducidadJwt(accessToken);
  if (!accessToken || !refreshToken || !expiraEn) {
    throw new GarminError("protocolo", "El token de Garmin viene incompleto.");
  }
  return { accessToken, refreshToken, expiraEn };
}

export class GarminCliente {
  private readonly fetcher: Fetcher;

  constructor(
    private readonly almacen: GarminAlmacen,
    fetcher: Fetcher = FETCH_GLOBAL,
    private readonly ahora: () => number = Date.now,
  ) {
    this.fetcher = (entrada, init) => fetcher(entrada, init);
  }

  private async pedir(url: string, init: RequestInit = {}): Promise<Response> {
    const controlador = new AbortController();
    const reloj = setTimeout(() => controlador.abort(), TIMEOUT_MS);
    try {
      const respuesta = await this.fetcher(url, {
        ...init,
        redirect: "manual",
        signal: controlador.signal,
      });
      if (respuesta.status === 429) {
        throw new GarminError(
          "limitado",
          "Garmin está limitando las peticiones desde este Worker (429). Las IPs de " +
            "Cloudflare son compartidas: espera un rato largo antes de reintentar.",
        );
      }
      return respuesta;
    } catch (exc) {
      if (exc instanceof GarminError) throw exc;
      throw new GarminError(
        "red",
        controlador.signal.aborted
          ? "Garmin no respondió a tiempo."
          : `No se pudo hablar con Garmin: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    } finally {
      clearTimeout(reloj);
    }
  }

  /**
   * Enlaza la cuenta: login, canje del ticket y comprobación del token contra
   * la API. La contraseña se usa aquí y se olvida; nunca se guarda.
   */
  async enlazar(email: string, password: string): Promise<{ displayName: string }> {
    const url = new URL(LOGIN_MOVIL);
    url.search = new URLSearchParams({
      clientId: CLIENTE_IOS,
      locale: "en-US",
      service: SERVICIO_IOS,
    }).toString();

    const respuesta = await this.pedir(url.toString(), {
      method: "POST",
      headers: {
        "user-agent": UA_IOS,
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        origin: SSO_ORIGEN,
      },
      body: JSON.stringify({ username: email, password, rememberMe: true, captchaToken: "" }),
    });

    if (respuesta.status === 403) {
      throw new GarminError(
        "bloqueado",
        "Garmin rechazó el intento con un 403: su protección antibot ha cortado al Worker.",
      );
    }
    let cuerpo: Record<string, unknown>;
    try {
      cuerpo = (await respuesta.json()) as Record<string, unknown>;
    } catch {
      throw new GarminError(
        "protocolo",
        `Garmin respondió ${respuesta.status} con algo que no es JSON. Puede haber cambiado ` +
          "el flujo de login.",
      );
    }

    const tipo = String(
      (cuerpo.responseStatus as Record<string, unknown> | undefined)?.type ?? "",
    );
    if (tipo === "INVALID_USERNAME_PASSWORD") {
      throw new GarminError("credenciales", "Usuario o contraseña de Garmin incorrectos.");
    }
    if (tipo === "CAPTCHA_REQUIRED") {
      throw new GarminError(
        "bloqueado",
        "Garmin pide resolver un captcha: ha tomado al Worker por un bot. Vuelve a " +
          "intentarlo más tarde.",
      );
    }
    if (tipo === "MFA_REQUIRED") {
      throw new GarminError(
        "mfa_no_soportado",
        "Tu cuenta de Garmin pide un segundo factor y el enlace todavía no lo sabe hacer. " +
          "Desactívalo temporalmente para enlazar, o dilo y lo implemento.",
      );
    }
    if (tipo !== "SUCCESSFUL") {
      throw new GarminError(
        "protocolo",
        `Respuesta inesperada de Garmin al entrar (${tipo || "sin estado"}).`,
      );
    }

    const ticket = String(cuerpo.serviceTicketId ?? "");
    if (!ticket) {
      throw new GarminError("protocolo", "Garmin aceptó el login pero no dio ticket de servicio.");
    }

    const { tokens, diClientId } = await this.canjear(ticket);
    const displayName = await this.comprobar(tokens.accessToken);
    await this.almacen.guardar({ tokens, displayName, diClientId });
    return { displayName };
  }

  /** Ticket de servicio → tokens OAuth2. Garmin rota sus client_id: se prueban. */
  private async canjear(ticket: string): Promise<{ tokens: TokensGarmin; diClientId: string }> {
    for (const cliente of CLIENTES_DI) {
      const respuesta = await this.pedir(DI_TOKEN, {
        method: "POST",
        headers: {
          ...CABECERAS_NATIVAS,
          authorization: `Basic ${btoa(`${cliente}:`)}`,
          accept: "application/json,text/html;q=0.9,*/*;q=0.8",
          "content-type": "application/x-www-form-urlencoded",
          "cache-control": "no-cache",
        },
        body: new URLSearchParams({
          client_id: cliente,
          service_ticket: ticket,
          grant_type: DI_GRANT,
          service_url: SERVICIO_IOS,
        }).toString(),
      });
      if (!respuesta.ok) {
        await respuesta.body?.cancel();
        continue;
      }
      try {
        return {
          tokens: leerTokens(await respuesta.json(), this.ahora()),
          diClientId: cliente,
        };
      } catch {
        // Ese client_id contestó algo que no sirve: el siguiente.
      }
    }
    throw new GarminError(
      "protocolo",
      "Ningún identificador de app sirvió para canjear el ticket: Garmin los ha rotado.",
    );
  }

  /** Prueba de vida del token, y de paso quién es el atleta. */
  private async comprobar(accessToken: string): Promise<string> {
    const respuesta = await this.pedir(PERFIL, {
      headers: {
        ...CABECERAS_NATIVAS,
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
    if (!respuesta.ok) {
      throw new GarminError(
        "protocolo",
        `Hay token, pero la API de Garmin lo rechaza (${respuesta.status}).`,
      );
    }
    try {
      const perfil = (await respuesta.json()) as Record<string, unknown>;
      return String(perfil.displayName ?? perfil.fullName ?? "");
    } catch {
      return "";
    }
  }

  private async refrescar(cuenta: { refreshToken: string; diClientId: string }): Promise<string> {
    const respuesta = await this.pedir(DI_TOKEN, {
      method: "POST",
      headers: {
        ...CABECERAS_NATIVAS,
        authorization: `Basic ${btoa(`${cuenta.diClientId}:`)}`,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "cache-control": "no-cache",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: cuenta.diClientId,
        refresh_token: cuenta.refreshToken,
      }).toString(),
    });
    if (!respuesta.ok) {
      await respuesta.body?.cancel();
      throw new GarminError(
        "reenlazar",
        `Garmin no renovó el token (${respuesta.status}). Vuelve a enlazar la cuenta desde ` +
          "el panel: /app/garmin.",
      );
    }
    const tokens = leerTokens(await respuesta.json(), this.ahora(), cuenta.refreshToken);
    await this.almacen.refrescado(tokens, cuenta.diClientId);
    return tokens.accessToken;
  }

  /**
   * Quién es el atleta en Garmin. Dos endpoints de bienestar llevan el
   * `displayName` en la ruta, y pedirlo cada vez a la API sería una llamada de
   * más: se guardó al enlazar.
   */
  async atleta(): Promise<string> {
    const cuenta = await this.almacen.leer();
    if (!cuenta) {
      throw new GarminError(
        "no_enlazada",
        "No hay ninguna cuenta de Garmin enlazada. Entra en /app/garmin del panel y enlázala.",
      );
    }
    if (!cuenta.displayName) {
      throw new GarminError(
        "reenlazar",
        "La cuenta enlazada no guardó el identificador del atleta. Vuelve a enlazarla en " +
          "/app/garmin.",
      );
    }
    return cuenta.displayName;
  }

  /**
   * Petición autenticada contra la API. Refresca si el token está a punto de
   * caducar, y una vez más si la API contesta 401 pese a todo (el reloj de
   * Garmin manda sobre el nuestro).
   */
  async api(ruta: string, init: RequestInit = {}): Promise<Response> {
    const cuenta = await this.almacen.leer();
    if (!cuenta) {
      throw new GarminError(
        "no_enlazada",
        "No hay ninguna cuenta de Garmin enlazada. Entra en /app/garmin del panel y enlázala.",
      );
    }

    const url = new URL(ruta, API_ORIGEN);
    if (url.origin !== API_ORIGEN) {
      throw new GarminError("protocolo", `Ruta fuera de la API de Garmin: ${ruta}`);
    }

    let token = cuenta.accessToken;
    if (cuenta.expiraEn - MARGEN_MS <= this.ahora()) {
      token = await this.refrescar(cuenta);
    }

    const lanzar = (bearer: string): Promise<Response> =>
      this.pedir(url.toString(), {
        ...init,
        headers: {
          ...CABECERAS_NATIVAS,
          accept: "application/json",
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${bearer}`,
        },
      });

    let respuesta = await lanzar(token);
    if (respuesta.status === 401) {
      await respuesta.body?.cancel();
      respuesta = await lanzar(await this.refrescar(cuenta));
    }
    return respuesta;
  }
}
