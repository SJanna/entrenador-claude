/**
 * La página pública contra una D1 de verdad (SQLite en memoria con todas las
 * migraciones): set_plan_publico y la lectura del cumplimiento desde Garmin.
 */

import { describe, expect, it } from "vitest";
import { d1EnMemoria } from "./apoyo-d1.mjs";
import { PublicoStore } from "../src/publico/store";
import { PublicoTools } from "../src/tools/publicoTools";
import { actualizarCumplimiento } from "../src/publico/servicio";

const AHORA = "2026-12-20T08:00:00.000Z";

function herramienta(hoy = "2026-12-20") {
  const db = d1EnMemoria();
  const store = new PublicoStore(db);
  return { db, store, tools: new PublicoTools(store, () => hoy) };
}

describe("set_plan_publico", () => {
  it("sin argumentos enseña temporadas y día D de la migración", async () => {
    const { tools } = herramienta();
    const texto = await tools.setPlanPublico({}, AHORA);
    expect(texto).toMatch(/Día D: 2027-08-21 \(sábado\)/);
    expect(texto).toMatch(/T1 Base\s+2026-12-14 → 2027-02-28/);
    expect(texto).toMatch(/T1 Base .*← ahora/);
  });

  it("escribe la semana que viene y rechaza la empezada", async () => {
    const { tools, store } = herramienta("2026-12-20"); // domingo
    expect(await tools.setPlanPublico({ semanas: [{ lunes: "2026-12-21", km: 32.04 }] }, AHORA)).toMatch(
      /semana 2026-12-21: 32 km planificados/,
    );
    const lunes = new PublicoTools(store, () => "2026-12-22");
    const texto = await lunes.setPlanPublico({ semanas: [{ lunes: "2026-12-21", km: 20 }] }, AHORA);
    expect(texto).toMatch(/congelada desde su lunes/);
    expect(await store.plan()).toEqual([{ lunes: "2026-12-21", km: 32 }]);
  });

  it("un día que no es lunes se rechaza diciendo cuál es", async () => {
    const { tools } = herramienta();
    expect(await tools.setPlanPublico({ semanas: [{ lunes: "2026-12-23", km: 30 }] }, AHORA)).toMatch(
      /es miércoles; el lunes de esa semana es 2026-12-21/,
    );
  });

  it("todo o nada: un cambio malo no deja escribir los buenos", async () => {
    const { tools, store } = herramienta();
    const texto = await tools.setPlanPublico(
      {
        semanas: [
          { lunes: "2026-12-28", km: 35 },
          { lunes: "2026-12-14", km: 10 },
        ],
      },
      AHORA,
    );
    expect(texto).toMatch(/No se ha escrito nada/);
    expect(await store.plan()).toEqual([]);
  });

  it("mover el día D arrastra el final de la T4, y solo a fin de semana", async () => {
    const { tools, store } = herramienta();
    expect(await tools.setPlanPublico({ dia_d: "2027-08-27" }, AHORA)).toMatch(/sábado o domingo/);
    await tools.setPlanPublico({ dia_d: "2027-08-28" }, AHORA);
    const cfg = await store.config();
    expect(cfg.diaD).toBe("2027-08-28");
    expect(cfg.temporadas.find((t) => t.numero === 4).hasta).toBe("2027-08-28");
  });

  it("mover una temporada obliga a mover la contigua", async () => {
    const { tools, store } = herramienta();
    expect(await tools.setPlanPublico({ temporadas: [{ numero: 1, hasta: "2027-03-07" }] }, AHORA)).toMatch(
      /T2 tiene que empezar el día después de que acabe T1 \(2027-03-08\)/,
    );
    await tools.setPlanPublico(
      { temporadas: [{ numero: 1, hasta: "2027-03-07" }, { numero: 2, desde: "2027-03-08" }] },
      AHORA,
    );
    const cfg = await store.config();
    expect(cfg.temporadas.find((t) => t.numero === 2).desde).toBe("2027-03-08");
  });

  it("los hitos manuales se marcan, no se adelantan y se quitan con null", async () => {
    const { tools, store } = herramienta();
    expect(await tools.setPlanPublico({ hitos: [{ clave: "noche", fecha: "2026-12-30" }] }, AHORA)).toMatch(
      /es futuro/,
    );
    await tools.setPlanPublico({ hitos: [{ clave: "noche", fecha: "2026-12-19" }] }, AHORA);
    expect(await store.hitosManuales()).toEqual([{ clave: "noche", fecha: "2026-12-19" }]);
    await tools.setPlanPublico({ hitos: [{ clave: "noche", fecha: null }] }, AHORA);
    expect(await store.hitosManuales()).toEqual([]);
  });
});

/** Garmin de mentira: calendario por mes, biblioteca de entrenos y actividades. */
function garmin({ calendario, entrenos, actividades }) {
  return {
    async api(ruta) {
      const json = (cuerpo) => new Response(JSON.stringify(cuerpo), { status: 200 });
      const mes = ruta.match(/\/calendar-service\/year\/(\d+)\/month\/(\d+)/);
      if (mes) return json({ calendarItems: calendario[`${mes[1]}-${Number(mes[2]) + 1}`] ?? [] });
      if (ruta.startsWith("/workout-service/workouts")) return json(entrenos);
      if (ruta.startsWith("/activitylist-service/")) {
        const inicio = Number(new URL(ruta, "https://x").searchParams.get("start"));
        return json(inicio === 0 ? actividades : []);
      }
      return new Response("", { status: 404 });
    },
  };
}

