/**
 * Sincronización del histórico contra un Garmin de mentira y un D1 de SQLite
 * real: presupuesto, orden, reanudación y parada ante un 429.
 */

import { describe, expect, it } from "vitest";
import { sincronizarHistorico } from "../src/historico/sincronizar.ts";
import { HistoricoStore } from "../src/historico/store.ts";
import { HistoricoTools } from "../src/tools/historicoTools.ts";
import { GarminError } from "../src/garmin/cliente.ts";
import { d1EnMemoria } from "./apoyo-d1.mjs";

const HOY = "2026-11-07";

function actividad(id, fecha, deporte = "running", carga = 80) {
  return {
    activityId: id, activityName: `Act ${id}`, startTimeLocal: `${fecha} 05:30:00`,
    activityType: { typeKey: deporte }, duration: 3600, movingDuration: 3500, distance: 10000,
    averageHR: 145, maxHR: 170, elevationGain: 40, activityTrainingLoad: carga,
  };
}

function detalle() {
  const filas = [];
  for (let t = 0; t <= 3600; t += 10) filas.push({ metrics: [t, (t * 10) / 3.6, 2.78, 140 + t / 360] });
  return {
    metricDescriptors: [
      { metricsIndex: 0, key: "sumDuration" }, { metricsIndex: 1, key: "sumDistance" },
      { metricsIndex: 2, key: "directSpeed" }, { metricsIndex: 3, key: "directHeartRate" },
    ],
    activityDetailMetrics: filas,
  };
}

function garminFalso({ limitarTras = Infinity, detalleFalla = 0, vacio = false } = {}) {
  let fallosDetalle = detalleFalla;
  const llamadas = [];
  const json = (cuerpo) => new Response(JSON.stringify(cuerpo), { status: 200 });
  return {
    llamadas,
    cliente: {
      atleta: async () => "atleta-1",
      api: async (ruta) => {
        llamadas.push(ruta);
        if (llamadas.length > limitarTras) throw new GarminError("limitado", "429 de prueba");
        if (ruta.includes("activitylist-service")) {
          if (ruta.includes("startDate")) return json([actividad(3, "2026-11-06"), actividad(4, "2026-11-07", "strength_training", 30)]);
          return json([actividad(4, "2026-11-07", "strength_training", 30), actividad(3, "2026-11-06"), actividad(2, "2026-10-01"), actividad(1, "2026-09-01", "walking", 20)]);
        }
        if (ruta.includes("/details")) {
          if (fallosDetalle-- > 0) return new Response("caído", { status: 503 });
          return json(detalle());
        }
        if (ruta.includes("usersummary")) return json(vacio ? {} : { restingHeartRate: 52, totalSteps: 9000 });
        if (ruta.includes("dailySleepData")) return json(vacio ? {} : { dailySleepDTO: { sleepTimeSeconds: 25200 } });
        if (ruta.includes("hrv-service")) return json({ hrvSummary: { lastNightAvg: 42 } });
        if (ruta.includes("weight-service")) return json({ dateWeightList: [{ calendarDate: "2026-11-05", weight: 68100 }] });
        return new Response(null, { status: 204 });
      },
    },
  };
}

