/**
 * Eco de Garmin: ¿nos está atendiendo con normalidad?
 *
 * Nació para responder si un Worker de Cloudflare podía siquiera entrar en
 * Garmin —Garmin no tiene API pública, va detrás de una WAF, y las librerías de
 * Python que funcionan imitan la huella TLS de un navegador, cosa que un Worker
 * no puede hacer—. La respuesta, medida el 16/09/2026, fue que sí (ver
 * docs/garmin.md), así que el login real vive ahora en `cliente.ts`.
 *
 * Esto se queda como diagnóstico: cuando algo falle, distingue «Garmin nos ha
 * cerrado la puerta» de «nos hemos equivocado nosotros», sin gastar intentos de
 * login ni arriesgar la cuenta. Solo hace GET a sitios públicos y no guarda
 * nada.
 */

import {
  API_ORIGEN,
  CABECERAS_NATIVAS,
  DI_TOKEN,
  FETCH_GLOBAL,
  PERFIL,
  SSO,
  UA_IOS,
  type Fetcher,
} from "./constantes";

const TIMEOUT_MS = 20_000;
const MAX_CUERPO = 8_192;

export interface PasoSonda {
  paso: string;
  url: string;
  /** HTTP devuelto, o null si ni siquiera hubo respuesta. */
  estado: number | null;
  ms: number;
  ok: boolean;
  detalle: string;
}

/**
 * Qué ha pasado:
 *  - `paso-libre`  Garmin responde con normalidad. Si algo falla, no es esto.
 *  - `bloqueado`   la WAF corta al Worker (403 o desafío antibot).
 *  - `limitado`    429: la IP del Worker está en el cubo de rate-limit.
 *  - `protocolo`   respondió algo que no encaja: el flujo ha cambiado.
 *  - `red`         no se pudo hablar con Garmin.
 */
export type Veredicto = "paso-libre" | "bloqueado" | "limitado" | "protocolo" | "red";

export interface ResultadoSonda {
  veredicto: Veredicto;
  /** Una línea en castellano: qué significa y qué hacer. */
  resumen: string;
  pasos: PasoSonda[];
}

/** ¿Este veredicto dice que Garmin nos sigue atendiendo? */
export function viable(veredicto: Veredicto): boolean {
  return veredicto === "paso-libre";
}

class Sonda {
  readonly pasos: PasoSonda[] = [];
  private readonly fetcher: Fetcher;

  constructor(fetcher: Fetcher) {
    // Envuelto también aquí: quien nos pase el `fetch` global pelado no tiene
    // por qué saber que guardarlo en un campo lo rompería.
    this.fetcher = (entrada, init) => fetcher(entrada, init);
  }

  /**
   * Una petición medida y acotada. Nunca lanza por HTTP: el estado es el dato.
   * `esperados` son los códigos que en ESE paso significan normalidad, y no hay
   * una lista única: 403 sin token en la API es lo normal, y en la página de
   * login sería un muro.
   */
  async pedir(
    paso: string,
    url: string,
    init: RequestInit = {},
    esperados: number[] = [200],
  ): Promise<Respuesta> {
    const controlador = new AbortController();
    const reloj = setTimeout(() => controlador.abort(), TIMEOUT_MS);
    const arranque = Date.now();
    try {
      const respuesta = await this.fetcher(url, {
        ...init,
        redirect: "manual",
        signal: controlador.signal,
      });
      const texto = (await respuesta.text()).slice(0, MAX_CUERPO);
      const waf = marcaDeWaf(respuesta.status, respuesta.headers, texto);
      this.pasos.push({
        paso,
        url,
        estado: respuesta.status,
        ms: Date.now() - arranque,
        ok: respuesta.status < 400 || esperados.includes(respuesta.status),
        detalle: describir(respuesta.status, esperados, waf),
      });
      return { estado: respuesta.status, texto, waf };
    } catch (exc) {
      const motivo = controlador.signal.aborted
        ? `sin respuesta en ${TIMEOUT_MS / 1000} s`
        : exc instanceof Error
          ? exc.message
          : String(exc);
      this.pasos.push({
        paso,
        url,
        estado: null,
        ms: Date.now() - arranque,
        ok: false,
        detalle: motivo,
      });
      return { estado: null, texto: "", waf: null };
    } finally {
      clearTimeout(reloj);
    }
  }
}

interface Respuesta {
  estado: number | null;
  texto: string;
  /** Qué delata que ha cortado la WAF y no Garmin; null si nada lo delata. */
  waf: string | null;
}

/**
 * ¿Corta la WAF o contesta la aplicación? Es la distinción que decide todo, y
 * ni el código HTTP ni el cuerpo por separado la hacen:
 *
 *  - La API de Garmin devuelve 403 a cualquiera que llame sin token. Normal.
 *  - Una página de login legítima lleva un captcha embebido, y Cloudflare
 *    inyecta su script de detección (`challenge-platform`) en páginas que sirve
 *    tan campante. Buscar esas palabras en un 200 nos hizo dar por muro la
 *    portada de Garmin, que estaba perfectamente viva.
 *
 * Así que solo hay dos pruebas admisibles: que Cloudflare lo diga con la
 * cabecera `cf-mitigated`, o que la página de desafío venga con un código de
 * error. Un 200 no es un bloqueo, diga lo que diga su HTML.
 *
 * Devuelve la marca concreta —para no volver a adivinar cuál saltó— o null.
 */
