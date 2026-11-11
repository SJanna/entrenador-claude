/**
 * Clima con humedad y zonas de FC: lo que el entrenador no veía.
 *
 *  - Un pulso alto no se lee sin la hora, la temperatura y la humedad.
 *  - El «~80 % fácil» solo se comprueba con el tiempo en zonas, no con medias.
 */

import { describe, expect, it } from "vitest";
import {
  formatearActividad,
  leerActividad,
  reparto,
  tiempoDe,
  zonasDe,
} from "../src/garmin/actividades.ts";
import { sincronizarHistorico } from "../src/historico/sincronizar.ts";
import { HistoricoStore } from "../src/historico/store.ts";
import { HistoricoTools, climaCorto, repartoSemana } from "../src/tools/historicoTools.ts";
import { d1EnMemoria } from "./apoyo-d1.mjs";

const HOY = "2026-12-10";
const json = (c) => new Response(JSON.stringify(c), { status: 200 });
const ZONAS = [
  { zoneNumber: 1, secsInZone: 600, zoneLowBoundary: 123 },
  { zoneNumber: 2, secsInZone: 1800, zoneLowBoundary: 143 },
  { zoneNumber: 3, secsInZone: 300, zoneLowBoundary: 162 },
  { zoneNumber: 4, secsInZone: 240, zoneLowBoundary: 172 },
  { zoneNumber: 5, secsInZone: 60, zoneLowBoundary: 185 },
];
const TIEMPO = { temp: 86, apparentTemp: 95, relativeHumidity: 78, weatherTypeDTO: { desc: "Parcialmente nublado" } };

function bruta(id, fecha, deporte = "running") {
  return {
    activityId: id, activityName: `Act ${id}`, startTimeLocal: `${fecha} 05:30:00`,
    activityType: { typeKey: deporte }, duration: 3000, distance: 8000,
    averageHR: 145, maxHR: 170, activityTrainingLoad: 80,
  };
}

function garmin() {
  const llamadas = [];
  return {
    llamadas,
    atleta: async () => "atleta-1",
    api: async (ruta) => {
      llamadas.push(ruta);
      if (ruta.includes("activitylist-service")) {
        const inicio = Number(new URL(ruta, "https://x").searchParams.get("start"));
        return json(inicio > 0 ? [] : [bruta(21, "2026-12-09"), bruta(22, "2026-12-08", "strength_training")]);
      }
      if (/\/weather$/.test(ruta)) return json(TIEMPO);
      if (/\/hrTimeInZones$/.test(ruta)) return json(ZONAS);
      return new Response(null, { status: 204 });
    },
  };
}

describe("clima y zonas en una actividad", () => {
  it("el clima llega en °F y sale en °C, con sensación y humedad", () => {
    expect(tiempoDe(TIEMPO)).toEqual({ tempC: 30, sensacionC: 35, humedad: 78, cielo: "Parcialmente nublado" });
    expect(tiempoDe({ temp: 400, relativeHumidity: 150 })).toBeNull();
  });

  it("las zonas se ordenan y el reparto es Z1-Z2 / Z3 / Z4-Z5", () => {
    const z = zonasDe([...ZONAS].reverse());
    expect(z.map((x) => x.zona)).toEqual([1, 2, 3, 4, 5]);
    expect(reparto(z)).toEqual({ suave: 2400, medio: 300, duro: 300, total: 3000 });
  });

  it("garmin_activity enseña el clima a su hora y el tiempo en zonas", async () => {
    const g = garmin();
    const cliente = {
      api: async (ruta) =>
        /\/activity\/7$/.test(ruta)
          ? json({ activityName: "Rodaje", activityTypeDTO: { typeKey: "running" }, summaryDTO: { startTimeLocal: "2026-12-09T05:30:00.0", duration: 3000 } })
          : g.api(ruta),
    };
    const r = await leerActividad(cliente, 7);
    const texto = formatearActividad(r.actividad, r.series, r.avisoSeries, r.vueltas, r.avisoVueltas, r.entreno, {
      tiempo: r.tiempo,
      zonas: r.zonas,
    });
    expect(texto).toContain("Clima: 30 °C · sensación 35 °C · humedad 78 % · Parcialmente nublado (a las 05:30)");
    expect(texto).toContain("Z1 10:00 (≥123)");
    expect(texto).toContain("suave Z1-Z2 80 % · medio Z3 10 % · duro Z4-Z5 10 %");
  });

  it("si Garmin no tiene clima ni zonas, la actividad se enseña igual", async () => {
    const cliente = {
      api: async (ruta) =>
        /\/activity\/8$/.test(ruta)
          ? json({ activityName: "Cinta", activityTypeDTO: { typeKey: "treadmill_running" }, summaryDTO: { duration: 1800 } })
          : new Response(null, { status: 404 }),
    };
    const r = await leerActividad(cliente, 8);
    const texto = formatearActividad(r.actividad, r.series, r.avisoSeries, r.vueltas, r.avisoVueltas, r.entreno, {
      tiempo: r.tiempo,
      zonas: r.zonas,
    });
    expect(texto).toContain("«Cinta»");
    expect(texto).not.toContain("Clima:");
    expect(texto).not.toContain("Zonas de FC");
  });
});

describe("clima y zonas en el histórico", () => {
  it("la sincronización guarda humedad y zonas, y el resumen semanal enseña el reparto", async () => {
    const db = d1EnMemoria();
    const store = new HistoricoStore(db);
    const g = garmin();
    const r = await sincronizarHistorico(g, store, HOY, { presupuesto: 30, diasObjetivo: 2 });
    expect(r.zonas).toBe(2);
    const filas = await store.actividades();
    expect(filas.find((f) => f.id === 21)).toMatchObject({ temp_clima: 30, humedad_clima: 78, sensacion_clima: 35, zonas: [600, 1800, 300, 240, 60] });
    // Las zonas se piden también en fuerza (tiene pulso); el clima, solo en carrera al aire libre.
    expect(filas.find((f) => f.id === 22)).toMatchObject({ zonas_estado: "hecho", humedad_clima: null });
    // Y no se vuelven a pedir.
    expect(await store.pendientesDeZonas(10, "2026-01-01")).toEqual([]);

    const t = new HistoricoTools(store, g, () => HOY);
    const semanal = await t.semanal({ weeks: 2 });
    expect(semanal).toMatch(/suave\/medio\/duro/);
    expect(semanal).toMatch(/80\/10\/10 %/);
    const busqueda = await t.buscar({ from: "2026-12-01" });
    expect(busqueda).toContain("30 °C · 78 % a las 05:30");
  });

  it("una semana a medio leer dice cuántas actividades sostienen el reparto", () => {
    expect(repartoSemana({ zonas: [600, 1800, 300, 240, 60], conFc: 3, conZonas: 1 })).toBe("80/10/10 % (1/3)");
    expect(repartoSemana({ zonas: [0, 0, 0, 0, 0], conFc: 2, conZonas: 0 })).toBe("pendiente");
    expect(repartoSemana({ zonas: [0, 0, 0, 0, 0], conFc: 0, conZonas: 0 })).toBe("—");
    expect(climaCorto({ temp_clima: 29.6, humedad_clima: null, inicio: null })).toBe("30 °C");
  });
});
