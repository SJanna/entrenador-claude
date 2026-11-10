/**
 * El eco no puede probarse contra Garmin, así que se prueba lo que sí depende
 * de nosotros: que cada respuesta posible se traduzca al veredicto correcto.
 * Confundir «la WAF nos ha cerrado» con «la API contesta lo normal» nos haría
 * abandonar un camino que funciona — y ya pasó dos veces el 16/09/2026.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { sondaEco, viable, type PasoSonda } from "../src/garmin/sonda";
import type { Fetcher } from "../src/garmin/constantes";

interface Guion {
  estado?: number;
  cuerpo?: unknown;
  texto?: string;
  cabeceras?: Record<string, string>;
}

/** Fetch de mentira: devuelve el guion que toca según la URL pedida. */
function fingir(guiones: Array<[RegExp, Guion]>, registro: Request[] = []): Fetcher {
  return (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof entrada === "string" ? entrada : entrada.toString();
    registro.push(new Request(url, init));
    for (const [patron, guion] of guiones) {
      if (patron.test(url)) {
        const cuerpo =
          guion.texto ?? (guion.cuerpo === undefined ? "" : JSON.stringify(guion.cuerpo));
        return new Response(cuerpo, {
          status: guion.estado ?? 200,
          headers: guion.cabeceras,
        });
      }
    }
    throw new Error(`URL sin guion: ${url}`);
  }) as Fetcher;
}

describe("sonda de eco", () => {
  it("cuenta el camino abierto cuando Garmin responde con normalidad", async () => {
    const resultado = await sondaEco(
      fingir([
        [/sso\.garmin\.com/, { estado: 200, texto: "<html>login</html>" }],
        [/diauth/, { estado: 405 }],
        [/connectapi/, { estado: 401 }],
      ]),
    );
    expect(resultado.veredicto).toBe("paso-libre");
    expect(viable(resultado.veredicto)).toBe(true);
    const pasos: PasoSonda[] = resultado.pasos;
    expect(pasos).toHaveLength(3);
    expect(resultado.pasos[2]?.detalle).toContain("alcanzable");
  });

  it("un 403 con página de desafío es la WAF, y lo dice con la prueba", async () => {
    const resultado = await sondaEco(
      fingir([
        [
          /sso\.garmin\.com/,
          { estado: 403, texto: "<html><title>Just a moment...</title></html>" },
        ],
        [/diauth/, { estado: 405 }],
        [/connectapi/, { estado: 401 }],
      ]),
    );
    expect(resultado.veredicto).toBe("bloqueado");
    expect(resultado.pasos[0]?.detalle).toContain("WAF de Cloudflare");
    expect(resultado.pasos[0]?.detalle).toContain("just a moment");
  });

  it("una página de login con captcha dentro no es un bloqueo", async () => {
    // Caso real del 16/09/2026: la portada de Garmin llegó con 200 y la sonda la
    // llamó «desafío antibot» porque el HTML mencionaba un captcha. Toda página
    // de login lleva uno, y Cloudflare inyecta su script de detección en páginas
    // que sirve tan tranquila. Un 200 no es un muro.
    const resultado = await sondaEco(
      fingir([
        [
          /sso\.garmin\.com/,
          {
            estado: 200,
            texto:
              '<html><script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js">' +
              '</script><div class="g-recaptcha">captcha</div></html>',
          },
        ],
        [/diauth/, { estado: 405 }],
        [/connectapi/, { estado: 403 }],
      ]),
    );
    expect(resultado.veredicto).toBe("paso-libre");
  });

  it("el 403 de la API sin token es lo normal, no un muro", async () => {
    // Caso real del 16/09/2026: la sonda lo llamó «bloqueado» y era la API
    // contestando lo que le contesta a cualquiera que llame sin Bearer. Dar por
    // muerto un camino abierto es el error caro de las dos direcciones.
    const resultado = await sondaEco(
      fingir([
        [/sso\.garmin\.com/, { estado: 200, texto: "<html>login</html>" }],
        [/diauth/, { estado: 405 }],
        [/connectapi/, { estado: 403, texto: '{"message":"Forbidden"}' }],
      ]),
    );
    expect(resultado.veredicto).toBe("paso-libre");
    expect(resultado.pasos[2]?.detalle).toContain("es lo esperado sin token");
    expect(resultado.pasos[2]?.ok).toBe(true);
  });

  it("pero un 403 en la página de login sí lo es", async () => {
    const resultado = await sondaEco(
      fingir([
        [/sso\.garmin\.com/, { estado: 403, texto: '{"message":"Forbidden"}' }],
        [/diauth/, { estado: 405 }],
        [/connectapi/, { estado: 403 }],
      ]),
    );
    expect(resultado.veredicto).toBe("bloqueado");
    expect(resultado.resumen).toContain("Página de login");
  });

  it("cree a Cloudflare cuando firma el bloqueo, aunque el código parezca normal", async () => {
    const resultado = await sondaEco(
      fingir([
        [/sso\.garmin\.com/, { estado: 200, cabeceras: { "cf-mitigated": "challenge" } }],
        [/diauth/, { estado: 405 }],
        [/connectapi/, { estado: 403 }],
      ]),
    );
    expect(resultado.veredicto).toBe("bloqueado");
    expect(resultado.resumen).toContain("desafío antibot");
    expect(resultado.pasos[0]?.detalle).toContain("cf-mitigated");
  });

  it("un 405 del servicio de tokens es alcanzabilidad, no fallo", async () => {
    const resultado = await sondaEco(
      fingir([
        [/sso\.garmin\.com/, { estado: 200 }],
        [/diauth/, { estado: 405 }],
        [/connectapi/, { estado: 401 }],
      ]),
    );
    expect(resultado.pasos[1]?.ok).toBe(true);
    expect(resultado.pasos[1]?.detalle).toContain("es lo esperado");
  });

  it("no da por muerto el camino con un 429: pide reintentar", async () => {
    const resultado = await sondaEco(
      fingir([
        [/sso\.garmin\.com/, { estado: 429 }],
        [/diauth/, { estado: 405 }],
        [/connectapi/, { estado: 401 }],
      ]),
    );
    expect(resultado.veredicto).toBe("limitado");
    expect(resultado.resumen).toContain("repite");
  });
});

/**
 * Regresión de la primera versión, que nunca llegó a salir del Worker: guardaba
 * el `fetch` global en un campo y lo llamaba como `this.fetcher(...)`. En
 * Cloudflare eso es «Illegal invocation» —fetch exige que su `this` sea el
 * global—, y la sonda lo enterraba como «sin respuesta de Garmin», que es
 * justo la conclusión contraria a la verdadera. Node no es tan estricto, así
 * que aquí se imita esa regla a mano.
 */
describe("el fetch global no puede llamarse como método", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Un fetch que exige lo mismo que el de un Worker: `this` global o nada. */
  function fetchEstricto(this: unknown, entrada: RequestInfo | URL): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    void entrada;
    return Promise.resolve(new Response("<html>login</html>"));
  }

  it("el eco sale a la red usando el fetch por defecto", async () => {
    vi.stubGlobal("fetch", fetchEstricto);
    const resultado = await sondaEco();
    expect(resultado.veredicto).not.toBe("red");
    expect(JSON.stringify(resultado)).not.toContain("Illegal invocation");
  });

  it("y tampoco se rompe si nos pasan el fetch global pelado", async () => {
    vi.stubGlobal("fetch", fetchEstricto);
    const resultado = await sondaEco(globalThis.fetch);
    expect(resultado.veredicto).not.toBe("red");
  });
});