function marcaDeWaf(estado: number, cabeceras: Headers, texto: string): string | null {
  const mitigado = cabeceras.get("cf-mitigated");
  if (mitigado) return `cabecera cf-mitigated: ${mitigado}`;
  if (estado < 400) return null;
  const pista = texto.toLowerCase();
  for (const marca of ["cf-chl", "_cf_chl_opt", "just a moment", "attention required"]) {
    if (pista.includes(marca)) return `cuerpo de desafío («${marca}»)`;
  }
  return null;
}

/** Lectura humana de un estado HTTP, según lo que se esperaba en ese paso. */
function describir(estado: number, esperados: number[], waf: string | null): string {
  if (waf) return `${estado}: cortado por la WAF de Cloudflare — ${waf}`;
  if (esperados.includes(estado)) {
    if (estado === 401 || estado === 403) {
      return `${estado}: alcanzable, sin autorizar (es lo esperado sin token)`;
    }
    if (estado === 405) return "405: alcanzable, método no permitido (es lo esperado)";
    return `${estado}: es lo esperado en este paso`;
  }
  if (estado === 403) return "403: prohibido, y aquí no debería serlo";
  if (estado === 429) return "429: demasiadas peticiones desde esta IP";
  if (estado >= 500) return `${estado}: fallo del lado de Garmin`;
  return `${estado}: no es lo esperado en este paso`;
}

/**
 * Eco: ¿responde Garmin a este Worker con normalidad? Sin credenciales y sin
 * intentos de login, así que no gasta cupo ni arriesga bloquear la cuenta.
 * Solo GET a páginas y endpoints públicos.
 */
export async function sondaEco(fetcher: Fetcher = FETCH_GLOBAL): Promise<ResultadoSonda> {
  const sonda = new Sonda(fetcher);

  const portada = await sonda.pedir(
    "Página de login (SSO)",
    `${SSO}/signin?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.com%2Fmodern`,
    { headers: { "user-agent": UA_IOS, accept: "text/html,application/xhtml+xml" } },
  );

  const tokens = await sonda.pedir(
    "Servicio de tokens (diauth)",
    DI_TOKEN,
    { headers: { ...CABECERAS_NATIVAS, accept: "application/json" } },
    // Un GET a un endpoint que solo acepta POST: 405 (o 400) significa que la
    // aplicación ha leído la petición, que es justo lo que queremos saber.
    [400, 405],
  );

  // Sin token, esta llamada DEBE fallar: Garmin responde 401 o 403 a cualquiera
  // que no se identifique. Ese 403 es la aplicación funcionando, no un muro; solo
  // cuenta como bloqueo si viene firmado por la WAF.
  const api = await sonda.pedir(
    "API de Garmin Connect (sin token)",
    PERFIL,
    { headers: { ...CABECERAS_NATIVAS, accept: "application/json" } },
    [401, 403],
  );

  const muro = [portada, tokens, api].find((r) => r.waf);
  const prohibido = [portada, tokens].find((r) => r.estado === 403);
  if (muro || prohibido) {
    const paso = sonda.pasos[[portada, tokens, api].indexOf(muro ?? prohibido!)]?.paso ?? "un paso";
    return {
      veredicto: "bloqueado",
      resumen:
        `Garmin corta a este Worker en «${paso}»` +
        (muro ? " con un desafío antibot" : " con un 403 donde no debería") +
        ". Es el escenario malo: la WAF no acepta a Cloudflare como cliente. El login " +
        "desde el Worker no va a funcionar sin un intermediario.",
      pasos: sonda.pasos,
    };
  }
  const limitado = [portada, tokens, api].find((r) => r.estado === 429);
  if (limitado) {
    return {
      veredicto: "limitado",
      resumen:
        "429: la IP de salida del Worker está limitada. Espera una hora larga y repite la " +
        "sonda antes de concluir nada.",
      pasos: sonda.pasos,
    };
  }
  if (portada.estado === null) {
    return {
      veredicto: "red",
      resumen: "No hubo respuesta de sso.garmin.com. Repite; si insiste, es red, no permisos.",
      pasos: sonda.pasos,
    };
  }
  if (portada.estado >= 400) {
    return {
      veredicto: "protocolo",
      resumen:
        `La página de login devolvió ${portada.estado}. No es un bloqueo claro, pero tampoco ` +
        "lo esperado: mira el detalle antes de seguir.",
      pasos: sonda.pasos,
    };
  }
  return {
    veredicto: "paso-libre",
    resumen:
      "Garmin responde con normalidad a este Worker: sirve la página de login, el servicio " +
      "de tokens procesa la petición y la API contesta como contesta a cualquiera sin token. " +
      "Buena señal, pero NO es la prueba definitiva: el filtro duro está en el POST de login. " +
      "Repite la sonda con credenciales.",
    pasos: sonda.pasos,
  };
}
