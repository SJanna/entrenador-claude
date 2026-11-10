/**
 * El enlace con Garmin: cifrado, almacén y cliente.
 *
 * Lo que se vigila aquí es lo que duele si falla en silencio:
 *  - que el token NO acabe legible en la base de datos,
 *  - que un fallo nuestro no se confunda con «Garmin nos ha cerrado»,
 *  - y que el token se renueve solo, porque volver a iniciar sesión es
 *    justamente lo que nos mete en el cubo de rate-limit de Garmin.
 */

import { describe, expect, it } from "vitest";
import { sellar, abrir, CriptoError } from "../src/garmin/cripto.ts";
import { GarminAlmacen } from "../src/garmin/almacen.ts";
import { GarminCliente, GarminError } from "../src/garmin/cliente.ts";
import { d1EnMemoria } from "./apoyo-d1.mjs";

const SECRETO = "secreto-de-sesion-largo-y-aleatorio";
const TOKENS = { accessToken: "acc-123", refreshToken: "ref-456", expiraEn: 2_000_000 };

const LOGIN_OK = { responseStatus: { type: "SUCCESSFUL" }, serviceTicketId: "ST-1-abc" };

/** fetch de mentira: guion por URL, y registro de lo que se pidió. */
function fingir(guiones, registro = []) {
  return async (entrada, init) => {
    const url = entrada.toString();
    registro.push({ url, init, autorizacion: new Headers(init?.headers).get("authorization") });
    for (const [patron, responder] of guiones) {
      if (patron.test(url)) {
        const guion = typeof responder === "function" ? responder(registro.length) : responder;
        return new Response(
          guion.cuerpo === undefined ? (guion.texto ?? "") : JSON.stringify(guion.cuerpo),
          { status: guion.estado ?? 200 },
        );
      }
    }
    throw new Error(`URL sin guion: ${url}`);
  };
}

const GUION_ENLACE = [
  [/mobile\/api\/login/, { cuerpo: LOGIN_OK }],
  [/diauth/, { cuerpo: { access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 } }],
  [/socialProfile/, { cuerpo: { displayName: "atleta-guid" } }],
];

describe("cifrado del sobre", () => {
  it("lo que se sella se abre", async () => {
    const sobre = await sellar(SECRETO, "hola");
    expect(await abrir(SECRETO, sobre)).toBe("hola");
    expect(sobre).not.toContain("hola");
  });

  it("dos sobres del mismo texto no se parecen", async () => {
    expect(await sellar(SECRETO, "hola")).not.toBe(await sellar(SECRETO, "hola"));
  });

  it("un sobre tocado no se abre a medias: no se abre", async () => {
    const sobre = await sellar(SECRETO, "hola");
    const tocado = sobre.slice(0, -2) + (sobre.endsWith("A") ? "BB" : "AA");
    await expect(abrir(SECRETO, tocado)).rejects.toBeInstanceOf(CriptoError);
  });

  it("con otro SESSION_SECRET no se abre, y lo dice", async () => {
    const sobre = await sellar(SECRETO, "hola");
    await expect(abrir("otro-secreto-distinto", sobre)).rejects.toThrow(/vuelve a enlazar/i);
  });
});

describe("almacén de la cuenta", () => {
  it("guarda, lee y no deja el token legible en la base", async () => {
    const db = d1EnMemoria();
    const almacen = new GarminAlmacen(db, SECRETO);
    await almacen.guardar({ tokens: TOKENS, displayName: "atleta", diClientId: "DI_X" });

    const cuenta = await almacen.leer();
    expect(cuenta.accessToken).toBe("acc-123");
    expect(cuenta.refreshToken).toBe("ref-456");
    expect(cuenta.displayName).toBe("atleta");

    const fila = await db.prepare("SELECT * FROM garmin_cuenta WHERE id = 1").first();
    expect(JSON.stringify(fila)).not.toContain("acc-123");
    expect(JSON.stringify(fila)).not.toContain("ref-456");
  });

  it("el estado del panel no necesita descifrar nada", async () => {
    const db = d1EnMemoria();
    // Con un secreto que ya no vale: si `estado` abriera el sobre, reventaría.
    await new GarminAlmacen(db, SECRETO).guardar({
      tokens: TOKENS,
      displayName: "atleta",
      diClientId: "DI_X",
    });
    const estado = await new GarminAlmacen(db, "otro-secreto").estado();
    expect(estado).toEqual({
      enlazada: true,
      displayName: "atleta",
      enlazadoEn: expect.any(String),
      actualizadoEn: expect.any(String),
      expiraEn: 2_000_000,
    });
  });

  it("sin cuenta, el estado es null y la lectura también", async () => {
    const almacen = new GarminAlmacen(d1EnMemoria(), SECRETO);
    expect(await almacen.estado()).toBe(null);
    expect(await almacen.leer()).toBe(null);
  });

  it("reenlazar conserva la fecha del primer enlace", async () => {
    const db = d1EnMemoria();
    const almacen = new GarminAlmacen(db, SECRETO);
    await almacen.guardar({
      tokens: TOKENS,
      displayName: "atleta",
      diClientId: "DI_X",
      ahora: "2026-01-01T00:00:00.000Z",
    });
    await almacen.guardar({
      tokens: { ...TOKENS, accessToken: "acc-nuevo" },
      displayName: "atleta",
      diClientId: "DI_X",
      ahora: "2026-06-01T00:00:00.000Z",
    });
    const cuenta = await almacen.leer();
    expect(cuenta.enlazadoEn).toBe("2026-01-01T00:00:00.000Z");
    expect(cuenta.actualizadoEn).toBe("2026-06-01T00:00:00.000Z");
    expect(cuenta.accessToken).toBe("acc-nuevo");
  });

  it("desenlazar borra el token", async () => {
    const almacen = new GarminAlmacen(d1EnMemoria(), SECRETO);
    await almacen.guardar({ tokens: TOKENS, displayName: "a", diClientId: "DI_X" });
    await almacen.borrar();
    expect(await almacen.estado()).toBe(null);
  });
});

