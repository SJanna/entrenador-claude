/**
 * Los umbrales de Garmin y la conversión de porcentajes.
 *
 * Todo este módulo existe para no escribir en el reloj un número plausible y
 * falso, así que lo que se prueba es justo eso: que no se acepte un valor que
 * no puede ser, que se prefiera la fuente buena, y que la convención de cada
 * porcentaje quede FIJADA —si un día alguien cambia hr_pct de LTHR a FC máxima,
 * todos los entrenos salen mal y nadie se entera hasta que el atleta corre.
 */

import { describe, expect, it } from "vitest";
import type { GarminCliente } from "../src/garmin/cliente";
import {
  buscarNumero,
  discrepantes,
  elegirZonas,
  formatearUmbrales,
  leerUmbrales,
  umbralesDeIntervals,
  zonasFcDeGarmin,
} from "../src/garmin/umbrales";
import { construirEntreno } from "../src/garmin/entrenos";

function cliente(guion: Array<[RegExp, { estado?: number; cuerpo?: unknown }]>) {
  const rutas: string[] = [];
  const falso = {
    async api(ruta: string) {
      rutas.push(ruta);
      for (const [patron, respuesta] of guion) {
        if (patron.test(ruta)) {
          const estado = respuesta.estado ?? 200;
          return new Response(estado === 204 ? null : JSON.stringify(respuesta.cuerpo ?? null), {
            status: estado,
          });
        }
      }
      return new Response("", { status: 404 });
    },
  };
  return { rutas, falso: falso as unknown as GarminCliente };
}

describe("buscar el número", () => {
  it("lo encuentra por nombre, esté donde esté", () => {
    const arbol = { a: { b: [{ c: { lactateThresholdHeartRate: 168 } }] } };
    expect(buscarNumero(arbol, ["lactateThresholdHeartRate"], [90, 220])).toBe(168);
  });

  it("no se traga un número imposible aunque la clave encaje", () => {
    // Garmin devuelve ceros y centinelas con nombres perfectamente correctos.
    expect(buscarNumero({ functionalThresholdPower: 0 }, ["functionalThresholdPower"], [40, 700]))
      .toBe(null);
    expect(buscarNumero({ maxHeartRate: 4 }, ["maxHeartRate"], [120, 230])).toBe(null);
  });

  it("prefiere lo de arriba a lo de un histórico enterrado", () => {
    const arbol = {
      historico: { dias: [{ lactateThresholdHeartRate: 150 }] },
      lactateThresholdHeartRate: 172,
    };
    expect(buscarNumero(arbol, ["lactateThresholdHeartRate"], [90, 220])).toBe(172);
  });

  it("con un valor imposible arriba sigue buscando abajo", () => {
    const arbol = { lactateThresholdHeartRate: 0, dentro: { lactateThresholdHeartRate: 165 } };
    expect(buscarNumero(arbol, ["lactateThresholdHeartRate"], [90, 220])).toBe(165);
  });

  it("no se queda colgado con un árbol que se apunta a sí mismo", () => {
    const arbol: Record<string, unknown> = { maxHeartRate: 190 };
    arbol.yo = arbol;
    expect(buscarNumero(arbol, ["maxHeartRate"], [120, 230])).toBe(190);
  });
});

