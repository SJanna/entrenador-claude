/**
 * La página pública sale del histórico de Garmin, sin intervals.icu: del D1 de
 * la app (con GAP y clima, migración 0011) y lo de los últimos días en vivo.
 */

import { describe, expect, it } from "vitest";
import { climaDe, normalizarActividad } from "../src/garmin/actividades.ts";
import { sincronizarHistorico } from "../src/historico/sincronizar.ts";
import { HistoricoStore } from "../src/historico/store.ts";
import { PublicoStore } from "../src/publico/store.ts";
import { actividadDeFila, calcularPublico, mezclarActividades } from "../src/publico/servicio.ts";
import { d1EnMemoria } from "./apoyo-d1.mjs";

const HOY = "2026-12-10";

function bruta(id, fecha, typeKey = "running", extra = {}) {
  return {
    activityId: id, activityName: `Act ${id}`, startTimeLocal: `${fecha} 05:30:00`,
    activityType: { typeKey }, duration: 3700, movingDuration: 3600, distance: 10000,
    averageHR: 142, maxHR: 165, elevationGain: 40, activityTrainingLoad: 80, ...extra,
  };
}

const json = (cuerpo) => new Response(JSON.stringify(cuerpo), { status: 200 });

/** Garmin de mentira: listado, clima y nada más (lo demás, 204). */
function garmin({ listado = [], clima = {}, recientes = null } = {}) {
  const llamadas = [];
  return {
    llamadas,
    atleta: async () => "atleta-1",
    api: async (ruta) => {
      llamadas.push(ruta);
      if (ruta.includes("activitylist-service")) {
        const inicio = Number(new URL(ruta, "https://x").searchParams.get("start"));
        if (inicio > 0) return json([]);
        return json(ruta.includes("startDate") && recientes ? recientes : listado);
      }
      const m = ruta.match(/activity-service\/activity\/(\d+)\/weather/);
      if (m) return clima[m[1]] === undefined ? new Response(null, { status: 404 }) : json({ temp: clima[m[1]] });
      return new Response(null, { status: 204 });
    },
  };
}

describe("datos de Garmin para la página", () => {
  it("el clima llega en °F y se guarda en °C; lo imposible no se guarda", () => {
    expect(climaDe({ temp: 86 })).toBe(30);
    expect(climaDe({ temp: 84.2 })).toBe(29);
    expect(climaDe({ temp: 300 })).toBeNull();
    expect(climaDe({})).toBeNull();
    expect(climaDe(null)).toBeNull();
  });

  it("el GAP sale de avgGradeAdjustedSpeed, y si no viene es null", () => {
    expect(normalizarActividad(bruta(1, HOY, "running", { avgGradeAdjustedSpeed: 2.9 })).gapMs).toBe(2.9);
    expect(normalizarActividad(bruta(1, HOY)).gapMs).toBeNull();
    expect(normalizarActividad(bruta(1, HOY, "running", { avgGradeAdjustedSpeed: 0 })).gapMs).toBeNull();
  });

  it("una fila del histórico entra con su tipo de Garmin, tiempo en movimiento, GAP y clima", () => {
    const a = actividadDeFila({
      id: 1, fecha: HOY, deporte: "trail_running", nombre: "Tubará", segundos: 3700, segundos_mov: 3600,
      distancia_m: 16010, desnivel_m: 300, fc_media: 140, fc_max: 160, carga: 100, gap_ms: 2.5, temp_clima: 29.4,
      inicio: null, efecto_aerobico: null, detalle_estado: "hecho", detalle_error: null,
    });
    expect(a).toEqual({
      fecha: HOY, tipo: "trail_running", km: 16.01, categoria: "carrera", segundos: 3600,
      fcMedia: 140, fcMax: 160, temp: 29.4, gap: 2.5,
    });
    // Una caminata guardada como carrera no es sesión (pero sus km son de carrera, como siempre).
    expect(actividadDeFila({ ...a, id: 2, deporte: "running", nombre: "Caminata", distancia_m: 3000, segundos: 1800 }).categoria).toBeNull();
  });

  it("lo vivo manda en el resumen; GAP y clima guardados no se pierden", () => {
    const guardada = {
      id: 7, fecha: "2026-12-08", deporte: "running", nombre: "Viejo", segundos: 3000, segundos_mov: 2900,
      distancia_m: 8000, desnivel_m: 10, fc_media: 140, fc_max: 160, carga: 50, gap_ms: 2.7, temp_clima: 28,
      inicio: null, efecto_aerobico: null, detalle_estado: "hecho", detalle_error: null,
    };
    const viva = normalizarActividad(bruta(7, "2026-12-08", "running", { activityName: "Editado", distance: 8500 }));
    const nueva = normalizarActividad(bruta(8, "2026-12-09", "running", { avgGradeAdjustedSpeed: 3 }));
    const [a, b] = mezclarActividades([guardada], [viva, nueva]);
    expect(a).toMatchObject({ id: 7, nombre: "Editado", distancia_m: 8500, gap_ms: 2.7, temp_clima: 28 });
    expect(b).toMatchObject({ id: 8, gap_ms: 3, temp_clima: null });
  });
});