describe("enlazar la cuenta", () => {
  it("entra, canjea el ticket, comprueba el token y lo guarda cifrado", async () => {
    const db = d1EnMemoria();
    const almacen = new GarminAlmacen(db, SECRETO);
    const registro = [];
    const cliente = new GarminCliente(almacen, fingir(GUION_ENLACE, registro), () => 1_000_000);

    expect(await cliente.enlazar("atleta@ejemplo.com", "clave")).toEqual({
      displayName: "atleta-guid",
    });

    const cuenta = await almacen.leer();
    expect(cuenta.accessToken).toBe("acc-1");
    expect(cuenta.expiraEn).toBe(1_000_000 + 3_600_000);
    expect(cuenta.diClientId).toBe("GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2");
    // La contraseña se usa y se olvida: no puede acabar en la base.
    const fila = await db.prepare("SELECT * FROM garmin_cuenta WHERE id = 1").first();
    expect(JSON.stringify(fila)).not.toContain("clave");
  });

  it("una contraseña mala se dice tal cual, sin alarmar de bloqueos", async () => {
    const cliente = new GarminCliente(
      new GarminAlmacen(d1EnMemoria(), SECRETO),
      fingir([[/mobile\/api\/login/, { cuerpo: { responseStatus: { type: "INVALID_USERNAME_PASSWORD" } } }]]),
    );
    await expect(cliente.enlazar("a@b.c", "mala")).rejects.toMatchObject({
      codigo: "credenciales",
    });
  });

  it("el segundo factor se reconoce y se admite que no está hecho", async () => {
    const cliente = new GarminCliente(
      new GarminAlmacen(d1EnMemoria(), SECRETO),
      fingir([[/mobile\/api\/login/, { cuerpo: { responseStatus: { type: "MFA_REQUIRED" } } }]]),
    );
    await expect(cliente.enlazar("a@b.c", "buena")).rejects.toMatchObject({
      codigo: "mfa_no_soportado",
    });
  });

  it("un 403 es la WAF, y un 429 es la IP: no se confunden", async () => {
    const almacen = new GarminAlmacen(d1EnMemoria(), SECRETO);
    await expect(
      new GarminCliente(almacen, fingir([[/login/, { estado: 403, texto: "no" }]])).enlazar("a@b.c", "x"),
    ).rejects.toMatchObject({ codigo: "bloqueado" });
    await expect(
      new GarminCliente(almacen, fingir([[/login/, { estado: 429, texto: "no" }]])).enlazar("a@b.c", "x"),
    ).rejects.toMatchObject({ codigo: "limitado" });
  });

  it("si Garmin rota los client_id, prueba los siguientes", async () => {
    const almacen = new GarminAlmacen(d1EnMemoria(), SECRETO);
    let intentos = 0;
    const cliente = new GarminCliente(
      almacen,
      fingir([
        [/mobile\/api\/login/, { cuerpo: LOGIN_OK }],
        [
          /diauth/,
          () => {
            intentos += 1;
            return intentos < 3
              ? { estado: 400, texto: "nope" }
              : { cuerpo: { access_token: "acc-3", refresh_token: "ref-3", expires_in: 3600 } };
          },
        ],
        [/socialProfile/, { cuerpo: { displayName: "atleta" } }],
      ]),
    );
    await cliente.enlazar("a@b.c", "x");
    expect(intentos).toBe(3);
    expect((await almacen.leer()).diClientId).toBe("GARMIN_CONNECT_MOBILE_ANDROID_DI");
  });
});