describe("leer los umbrales", () => {
  it("los saca de donde estén y dice de dónde", async () => {
    const { falso } = cliente([
      [
        /user-settings/,
        { cuerpo: { userData: { lactateThresholdHeartRate: 172, maxHeartRate: 196 } } },
      ],
      [/heartRateZones/, { cuerpo: {} }],
      [/functionalThresholdPower/, { cuerpo: [{ value: 0, functionalThresholdPower: 248 }] }],
      [/lactateThresholdSpeed/, { cuerpo: [{ lactateThresholdSpeed: 3.85 }] }],
      [/lactateThresholdHeartRate/, { cuerpo: [] }],
    ]);
    const umbrales = await leerUmbrales(falso, "2026-09-16");

    expect(umbrales.lthr).toEqual({ valor: 172, fuente: "Garmin · ajustes del perfil" });
    expect(umbrales.fcMax).toEqual({ valor: 196, fuente: "Garmin · ajustes del perfil" });
    expect(umbrales.ftp).toEqual({ valor: 248, fuente: "Garmin · histórico de FTP" });
    expect(umbrales.velocidadUmbral?.valor).toBe(3.85);
    expect(umbrales.fallos).toEqual([]);
  });

  it("lo que no está sale sin valor, no a cero", async () => {
    const { falso } = cliente([]);
    const umbrales = await leerUmbrales(falso, "2026-09-16");
    expect(umbrales.lthr).toBeUndefined();
    expect(umbrales.ftp).toBeUndefined();
    expect(umbrales.fallos).toEqual([]);
  });

  it("un endpoint roto se apunta y no tumba los demás", async () => {
    const { falso } = cliente([
      [/user-settings/, { estado: 500 }],
      [/heartRateZones/, { cuerpo: { lactateThresholdHeartRate: 170 } }],
    ]);
    const umbrales = await leerUmbrales(falso, "2026-09-16");
    expect(umbrales.fallos).toEqual(["ajustes del perfil (500)"]);
    expect(umbrales.lthr).toEqual({ valor: 170, fuente: "Garmin · zonas de FC" });
  });

  it("la ventana del histórico es el último año", async () => {
    const { rutas, falso } = cliente([]);
    await leerUmbrales(falso, "2026-09-16");
    expect(rutas.some((r) => r.includes("/range/2025-09-16/2026-09-16"))).toBe(true);
  });

  it("el informe enseña el ritmo en minutos por kilómetro, no en m/s a secas", async () => {
    const { falso } = cliente([[/user-settings/, { cuerpo: { lactateThresholdSpeed: 3.7037 } }]]);
    const texto = formatearUmbrales(await leerUmbrales(falso, "2026-09-16"));
    expect(texto).toContain("4:30/km");
    expect(texto).toContain("plausible y falso");
  });
});

describe("la convención de cada porcentaje", () => {
  const umbrales = {
    lthr: { valor: 170, fuente: "ajustes del perfil" },
    fcMax: { valor: 200, fuente: "ajustes del perfil" },
    ftp: { valor: 250, fuente: "ajustes del perfil" },
    velocidadUmbral: { valor: 4, fuente: "ajustes del perfil" }, // 4:10/km
    fallos: [],
  };
  const paso = (step: Record<string, unknown>) => {
    const { entreno, conversiones } = construirEntreno({
      nombre: "x",
      deporte: "Run",
      pasos: [{ duration: "10m", ...step }],
      umbrales,
    });
    return {
      objetivo: (entreno.workoutSegments[0]!.workoutSteps as Array<Record<string, unknown>>)[0]!,
      conversiones,
    };
  };

  it("hr_pct es sobre la LTHR, NO sobre la frecuencia máxima", () => {
    // Misma convención que intervals.icu, para que los dos caminos coincidan.
    // Con FC máx daría 180; con LTHR, 153.
    const { objetivo, conversiones } = paso({ hr_pct: 90 });
    expect(objetivo).toMatchObject({ targetValueOne: 153, targetValueTwo: 153 });
    expect(conversiones[0]).toContain("90 % de LTHR 170 ppm → 153 ppm");
  });

  it("power_pct es sobre el FTP", () => {
    expect(paso({ power_pct: [95, 105] }).objetivo).toMatchObject({
      targetType: { workoutTargetTypeKey: "power.zone" },
      targetValueOne: 238,
      targetValueTwo: 263,
    });
  });

  it("pace_pct va sobre la VELOCIDAD: más porcentaje es más rápido", () => {
    const { objetivo, conversiones } = paso({ pace_pct: 110 });
    expect(objetivo.targetValueOne).toBeCloseTo(4.4, 3);
    // 4,4 m/s son 3:47/km; el umbral (4 m/s) es 4:10/km. Más rápido.
    expect(conversiones[0]).toContain("3:47/km");
    expect(conversiones[0]).toContain("más % es más rápido");
  });

  it("un rango se convierte por los dos extremos", () => {
    expect(paso({ hr_pct: [80, 90] }).objetivo).toMatchObject({
      targetValueOne: 136,
      targetValueTwo: 153,
    });
  });

  it("un entreno sin porcentajes no anota conversiones", () => {
    expect(paso({ bpm: 145 }).conversiones).toEqual([]);
  });

  it("falta el umbral de ESE porcentaje, aunque haya otros", () => {
    expect(() =>
      construirEntreno({
        nombre: "x",
        deporte: "Ride",
        pasos: [{ duration: "10m", power_pct: 90 }],
        umbrales: { lthr: { valor: 170, fuente: "x" }, fallos: [] },
      }),
    ).toThrow(/FTP/);
  });
});


