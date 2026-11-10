/**
 * Datos del panel «zancada» sobre un D1 de SQLite real y un calendario de
 * mentira: lo que pinta el panel es lo mismo que lee el entrenador.
 */

import { describe, expect, it } from "vitest";
import { sincronizarHistorico } from "../src/historico/sincronizar.ts";
import { HistoricoStore } from "../src/historico/store.ts";
import { datosHoy, datosProgreso, datosRachas, datosSemana } from "../src/web/panelDatos.ts";
import { d1EnMemoria } from "./apoyo-d1.mjs";

const HOY = "2026-11-09"; // lunes

function actividad(id, fecha, deporte = "running", carga = 80, distancia = 10000) {
  return {
    activityId: id, activityName: `Act ${id}`, startTimeLocal: `${fecha} 05:30:00`,
    activityType: { typeKey: deporte }, duration: 3600, movingDuration: 3500, distance: distancia,
    averageHR: 145, maxHR: 170, elevationGain: 40, activityTrainingLoad: carga,
  };
}

function garminFalso() {
  const json = (c) => new Response(JSON.stringify(c), { status: 200 });
  const lista = [
    actividad(5, "2026-11-09", "running", 90, 8000),
    actividad(4, "2026-11-08", "running", 150, 16000),
    actividad(3, "2026-11-06", "lap_swimming", 40, 1500),
    actividad(2, "2026-11-04", "strength_training", 30, 0),
  ];
  return {
    atleta: async () => "atleta-1",
    api: async (ruta) => {
      if (ruta.includes("activitylist-service")) return json(lista);
      if (ruta.includes("/details")) return new Response(null, { status: 204 });
      if (ruta.includes("usersummary")) return json({ restingHeartRate: 51, bodyBatteryHighestValue: 88 });
      if (ruta.includes("dailySleepData")) return json({ dailySleepDTO: { sleepTimeSeconds: 26000, sleepScores: { overall: { value: 81 } } } });
      if (ruta.includes("hrv-service")) return json({ hrvSummary: { lastNightAvg: 41, status: "BALANCED" } });
      if (ruta.includes("trainingreadiness")) return json([{ score: 72, level: "HIGH" }]);
      return new Response(null, { status: 204 });
    },
  };
}

function calendario(items, falla = false) {
  return async () => {
    if (falla) throw new Error("Garmin sin enlazar");
    return { items, fallos: [], recortado: false, claves: {} };
  };
}

const PLAN = [
  { fecha: "2026-11-09", tipo: "workout", titulo: "Rodaje 60'", workoutId: 1, scheduleId: 11, activityId: null, deporte: "running", duracionSegundos: 3600, completado: false },
  { fecha: "2026-11-10", tipo: "workout", titulo: "Fuerza (casa)", workoutId: 2, scheduleId: 12, activityId: null, deporte: "strength_training", duracionSegundos: 2700, completado: false },
  { fecha: "2026-11-09", tipo: "activity", titulo: "Act 5", workoutId: null, scheduleId: null, activityId: 5, deporte: "running", duracionSegundos: 3600, completado: true },
];

async function preparar() {
  const db = d1EnMemoria();
  const store = new HistoricoStore(db);
  await sincronizarHistorico(garminFalso(), store, HOY, { presupuesto: 25 });
  return store;
}