describe("histórico con GAP y clima (migración 0011)", () => {
  it("guarda el GAP, no lo borra si luego no viene, y pide clima solo de carrera al aire libre", async () => {
    const db = d1EnMemoria();
    const store = new HistoricoStore(db);
    const conGap = normalizarActividad(bruta(1, "2026-12-08", "running", { avgGradeAdjustedSpeed: 2.8 }));
    await store.guardarActividades(
      [conGap, normalizarActividad(bruta(2, "2026-12-08", "treadmill_running")), normalizarActividad(bruta(3, "2026-12-09", "strength_training"))],
      () => false,
    );
    await store.guardarActividades([normalizarActividad(bruta(1, "2026-12-08", "running"))], () => false);
    const [f1] = await store.actividades({ desde: "2026-12-08", hasta: "2026-12-08" });
    expect(f1.gap_ms).toBe(2.8);
    expect(await store.pendientesDeClima(10)).toEqual([{ id: 1 }]);
    await store.guardarClima(1, 29.5);
    expect(await store.pendientesDeClima(10)).toEqual([]);
  });

  it("la sincronización pide el clima de las carreras y lo guarda en °C", async () => {
    const db = d1EnMemoria();
    const store = new HistoricoStore(db);
    const g = garmin({
      listado: [bruta(11, "2026-12-09", "running", { avgGradeAdjustedSpeed: 2.8 }), bruta(12, "2026-12-08")],
      clima: { 11: 86 },
    });
    const r = await sincronizarHistorico(g, store, HOY, { presupuesto: 30, diasObjetivo: 3 });
    expect(r.climas).toBe(2);
    const filas = await store.actividades();
    expect(filas.find((f) => f.id === 11)).toMatchObject({ temp_clima: 30, clima_estado: "hecho", gap_ms: 2.8 });
    // Sin clima en Garmin (404): queda «sin_datos» y no se vuelve a pedir.
    expect(filas.find((f) => f.id === 12)).toMatchObject({ temp_clima: null, clima_estado: "sin_datos" });
  });

  it("sin la migración 0011 el histórico sigue guardando, sin GAP ni clima", async () => {
    const db = d1EnMemoria({ salta: ["0011", "0012"] });
    const store = new HistoricoStore(db);
    expect(await store.conGapYClima()).toBe(false);
    await store.guardarActividades([normalizarActividad(bruta(1, "2026-12-08", "running", { avgGradeAdjustedSpeed: 2.8 }))], () => false);
    expect((await store.actividades()).length).toBe(1);
    expect(await store.pendientesDeClima(5)).toEqual([]);
  });
});

describe("la página pública sin intervals.icu", () => {
  const TEMPORADAS = [
    { numero: 0, nombre: "Prólogo", desde: "2026-10-05", hasta: "2026-11-30" },
    { numero: 1, nombre: "Base", desde: "2026-12-01", hasta: "2027-03-15" },
    { numero: 2, nombre: "Durabilidad", desde: "2027-03-16", hasta: "2027-07-15" },
    { numero: 3, nombre: "Específica", desde: "2027-07-16", hasta: "2027-10-24" },
    { numero: 4, nombre: "Día D", desde: "2027-10-25", hasta: "2027-11-14" },
  ];

  async function entorno({ actividades = [], recientes = null } = {}) {
    const db = d1EnMemoria();
    const historico = new HistoricoStore(db);
    if (actividades.length) await historico.guardarActividades(actividades.map(normalizarActividad), () => false);
    await new PublicoStore(db).aplicar({ temporadas: TEMPORADAS, diaD: "2027-11-14" }, "2026-11-10T00:00:00.000Z");
    const kv = new Map();
    const env = { DB: db, SESSION_SECRET: "x", PUBLICO: { put: async (k, v) => kv.set(k, v) } };
    // Sin intervals: la configuración ni lo tiene.
    const config = { intervals: false, today: () => HOY };
    return { env, config, kv, g: garmin({ listado: [], recientes }) };
  }

  it("calcula y publica desde el histórico de Garmin, con lo de ayer en vivo", async () => {
    const { env, config, kv, g } = await entorno({
      actividades: [
        bruta(1, "2026-01-31", "running", { distance: 31060 }), // la marca de antes de la T1
        bruta(2, "2026-11-29", "trail_running", { distance: 25500 }), // Prólogo: no suma
        bruta(3, "2026-12-06", "running", { distance: 12000, avgGradeAdjustedSpeed: 2.8 }),
      ],
      recientes: [bruta(4, "2026-12-09", "running", { distance: 8000, activityName: "Rodaje" })],
    });
    const r = await calcularPublico(env, config, { publicar: true, garmin: g });
    expect(r.errores).toEqual([]);
    expect(r.publicado).toBe(true);
    expect(r.publico.referencia).toEqual({ km: 31.1, fecha: "2026-01-31" });
    expect(r.publico.tirada_larga).toEqual({ km: 12, fecha: "2026-12-06" });
    expect(r.publico.totales).toMatchObject({ km: 20, sesiones: 2, desde: "2026-12-01" });
    expect(r.publico.ayer.sesiones).toEqual([
      { deporte: "carrera", km: 8, segundos: 3600, ritmo: 450, fc_media: 142, fc_max: 165, temp: null },
    ]);
    expect(r.diagnostico.carreras[0]).toMatchObject({ fecha: "2026-12-09", km: 8, gap: null });
    expect(r.avisos.some((a) => /sin GAP de Garmin/.test(a))).toBe(true);
    expect(JSON.parse(kv.get("progreso.json")).hitos).toHaveLength(9);
    // Ni una llamada a intervals: solo Garmin.
    expect(g.llamadas.every((ruta) => !/intervals/.test(ruta))).toBe(true);
  });

  it("con el histórico vacío no se publica nada", async () => {
    const { env, config, kv, g } = await entorno();
    await expect(calcularPublico(env, config, { publicar: true, garmin: g })).rejects.toThrow(/histórico de Garmin está vacío/);
    expect(kv.size).toBe(0);
  });
});