describe("quién manda sobre los umbrales", () => {
  // Manda Garmin: es el origen de los datos —intervals los recibe de ahí— y es
  // lo que acaba en el reloj. Pero intervals no es solo una copia: un umbral
  // editado ahí a mano no vuelve a Garmin. El 16/09/2026 intervals decía LTHR
  // 193 y Garmin 190, así que la diferencia nunca se resuelve en silencio.
  const AJUSTES = [
    { types: ["Ride"], lthr: 170, ftp: 250 },
    { types: ["Run", "TrailRun"], lthr: 193, max_hr: 213, threshold_pace: 3.9 },
  ];

  it("saca los umbrales del deporte que toca, no del primero", () => {
    expect(umbralesDeIntervals(AJUSTES, "Run")).toEqual({
      lthr: 193,
      fcMax: 213,
      ftp: undefined,
      velocidadUmbral: 3.9,
    });
    expect(umbralesDeIntervals(AJUSTES, "Ride").ftp).toBe(250);
  });

  it("un deporte que no está en los ajustes no hereda los de otro", () => {
    expect(umbralesDeIntervals(AJUSTES, "Swim")).toEqual({});
  });

  it("Garmin gana a intervals, y la diferencia queda anotada", async () => {
    const { falso } = cliente([[/user-settings/, { cuerpo: { lactateThresholdHeartRate: 190 } }]]);
    const umbrales = await leerUmbrales(falso, "2026-09-16", { lthr: 193 });
    expect(umbrales.lthr).toEqual({
      valor: 190,
      fuente: "Garmin · ajustes del perfil",
      discrepa: 193,
    });
    expect(discrepantes(umbrales)).toEqual(["LTHR: Garmin 190, intervals 193"]);
  });

  it("si coinciden no hay nada que avisar", async () => {
    const { falso } = cliente([[/user-settings/, { cuerpo: { lactateThresholdHeartRate: 193 } }]]);
    const umbrales = await leerUmbrales(falso, "2026-09-16", { lthr: 193 });
    expect(umbrales.lthr?.discrepa).toBeUndefined();
    expect(discrepantes(umbrales)).toEqual([]);
  });

  it("sin dato en Garmin, intervals sirve de respaldo y se dice", async () => {
    const { falso } = cliente([[/user-settings/, { cuerpo: {} }]]);
    const umbrales = await leerUmbrales(falso, "2026-09-16", { lthr: 193 });
    expect(umbrales.lthr).toEqual({ valor: 193, fuente: "intervals.icu" });
    // Un respaldo no es una discrepancia: no hay con qué chocar.
    expect(discrepantes(umbrales)).toEqual([]);
  });

  it("sin dato en ninguna de las dos, no se inventa un umbral", async () => {
    const { falso } = cliente([[/user-settings/, { cuerpo: {} }]]);
    const umbrales = await leerUmbrales(falso, "2026-09-16", {});
    expect(umbrales.lthr).toBeUndefined();
  });

  it("el informe avisa del choque con un ⚠", async () => {
    const { falso } = cliente([[/user-settings/, { cuerpo: { lactateThresholdHeartRate: 190 } }]]);
    const texto = formatearUmbrales(await leerUmbrales(falso, "2026-09-16", { lthr: 193 }));
    expect(texto).toContain("190");
    expect(texto).toContain("⚠ intervals dice 193");
    expect(texto).toContain("no dicen lo mismo");
  });
});


