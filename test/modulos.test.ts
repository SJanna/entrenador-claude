/**
 * Instalación sin intervals.icu: Garmin manda y el contrato vive en D1, así que
 * el entrenador funciona entero; solo desaparecen las herramientas de intervals.
 */

import { describe, expect, it } from "vitest";
import { ConfigError, configFromEnv, configParaEntrenador, paginaPublicaActiva, type Env } from "../src/env";
import {
  HERRAMIENTAS_INTERVALS,
  HERRAMIENTAS_PUBLICO,
  buildTools,
  serverInstructions,
} from "../src/tools/registry";

const base = { DB: {} as D1Database, SESSION_SECRET: "s", MCP_SECRET_PATH: "m", APP_PASSWORD: "p" };

function env(extra: Partial<Env>): Env {
  return { ...base, INTERVALS_API_KEY: "", INTERVALS_ATHLETE_ID: "", ...extra } as Env;
}

describe("intervals.icu opcional", () => {
  it("sin clave ni id arranca en modo solo Garmin", () => {
    expect(configFromEnv(env({})).intervals).toBe(false);
  });

  it("a medias es un error, no un modo", () => {
    expect(() => configFromEnv(env({ INTERVALS_API_KEY: "k" }))).toThrow(ConfigError);
    expect(() => configFromEnv(env({ INTERVALS_ATHLETE_ID: "i1" }))).toThrow(ConfigError);
  });

  it("solo Garmin: no se registra ninguna herramienta de intervals ni la pública", () => {
    const e = env({});
    const nombres = buildTools(e, configFromEnv(e)).map((t) => t.name);
    for (const n of HERRAMIENTAS_INTERVALS) expect(nombres).not.toContain(n);
    for (const n of HERRAMIENTAS_PUBLICO) expect(nombres).not.toContain(n);
    for (const n of [
      "briefing", "get_contract", "contract_commit", "garmin_create_workout", "diary_set",
      "diary_get", "garmin_streaks", "garmin_weekly_summary", "garmin_records", "garmin_wellness_history",
      "garmin_search_activities", "garmin_sync",
    ]) {
      expect(nombres).toContain(n);
    }
  });

  it("con intervals y página pública están todas", () => {
    const e = env({
      INTERVALS_API_KEY: "k",
      INTERVALS_ATHLETE_ID: "i1",
      PUBLICO: {} as KVNamespace,
    });
    const nombres = buildTools(e, configFromEnv(e)).map((t) => t.name);
    for (const n of HERRAMIENTAS_INTERVALS) expect(nombres).toContain(n);
    expect(nombres).toContain("set_plan_publico");
  });

  it("INTERVALS_EN_ENTRENADOR=no: configurado para el panel, invisible para el entrenador", () => {
    const e = env({ INTERVALS_API_KEY: "k", INTERVALS_ATHLETE_ID: "i1", INTERVALS_EN_ENTRENADOR: "no" });
    expect(configFromEnv(e).intervals).toBe(true);
    const c = configParaEntrenador(e);
    expect(c.intervals).toBe(false);
    const nombres = buildTools(e, c).map((t) => t.name);
    for (const n of HERRAMIENTAS_INTERVALS) expect(nombres).not.toContain(n);
  });

  it("INTERVALS_EN_ENTRENADOR=no con página pública: set_plan_publico sigue, y lo anunciado existe", () => {
    // La página la calcula el servidor con intervals; que el entrenador no lo
    // vea no la apaga. Antes se anunciaba set_plan_publico y no se registraba.
    const e = env({
      INTERVALS_API_KEY: "k",
      INTERVALS_ATHLETE_ID: "i1",
      INTERVALS_EN_ENTRENADOR: "no",
      PUBLICO: {} as KVNamespace,
    });
    const c = configParaEntrenador(e);
    const nombres = buildTools(e, c).map((t) => t.name);
    expect(nombres).toContain("set_plan_publico");
    const instr = serverInstructions({ intervals: c.intervals, publico: paginaPublicaActiva(e) });
    expect(instr).toMatch(/set_plan_publico/);
    // Y sin intervals en el entrenador, ninguna descripción le manda a intervals.
    const texto = buildTools(e, c).map((t) => t.description).join("\n") + instr;
    expect(texto).not.toMatch(/list_events|intervals\.icu|get_activities|get_weekly_summary/);
  });

  it("toda herramienta que nombran las instrucciones está registrada", () => {
    for (const intervals of [false, true]) {
      for (const publico of [false, true]) {
        const e = env({
          ...(intervals || publico ? { INTERVALS_API_KEY: "k", INTERVALS_ATHLETE_ID: "i1" } : {}),
          ...(intervals ? {} : { INTERVALS_EN_ENTRENADOR: "no" }),
          ...(publico ? { PUBLICO: {} as KVNamespace } : {}),
        });
        const c = configParaEntrenador(e);
        const nombres = new Set(buildTools(e, c).map((t) => t.name));
        const instr = serverInstructions({ intervals: c.intervals, publico: paginaPublicaActiva(e) });
        const citadas = instr.match(/\b(?:get|set|list|create|diary|garmin|contract)_[a-z_]+\b/g) ?? [];
        for (const n of citadas) expect(nombres, `${n} (intervals=${intervals}, publico=${publico})`).toContain(n);
      }
    }
  });

  it("las instrucciones no mandan a herramientas que no existen", () => {
    const solo = serverInstructions({ intervals: false, publico: false });
    expect(solo).not.toMatch(/get_records|list_events|get_wellness\b|set_wellness|set_plan_publico|create_workout \(/);
    expect(solo).toMatch(/garmin_weekly_summary/);
  });

  it("ninguna descripción ni instrucción lleva datos de un atleta concreto", () => {
    const e = env({ INTERVALS_API_KEY: "k", INTERVALS_ATHLETE_ID: "i1", PUBLICO: {} as KVNamespace });
    const texto = [
      serverInstructions({ intervals: true, publico: true }),
      ...buildTools(e, configFromEnv(e)).map((t) => t.description + JSON.stringify(t.inputSchema)),
    ].join("\n");
    expect(texto).not.toMatch(/radio|placa|0 a 120|Barranquilla|R0(?!01)[0-9]{2}\b|H10|Fenix/i);
  });
});