describe("sincronización del histórico", () => {
  it("respeta el presupuesto, empieza por lo reciente y deja cursores para seguir", async () => {
    const db = d1EnMemoria();
    const store = new HistoricoStore(db);
    const g = garminFalso();
    const r = await sincronizarHistorico(g.cliente, store, HOY, { presupuesto: 20, diasObjetivo: 10 });
    expect(r.llamadas).toBeLessThanOrEqual(20);
    expect(g.llamadas[0]).toContain("startDate=2026-10-24");
    expect(r.actividadesNuevas).toBe(4);
    const cob = await store.cobertura();
    expect(cob.cargaInicialCompleta).toBe(true);
    expect(cob.actividades).toBe(4);
    // Lo que no cupo queda pendiente para la siguiente pasada, no perdido.
    expect(cob.detallesPendientes).toBeGreaterThan(0);
  });

  it("varias pasadas completan detalle, bienestar y peso, y la siguiente no repite", async () => {
    const db = d1EnMemoria();
    const store = new HistoricoStore(db);
    const g = garminFalso();
    for (let i = 0; i < 6; i++) await sincronizarHistorico(g.cliente, store, HOY, { presupuesto: 40, diasObjetivo: 10, ahora: () => Date.parse("2026-11-07T10:00:00Z") });
    const cob = await store.cobertura();
    expect(cob.detallesPendientes).toBe(0);
    expect(cob.diasBienestar).toBe(10);
    const filas = await store.actividades();
    const corrida = filas.find((a) => a.id === 3);
    expect(corrida.detalle_estado).toBe("hecho");
    expect(corrida.desacople_pct).toBeGreaterThan(3);
    expect(corrida.mejores["5000"]).toBeGreaterThan(1700);
    expect(filas.find((a) => a.id === 4).detalle_estado).toBe("no_aplica"); // fuerza: sin series
    const antes = g.llamadas.length;
    const r = await sincronizarHistorico(g.cliente, store, HOY, { presupuesto: 40, diasObjetivo: 10, ahora: () => Date.parse("2026-11-07T10:30:00Z") });
    expect(r.llamadas).toBe(1); // solo la lista reciente: nada más que hacer
    expect(g.llamadas.length - antes).toBe(1);
    const pesos = (await store.bienestar("2026-11-01", HOY)).filter((f) => f.peso_kg);
    expect(pesos[0].peso_kg).toBe(68.1);
  });

  it("un 5xx en las series se reintenta en otra pasada, no se da por perdido", async () => {
    const db = d1EnMemoria();
    const store = new HistoricoStore(db);
    const g = garminFalso({ detalleFalla: 1 });
    for (let i = 0; i < 4; i++) await sincronizarHistorico(g.cliente, store, HOY, { presupuesto: 40, diasObjetivo: 3 });
    const filas = await store.actividades();
    expect(filas.filter((a) => a.detalle_estado === "error")).toHaveLength(0);
    expect(filas.filter((a) => a.detalle_estado === "hecho")).toHaveLength(3);
  });

  it("un día leído vacío (reloj sin sincronizar) se vuelve a pedir", async () => {
    const db = d1EnMemoria();
    const store = new HistoricoStore(db);
    const t0 = Date.parse("2026-11-07T10:00:00Z");
    await sincronizarHistorico(garminFalso({ vacio: true }).cliente, store, HOY, { presupuesto: 40, diasObjetivo: 5, ahora: () => t0 });
    expect((await store.diasVacios("2026-11-01", "2026-11-05")).size).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      await sincronizarHistorico(garminFalso().cliente, store, HOY, { presupuesto: 40, diasObjetivo: 5, ahora: () => Date.now() + 13 * 3600_000 });
    }
    expect((await store.diasVacios("2026-11-01", "2026-11-05")).size).toBe(0);
  });

  it("hoy sin sueño o sin VFC se relee cada hora, no cada tres", async () => {
    const store = new HistoricoStore(d1EnMemoria());
    await sincronizarHistorico(garminFalso({ vacio: true }).cliente, store, HOY, { presupuesto: 40, diasObjetivo: 5, ahora: () => Date.now() });
    expect((await store.bienestar(HOY, HOY))[0].sueno_seg).toBeNull();
    // A los 30 min todavía no: no se gastan llamadas en bucle.
    await sincronizarHistorico(garminFalso().cliente, store, HOY, { presupuesto: 40, diasObjetivo: 5, ahora: () => Date.now() + 30 * 60_000 });
    expect((await store.bienestar(HOY, HOY))[0].sueno_seg).toBeNull();
    // A la hora siguiente, sí: el reloj ya sincronizó la noche.
    await sincronizarHistorico(garminFalso().cliente, store, HOY, { presupuesto: 40, diasObjetivo: 5, ahora: () => Date.now() + 61 * 60_000 });
    expect((await store.bienestar(HOY, HOY))[0].sueno_seg).toBe(25200);
  });

  it("con series pendientes, el bienestar hacia atrás avanza igual en cada pasada", async () => {
    const db = d1EnMemoria();
    const store = new HistoricoStore(db);
    const g = garminFalso();
    const t = () => Date.parse("2026-11-07T10:00:00Z");
    // 25 de presupuesto: lista (1) + hoy y ayer (12) + carga inicial (1) deja 11.
    await sincronizarHistorico(g.cliente, store, HOY, { presupuesto: 25, diasObjetivo: 30, ahora: t });
    const r = await sincronizarHistorico(g.cliente, store, HOY, { presupuesto: 25, diasObjetivo: 30, ahora: t });
    expect(r.dias).toBeGreaterThanOrEqual(1);
  });

  it("ante un 429 para en seco y lo dice", async () => {
    const db = d1EnMemoria();
    const store = new HistoricoStore(db);
    const g = garminFalso({ limitarTras: 1 });
    const r = await sincronizarHistorico(g.cliente, store, HOY, { presupuesto: 40, diasObjetivo: 10 });
    expect(r.parado).toMatch(/429/);
    // La lista reciente y las seis lecturas del día, que van en paralelo; ni una más.
    expect(g.llamadas.length).toBe(7);
  });

  it("las herramientas empiezan por la cobertura y avisan si está incompleta", async () => {
    const db = d1EnMemoria();
    const store = new HistoricoStore(db);
    const g = garminFalso();
    await sincronizarHistorico(g.cliente, store, HOY, { presupuesto: 12, diasObjetivo: 10 });
    const t = new HistoricoTools(store, g.cliente, () => HOY);
    const semanal = await t.semanal({ weeks: 4 });
    expect(semanal).toMatch(/^Histórico de Garmin: 4 actividades/);
    expect(semanal).toMatch(/HISTÓRICO INCOMPLETO/);
    expect(semanal).toMatch(/escala es la de la carga de Garmin/);
    const buscar = await t.buscar({ sport: "correr" });
    expect(buscar).toMatch(/2 actividades/);
  });

  it("rachas sobre el histórico: lo hecho cuenta y sin calendario lo avisa", async () => {
    const db = d1EnMemoria();
    const store = new HistoricoStore(db);
    const g = garminFalso();
    await sincronizarHistorico(g.cliente, store, HOY, { presupuesto: 40, diasObjetivo: 10 });
    const t = new HistoricoTools(store, g.cliente, () => HOY);
    const r = await t.rachas({ days: 30 }, async () => {
      throw new Error("sin calendario");
    });
    expect(r).toMatch(/^Histórico de Garmin/);
    expect(r).toMatch(/calendario de Garmin no se pudo leer/);
  });

  it("sin la migración 0010 lo dice en vez de romper", async () => {
    const db = d1EnMemoria({ salta: ["0010"] });
    const t = new HistoricoTools(new HistoricoStore(db), garminFalso().cliente, () => HOY);
    expect(await t.semanal({})).toMatch(/falta la migración 0010/);
  });
});
