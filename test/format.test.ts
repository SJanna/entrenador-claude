import { describe, expect, it } from "vitest";
import * as fmt from "../src/intervals/format";
import { parseContratoNote, parseEstadoNote, type ImportPreview } from "../src/contract/importer";

describe("format", () => {
  it("duration", () => {
    expect(fmt.duration(3661)).toBe("1:01:01");
    expect(fmt.duration(59)).toBe("0:59");
    expect(fmt.duration(600, { forceHours: true })).toBe("0:10:00");
    expect(fmt.duration(null)).toBe("—");
  });
  it("hoursMinutes", () => {
    expect(fmt.hoursMinutes(7.5 * 3600)).toBe("7:30");
    expect(fmt.hoursMinutes(0)).toBe("—");
  });
  it("pace por deporte", () => {
    expect(fmt.pace(1000 / 300, "Run")).toBe("5:00/km");
    expect(fmt.pace(100 / 105, "Swim")).toBe("1:45/100m");
    expect(fmt.pace(10, "Ride")).toBe("36.0km/h");
  });
  it("km y elevación", () => {
    expect(fmt.km(10500)).toBe("10.5km");
    expect(fmt.elevation(1299)).toBe("+1299m");
  });
  it("tabla alineada sin relleno final", () => {
    const out = fmt.table(["a", "bb"], [["1", "22"], ["333", "4"]], ["l", "r"]);
    expect(out).toBe("a    bb\n1    22\n333   4");
  });
  it("firstPresent tolera variantes", () => {
    expect(fmt.firstPresent({ sleep_secs: 5 }, ["sleepSecs"])).toBe(5);
    expect(fmt.firstPresent({ x: null }, ["x"])).toBe(null);
  });
});

function emptyPreview(): ImportPreview {
  return {
    version: null, reglas: [], disparadores: [], estado: [], pendientes: [],
    logs: [], condiciones: [], carreras: [], noInterpretado: [], crudos: [],
  };
}

describe("importer parsing", () => {
  it("parsea el snapshot [SYS/CONTRATO]", () => {
    const preview = emptyPreview();
    parseContratoNote(
      [
        "[SYS/CONTRATO] v12 · 2026-08-01",
        "R001 fuerza-ubicación | vence nunca | Toda sesión de fuerza lleva (parque) o (casa) en el título",
        "R018 carrera-sustituye | vence 2026-11-30 | Una carrera dura sustituye el día de calidad de su semana",
        "línea rara que no cuadra",
        "--- DISPARADORES ---",
        "2026-08-15 → Recordatorio inscripción Corre con Un Norte",
      ].join("\n"),
      preview,
    );
    expect(preview.version).toBe(12);
    expect(preview.reglas).toHaveLength(2);
    expect(preview.reglas[0]).toEqual({
      id: "R001",
      tema: "fuerza-ubicación",
      vence: null,
      contenido: "Toda sesión de fuerza lleva (parque) o (casa) en el título",
    });
    expect(preview.reglas[1]!.vence).toBe("2026-11-30");
    expect(preview.disparadores).toEqual([
      { fecha: "2026-08-15", accion: "Recordatorio inscripción Corre con Un Norte" },
    ]);
    expect(preview.noInterpretado).toHaveLength(1);
  });

  it("parsea [SYS/ESTADO] como clave: valor", () => {
    const preview = emptyPreview();
    parseEstadoNote(
      ["[SYS/ESTADO] v12", "nivel_tobillo: 1", "bloque: base con calidad", "LTHR: 193 (provisional)"].join("\n"),
      preview,
    );
    expect(preview.estado).toEqual([
      { clave: "nivel_tobillo", valor: "1" },
      { clave: "bloque", valor: "base con calidad" },
      { clave: "LTHR", valor: "193 (provisional)" },
    ]);
  });
});