describe("llamadas a la API", () => {
  async function conCuenta(expiraEn) {
    const db = d1EnMemoria();
    const almacen = new GarminAlmacen(db, SECRETO);
    await almacen.guardar({
      tokens: { accessToken: "acc-viejo", refreshToken: "ref-1", expiraEn },
      displayName: "atleta",
      diClientId: "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2",
    });
    return almacen;
  }

  it("sin cuenta enlazada lo dice y manda al panel", async () => {
    const cliente = new GarminCliente(new GarminAlmacen(d1EnMemoria(), SECRETO), fingir([]));
    await expect(cliente.api("/userprofile-service/socialProfile")).rejects.toMatchObject({
      codigo: "no_enlazada",
    });
  });

  it("con el token vivo no refresca: va directo", async () => {
    const almacen = await conCuenta(10_000_000);
    const registro = [];
    const cliente = new GarminCliente(
      almacen,
      fingir([[/connectapi/, { cuerpo: { ok: true } }]], registro),
      () => 1_000_000,
    );
    await cliente.api("/userprofile-service/socialProfile");
    expect(registro).toHaveLength(1);
    expect(registro[0].autorizacion).toBe("Bearer acc-viejo");
  });

  it("si el token está a punto de caducar, lo renueva antes de salir", async () => {
    const almacen = await conCuenta(1_020_000); // dentro del margen de 60 s
    const registro = [];
    const cliente = new GarminCliente(
      almacen,
      fingir(
        [
          [/diauth/, { cuerpo: { access_token: "acc-nuevo", refresh_token: "ref-2", expires_in: 3600 } }],
          [/connectapi/, { cuerpo: { ok: true } }],
        ],
        registro,
      ),
      () => 1_000_000,
    );
    await cliente.api("/userprofile-service/socialProfile");
    expect(registro[0].url).toContain("diauth");
    expect(registro[1].autorizacion).toBe("Bearer acc-nuevo");
    // Y queda guardado, para que la siguiente llamada ya no refresque.
    expect((await almacen.leer()).accessToken).toBe("acc-nuevo");
  });

  it("un 401 pese a todo: refresca una vez y reintenta", async () => {
    const almacen = await conCuenta(10_000_000);
    const registro = [];
    let llamadas = 0;
    const cliente = new GarminCliente(
      almacen,
      fingir(
        [
          [/diauth/, { cuerpo: { access_token: "acc-nuevo", refresh_token: "ref-2", expires_in: 3600 } }],
          [
            /connectapi/,
            () => {
              llamadas += 1;
              return llamadas === 1 ? { estado: 401, texto: "" } : { cuerpo: { ok: true } };
            },
          ],
        ],
        registro,
      ),
      () => 1_000_000,
    );
    const respuesta = await cliente.api("/userprofile-service/socialProfile");
    expect(respuesta.status).toBe(200);
    // El de en medio es el refresco, que va con Basic del client_id, no con Bearer.
    const autorizaciones = registro.map((r) => r.autorizacion);
    expect(autorizaciones[0]).toBe("Bearer acc-viejo");
    expect(autorizaciones[1]).toMatch(/^Basic /);
    expect(autorizaciones[2]).toBe("Bearer acc-nuevo");
    expect(registro[1].url).toContain("diauth");
  });

  it("si el refresco falla, pide reenlazar en vez de insistir", async () => {
    const almacen = await conCuenta(1_020_000);
    const cliente = new GarminCliente(
      almacen,
      fingir([[/diauth/, { estado: 400, texto: "expired" }]]),
      () => 1_000_000,
    );
    await expect(cliente.api("/userprofile-service/socialProfile")).rejects.toMatchObject({
      codigo: "reenlazar",
    });
  });

  it("no deja salir a un dominio que no sea la API de Garmin", async () => {
    const almacen = await conCuenta(10_000_000);
    const cliente = new GarminCliente(almacen, fingir([]), () => 1_000_000);
    await expect(cliente.api("https://ejemplo.invalid/robar")).rejects.toBeInstanceOf(GarminError);
  });
});

describe("la base atrasada", () => {
  it("se explica en vez de morir con un error de SQLite", async () => {
    // Producción tal y como quedaría si se fusiona el código y nadie aplica la
    // migración: exactamente el fallo del 04/09/2026 con la 0006.
    const db = d1EnMemoria({ salta: ["0007"] });
    const almacen = new GarminAlmacen(db, SECRETO);
    await expect(almacen.estado()).rejects.toThrow(/migración 0007/i);
    await expect(almacen.estado()).rejects.toThrow(/db:migrate/);
    await expect(almacen.leer()).rejects.toThrow(/migración 0007/i);
  });
});
