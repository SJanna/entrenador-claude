import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configDesdeEntorno, leerJsonc, textoConfig } from "../scripts/config-desde-entorno.mjs";

const plantilla = leerJsonc(readFileSync(new URL("../wrangler.example.jsonc", import.meta.url), "utf8"));
const ID = "11111111-2222-3333-4444-555555555555";

describe("config desde el entorno (Workers Builds)", () => {
  it("lee la plantilla JSONC con comentarios", () => {
    expect(plantilla.main).toBe("src/index.ts");
    expect(plantilla.d1_databases[0].binding).toBe("DB");
  });

  it("no toca // dentro de las cadenas", () => {
    expect(leerJsonc('{ "u": "https://x.dev/a", // nota\n "b": 1, }')).toEqual({ u: "https://x.dev/a", b: 1 });
  });

  it("exige el id de la base", () => {
    expect(() => configDesdeEntorno({}, plantilla)).toThrow(/D1_DATABASE_ID/);
    expect(() => configDesdeEntorno({ D1_DATABASE_ID: "no-es-un-id" }, plantilla)).toThrow(/no parece/);
  });

  it("sin más variables, conserva la plantilla y no inventa la página pública", () => {
    const c = configDesdeEntorno({ D1_DATABASE_ID: ID }, plantilla);
    expect(c.name).toBe(plantilla.name);
    expect(c.d1_databases[0]).toMatchObject({ database_id: ID, database_name: plantilla.d1_databases[0].database_name, binding: "DB" });
    expect(c.kv_namespaces).toBeUndefined();
    expect(c.vars).toEqual(plantilla.vars);
    expect(c.triggers).toEqual(plantilla.triggers);
  });

  it("aplica nombre, KV y variables", () => {
    const c = configDesdeEntorno(
      {
        D1_DATABASE_ID: ID,
        WORKER_NAME: "mi-entrenador",
        D1_DATABASE_NAME: "otra-base",
        KV_PUBLICO_ID: "a".repeat(32),
        INTERVALS_TZ: "Europe/Madrid",
        INTERVALS_ATHLETE_ID: "i1",
      },
      plantilla,
    );
    expect(c.name).toBe("mi-entrenador");
    expect(c.d1_databases[0].database_name).toBe("otra-base");
    expect(c.kv_namespaces).toEqual([{ binding: "PUBLICO", id: "a".repeat(32) }]);
    expect(c.vars).toMatchObject({ INTERVALS_TZ: "Europe/Madrid", INTERVALS_ATHLETE_ID: "i1" });
  });

  it("rechaza nombres y KV con mala forma", () => {
    expect(() => configDesdeEntorno({ D1_DATABASE_ID: ID, WORKER_NAME: "Con Espacios" }, plantilla)).toThrow(/WORKER_NAME/);
    expect(() => configDesdeEntorno({ D1_DATABASE_ID: ID, KV_PUBLICO_ID: "corto" }, plantilla)).toThrow(/KV_PUBLICO_ID/);
  });

  it("el texto generado vuelve a leerse igual", () => {
    const c = configDesdeEntorno({ D1_DATABASE_ID: ID }, plantilla);
    expect(leerJsonc(textoConfig(c))).toEqual(c);
  });

  it("no deja la plantilla modificada", () => {
    configDesdeEntorno({ D1_DATABASE_ID: ID, WORKER_NAME: "x" }, plantilla);
    expect(plantilla.d1_databases[0].database_id).toBe("00000000-0000-0000-0000-000000000000");
  });
});