const ENTRENOS = [
  { workoutId: 1, estimatedDurationInSecs: 3000, workoutName: "Rodaje 40 min", sportType: { sportTypeKey: "running" } },
  { workoutId: 2, estimatedDurationInSecs: 1200, workoutName: "Terapia tobillo", sportType: { sportTypeKey: "strength_training" } },
  { workoutId: 3, estimatedDurationInSecs: 1800, workoutName: "Fuerza piernas", sportType: { sportTypeKey: "strength_training" } },
];

const cita = (date, id, workoutId, title, sportTypeKey) => ({
  date, itemType: "workout", id, workoutId, title, sportTypeKey,
});
const hecha = (fecha, typeKey, minutos, nombre, id) => ({
  activityId: id, activityName: nombre, startTimeLocal: `${fecha} 06:00:00`,
  activityType: { typeKey }, duration: minutos * 60,
});

describe("cumplimiento desde Garmin", () => {
  const cfg = (cumplimientoHasta = null) => ({
    diaD: "2027-08-21",
    cumplimientoHasta,
    temporadas: [{ numero: 0, nombre: "Prólogo", desde: "2026-11-03", hasta: "2026-12-13" }],
  });

  it("guarda solo lo que cuenta, empareja y congela ya el plan de hoy", async () => {
    const { store, db } = herramienta();
    const cliente = garmin({
      entrenos: ENTRENOS,
      calendario: {
        "2026-11": [
          cita("2026-11-03", 10, 1, "Rodaje 40 min", "running"),
          cita("2026-11-03", 11, 2, "Terapia tobillo", "strength_training"),
          cita("2026-11-04", 12, 3, "Fuerza piernas", "strength_training"),
          cita("2026-11-05", 13, 1, "Rodaje 40 min", "running"),
        ],
      },
      actividades: [
        hecha("2026-11-03", "running", 45, "Ciudad - Rodaje 40 min", 100),
        // La terapia hecha no cubre la fuerza del día siguiente ni cuenta sola.
        hecha("2026-11-04", "strength_training", 20, "Terapia tobillo", 101),
      ],
    });
    const diag = await actualizarCumplimiento(cliente, store, cfg(), "2026-11-05", AHORA);
    expect(diag.leidoDesde).toBe("2026-11-03");
    expect(diag.leidoHasta).toBe("2026-11-05");
    const filas = db.filas("SELECT programacion, fecha, categoria, segundos, cumplida FROM publico_programadas ORDER BY fecha");
    expect(filas).toEqual([
      { programacion: "s10", fecha: "2026-11-03", categoria: "carrera", segundos: 3000, cumplida: 1 },
      { programacion: "s12", fecha: "2026-11-04", categoria: "fuerza", segundos: 1800, cumplida: 0 },
      // La de hoy queda guardada (si se borra de Garmin esta tarde, sigue
      // constando), pero el % no la cuenta hasta mañana.
      { programacion: "s13", fecha: "2026-11-05", categoria: "carrera", segundos: 3000, cumplida: 0 },
    ]);
    expect((await store.config()).cumplimientoHasta).toBe("2026-11-04");
    // El diagnóstico (privado) dice por qué la terapia no entra.
    expect(diag.sesiones.find((s) => s.titulo === "Terapia tobillo").categoria).toBeNull();
  });

  it("una sesión fallada que se borra de Garmin sigue contando como fallada", async () => {
    const { store, db } = herramienta();
    const conCita = garmin({
      entrenos: ENTRENOS,
      calendario: { "2026-11": [cita("2026-11-03", 10, 1, "Rodaje 40 min", "running")] },
      actividades: [],
    });
    await actualizarCumplimiento(conCita, store, cfg(), "2026-11-04", AHORA);
    const sinCita = garmin({ entrenos: ENTRENOS, calendario: {}, actividades: [] });
    await actualizarCumplimiento(sinCita, store, cfg("2026-11-03"), "2026-11-05", AHORA);
    expect(db.filas("SELECT programacion, cumplida FROM publico_programadas")).toEqual([
      { programacion: "s10", cumplida: 0 },
    ]);
  });

  it("un mes que Garmin no deja leer no se guarda como mes sin plan", async () => {
    const { store, db } = herramienta();
    const roto = {
      async api(ruta) {
        if (ruta.includes("calendar-service")) return new Response("", { status: 429 });
        return new Response("[]", { status: 200 });
      },
    };
    await expect(actualizarCumplimiento(roto, store, cfg(), "2026-11-05", AHORA)).rejects.toThrow(/429/);
    expect(db.filas("SELECT * FROM publico_programadas")).toEqual([]);
    expect((await store.config()).cumplimientoHasta).toBeNull();
  });
});