describe("las zonas de FC que publica Garmin", () => {
  // No hay documentación de esta respuesta: se reconocen las claves donde
  // estén, y se exige que el conjunto tenga sentido. Unas zonas medio leídas se
  // enseñan igual de convincentes que unas buenas.
  const RESPUESTA = [
    {
      sport: "RUNNING",
      zone1Floor: 120,
      zone2Floor: 145,
      zone3Floor: 163,
      zone4Floor: 180,
      zone5Floor: 195,
      maxHeartRateUsed: 213,
    },
    { sport: "DEFAULT", zone1Floor: 110, zone2Floor: 140, zone3Floor: 160, zone4Floor: 175 },
  ];

  it("saca los suelos en orden, con el deporte y la FC máxima usada", () => {
    const zonas = zonasFcDeGarmin(RESPUESTA);
    expect(zonas).toHaveLength(2);
    expect(zonas[0]).toEqual({
      deporte: "RUNNING",
      suelos: [120, 145, 163, 180, 195],
      maxUsada: 213,
    });
  });

  it("descarta lo que no puede ser un juego de zonas", () => {
    // Menos de tres zonas: puede ser cualquier cosa con ese nombre.
    expect(zonasFcDeGarmin([{ zone1Floor: 120, zone2Floor: 145 }])).toEqual([]);
    // Sin la zona 1: faltan trozos, y enseñar Z1≥145 sería mentir.
    expect(zonasFcDeGarmin([{ zone2Floor: 145, zone3Floor: 163, zone4Floor: 180 }])).toEqual([]);
    // Fuera de orden: no son suelos de zonas.
    expect(zonasFcDeGarmin([{ zone1Floor: 180, zone2Floor: 145, zone3Floor: 163 }])).toEqual([]);
    // Fuera de rango: 12 ppm no es una pulsación por minuto.
    expect(zonasFcDeGarmin([{ zone1Floor: 12, zone2Floor: 14, zone3Floor: 16 }])).toEqual([]);
  });

  it("elige las del deporte pedido, y si no están dice de quién son", () => {
    const zonas = zonasFcDeGarmin(RESPUESTA);
    expect(elegirZonas(zonas, "running")?.suelos).toEqual([120, 145, 163, 180, 195]);
    // Ciclismo no está: caen las genéricas, pero etiquetadas como DEFAULT.
    expect(elegirZonas(zonas, "cycling")?.deporte).toBe("DEFAULT");
    expect(elegirZonas([], "running")).toBeUndefined();
  });

  it("el informe las enseña y no manda a intervals", async () => {
    const { falso } = cliente([
      [/user-settings/, { cuerpo: { lactateThresholdHeartRate: 190 } }],
      [/heartRateZones/, { cuerpo: RESPUESTA }],
    ]);
    const texto = formatearUmbrales(await leerUmbrales(falso, "2026-09-16", {}, "running"));
    expect(texto).toContain("Zonas de FC en Garmin (RUNNING)");
    expect(texto).toContain("Z1 ≥120 · Z2 ≥145 · Z3 ≥163 · Z4 ≥180 · Z5 ≥195");
    expect(texto).not.toContain("get_athlete_settings");
    expect(texto).not.toMatch(/muy pocas pulsaciones/);
  });

  it("avisa de una zona de dos pulsaciones", async () => {
    const estrecha = JSON.parse(JSON.stringify(RESPUESTA));
    const { falso } = cliente([
      [/user-settings/, { cuerpo: { lactateThresholdHeartRate: 189 } }],
      [/heartRateZones/, { cuerpo: estrecha }],
    ]);
    const u = await leerUmbrales(falso, "2026-09-16", {}, "running");
    u.zonas = { deporte: "DEFAULT", suelos: [134, 153, 172, 189, 191], maxUsada: 210 };
    expect(formatearUmbrales(u)).toMatch(/Z4 de 2 ppm/);
  });

  it("la FC máxima de las zonas es de Garmin, no del respaldo", async () => {
    // Salió en producción: el informe decía «FC máxima 213 · intervals.icu» y
    // dos líneas más abajo «calculadas sobre 213 ppm» con el dato de Garmin
    // delante. El perfil no trae maxHeartRate; la respuesta de zonas sí.
    const { falso } = cliente([[/heartRateZones/, { cuerpo: RESPUESTA }]]);
    const umbrales = await leerUmbrales(falso, "2026-09-16", { fcMax: 213 }, "running");
    expect(umbrales.fcMax).toEqual({ valor: 213, fuente: "Garmin · zonas de FC" });
  });

  it("si Garmin no publica zonas no se enseña nada, y el diagnóstico dice qué llegó", async () => {
    const { falso } = cliente([[/heartRateZones/, { cuerpo: { otraCosa: 1 } }]]);
    const umbrales = await leerUmbrales(falso, "2026-09-16", {}, "running");
    expect(umbrales.zonas).toBeUndefined();
    expect(formatearUmbrales(umbrales)).not.toContain("Zonas de FC en Garmin");
    expect(formatearUmbrales(umbrales, true)).toContain("otraCosa");
  });
});