describe("panel · datos de Garmin", () => {
  it("Hoy: bienestar del día, agenda pendiente, semana en curso y carga", async () => {
    const store = await preparar();
    const d = await datosHoy({ store, hoy: HOY, calendario: calendario(PLAN) });
    expect(d.bienestar?.fecha).toBe(HOY);
    expect(d.bienestar?.fc_reposo).toBe(51);
    expect(d.hechas.map((a) => a.id)).toEqual([5]);
    // Las actividades hechas no vuelven como «programadas».
    expect(d.agenda.map((p) => p.titulo)).toEqual(["Rodaje 60'", "Fuerza (casa)"]);
    expect(d.agendaError).toBeNull();
    // Semana del lunes 9: solo la carrera de hoy.
    expect(d.semana.lunes).toBe(HOY);
    expect(d.semana.kmCarrera).toBeCloseTo(8, 5);
    expect(d.carga?.ctl).toBeGreaterThan(0);
    expect(d.carga?.fiable).toBe(false);
  });

  it("Hoy: si D1 tiene el día a medias, lo lee en vivo y lo guarda", async () => {
    const db = d1EnMemoria();
    const store = new HistoricoStore(db);
    // La lectura de la mañana: FC sí, sueño y VFC todavía no (el reloj no había sincronizado).
    await store.guardarDia({ fecha: HOY, fallos: [], fcReposo: 54, hrvNoche: null, sueñoSegundos: null, sueñoPuntuacion: null, readiness: 58, cargaAguda: null, cargaCronica: null });
    let llamadas = 0;
    const vivo = async (fecha) => {
      llamadas++;
      return { fecha, fallos: [], fcReposo: 51, hrvNoche: 42, sueñoSegundos: 33060, sueñoPuntuacion: 92, readiness: 58, readinessNivel: "MODERATE", cargaAguda: 384, cargaCronica: 495 };
    };
    const d = await datosHoy({ store, hoy: HOY, calendario: calendario([]), bienestarEnVivo: vivo });
    expect(llamadas).toBe(1);
    expect(d.bienestar?.hrv).toBe(42);
    expect(d.bienestar?.sueno_seg).toBe(33060);
    // Y queda guardado: la siguiente apertura ya no llama a Garmin.
    const fila = (await store.bienestar(HOY, HOY))[0];
    expect(fila.hrv_noche).toBe(42);
    await datosHoy({ store, hoy: HOY, calendario: calendario([]), bienestarEnVivo: vivo });
    expect(llamadas).toBe(1);
  });

  it("Hoy: si Garmin en vivo falla, enseña lo que hay en D1", async () => {
    const store = new HistoricoStore(d1EnMemoria());
    await store.guardarDia({ fecha: HOY, fallos: [], fcReposo: 54, hrvNoche: null, sueñoSegundos: null, sueñoPuntuacion: null, readiness: 58, cargaAguda: null, cargaCronica: null });
    const d = await datosHoy({ store, hoy: HOY, calendario: calendario([]), bienestarEnVivo: async () => { throw new Error("429"); } });
    expect(d.bienestar?.fc_reposo).toBe(54);
    expect(d.bienestar?.hrv).toBeNull();
  });

  it("Hoy: si el calendario falla, lo dice en vez de enseñar una agenda vacía", async () => {
    const store = await preparar();
    const d = await datosHoy({ store, hoy: HOY, calendario: calendario([], true) });
    expect(d.agenda).toEqual([]);
    expect(d.agendaError).toMatch(/sin enlazar/);
  });

  it("Semana: siete días, con lo hecho y lo que queda por hacer", async () => {
    const store = await preparar();
    const d = await datosSemana({ store, hoy: HOY, calendario: calendario(PLAN) }, "2026-11-05");
    expect(d.lunes).toBe("2026-11-02");
    expect(d.dias).toHaveLength(7);
    expect(d.kmCarrera).toBeCloseTo(16, 5);
    const domingo = d.dias[6];
    expect(domingo.fecha).toBe("2026-11-08");
    expect(domingo.hechas[0].distancia_m).toBe(16000);
    expect(d.dias[2].hechas[0].deporte).toBe("strength_training");
    expect(d.diasActivos).toBe(3);
  });

  it("Progreso: una fila de carga por día, semanas y bandas", async () => {
    const store = await preparar();
    const d = await datosProgreso({ store, hoy: HOY, calendario: calendario([]) }, 28);
    expect(d.carga).toHaveLength(28);
    expect(d.carga[27].fecha).toBe(HOY);
    expect(d.semanas.at(-1).lunes).toBe(HOY);
    expect(d.ultimo.fc_reposo).toBe(51);
  });

  it("Rachas: mismas reglas que garmin_streaks y avisa si no leyó el calendario", async () => {
    const store = await preparar();
    const ok = await datosRachas({ store, hoy: HOY, calendario: calendario(PLAN) }, 30);
    expect(ok.calendarioLeido).toBe(true);
    expect(ok.rachas.dias).toHaveLength(30);
    const sin = await datosRachas({ store, hoy: HOY, calendario: calendario([], true) }, 30);
    expect(sin.calendarioLeido).toBe(false);
  });
});
