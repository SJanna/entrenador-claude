import { describe, expect, it } from "vitest";
import { briefing, type FuentesBriefing } from "../src/tools/briefing";
import type { Calendario, ItemCalendario } from "../src/garmin/calendario";

const HOY = "2026-11-07"; // sábado

function item(fecha: string, extra: Partial<ItemCalendario> = {}): ItemCalendario {
  return {
    fecha, tipo: "workout", titulo: "Rodaje", workoutId: 1, scheduleId: 2, activityId: null,
    deporte: "running", duracionSegundos: 1800, completado: false, ...extra,
  };
}

function fuentes(over: Partial<FuentesBriefing> = {}): FuentesBriefing {
  const cal: Calendario = {
    items: [
      item("2026-11-07", { activityId: 9, workoutId: null, scheduleId: null, tipo: "activity", titulo: "Hecho hoy" }),
      item("2026-11-09"),
      item("2026-11-10"),
    ],
    fallos: [],
    recortado: false,
    claves: {},
  };
  return {
    hoy: () => HOY,
    contrato: async () => "[CONTRATO] v1",
    bienestar: async () => "bienestar ok",
    actividades: async () => "actividades ok",
    calendarioGarmin: async () => cal,
    ...over,
  };
}

describe("briefing", () => {
  it("marca los días sin nada en los próximos 7, con lo hecho contando como algo", async () => {
    const t = await briefing(fuentes(), {});
    expect(t).toMatch(/SIN NADA ESCRITO: dom 08\/11, mié 11\/11, jue 12\/11, vie 13\/11/);
    expect(t).not.toMatch(/SIN NADA ESCRITO:[^\n]*sáb 07\/11/);
    expect(t).toMatch(/Todas las fuentes leídas/);
  });

  it("una nota de intervals no tapa un día vacío; un entreno sí, y avisa si está en los dos", async () => {
    const t = await briefing(
      fuentes({
        eventosIntervals: async () => [
          { start_date_local: "2026-11-08T00:00:00", category: "NOTE", name: "Nota" },
          { start_date_local: "2026-11-11T00:00:00", category: "WORKOUT", name: "Fuerza" },
          { start_date_local: "2026-11-09T00:00:00", category: "WORKOUT", name: "Otra vez" },
        ],
        resumenSemanal: async () => "semanas ok",
      }),
      {},
    );
    expect(t).toMatch(/SIN NADA ESCRITO: dom 08\/11, jue 12\/11, vie 13\/11/);
    expect(t).toMatch(/PROGRAMADO EN LOS DOS CALENDARIOS: lun 09\/11/);
    expect(t).toMatch(/CARGA DE LAS ÚLTIMAS SEMANAS/);
  });

  it("la misma sesión empujada de intervals a Garmin no es un doble", async () => {
    const t = await briefing(
      fuentes({
        eventosIntervals: async () => [{ start_date_local: "2026-11-09T00:00:00", category: "WORKOUT", name: "Rodaje" }],
      }),
      { days_back: 0 },
    );
    expect(t).not.toMatch(/PROGRAMADO EN LOS DOS/);
    expect(t).toMatch(/== 4 · CALENDARIOS 2026-11-07 →/); // days_back 0 es 0, no 7
  });

  it("lo que falla sale como NO LEÍDO y no se dan días por vacíos", async () => {
    const t = await briefing(
      fuentes({
        bienestar: async () => "Error: Garmin respondió 401",
        calendarioGarmin: async () => {
          throw new Error("sin sesión de Garmin");
        },
      }),
      {},
    );
    expect(t).toMatch(/NO LEÍDO — Error: Garmin respondió 401/);
    expect(t).toMatch(/FUENTES NO LEÍDAS/);
    expect(t).toMatch(/calendario de Garmin: sin sesión/);
    expect(t).toMatch(/ningún calendario/);
    expect(t).not.toMatch(/SIN NADA ESCRITO/);
  });
});
