/**
 * El código de hoy contra la base de ayer.
 *
 * El 04/09/2026 se desplegó el código de la migración 0006 sin aplicarla, y
 * `get_contract` —la lectura obligatoria antes de prescribir— devolvió
 * «D1_ERROR: no such column: vence». El entrenador se quedó sin contrato.
 * Estos tests montan la base parada en la 0005, como estaba producción, y
 * exigen que todo lo que funcionaba antes siga funcionando.
 */

import { describe, expect, it } from "vitest";
import { ContractStore, ContractError, COLUMNAS_0006 } from "../src/contract/store.ts";
import { renderContract } from "../src/tools/contractTools.ts";
import { d1EnMemoria } from "./apoyo-d1.mjs";

const HOY = "2026-09-04";
const store = (db) => new ContractStore(db, () => HOY);

/** Un contrato con algo de todo, escrito solo con lo que la 0005 sabe guardar. */
async function sembrar(db) {
  await store(db).commit({
    mensaje: "Siembra",
    fecha: "2026-06-01",
    reglas: [
      { accion: "crear", id: "R001", tema: "jerarquia", contenido: "Correr manda", vence: "nunca" },
      { accion: "crear", id: "R002", tema: "caduca", contenido: "Se muere sola", vence: "2026-08-01" },
    ],
    estado: { nivel_tobillo: "0 · 4 kg" },
    pendientes: [{ accion: "añadir", texto: "Comprar bastones" }],
    disparadores: [{ accion: "añadir", fecha: "2026-12-01", accion_texto: "Revisar el peso" }],
    carreras: [{ accion: "añadir", nombre: "Trail de la Sierra", fecha: "2026-11-29", prioridad: "A" }],
  });
}

describe("base parada en la 0005 (el estado de producción el 04/09/2026)", () => {
  it("la lectura obligatoria responde en vez de romper", async () => {
    const db = d1EnMemoria({ salta: ["0006"] });
    await sembrar(db);
    // La regresión exacta: esto lanzaba «no such column: vence».
    const snap = await store(db).snapshot();
    expect(snap.reglas.map((r) => r.id)).toEqual(["R001"]);
    expect(snap.pendientes[0].texto).toBe("Comprar bastones");
    expect(snap.carreras[0].nombre).toBe("Trail de la Sierra");
    expect(snap.disparadores[0].accion).toBe("Revisar el peso");
    expect(snap.estado[0]).toMatchObject({ clave: "nivel_tobillo", valor: "0 · 4 kg" });
    // Las reglas siguen caducando solas aunque los pendientes no puedan.
    expect(snap.bajasAutomaticas.map((r) => r.id)).toEqual(["R002"]);
    expect(db.filas("SELECT mensaje FROM log WHERE mensaje LIKE 'Baja autom%'")).toHaveLength(1);
  });

  it("dice qué columnas faltan y el contrato lo avisa arriba del todo", async () => {
    const db = d1EnMemoria({ salta: ["0006"] });
    await sembrar(db);
    const snap = await store(db).snapshot();
    expect(snap.columnasAusentes).toEqual([...COLUMNAS_0006]);

    const texto = renderContract(snap);
    expect(texto).toContain("⚠ ESQUEMA ATRASADO");
    expect(texto).toContain("pendientes.vence");
    expect(texto).toContain("npm run db:migrate");
    expect(texto).toContain("se puede prescribir");
    // Sin columnas no tiene sentido pedirle resúmenes al modelo: solo daría
    // commits rechazados. El aviso de arriba ya explica qué pasa.
    expect(texto).not.toContain("SIN 'resumen':");
    expect(texto.split("\n").pop().startsWith("[TAMAÑO] ")).toBe(true);
    expect(texto).toContain("R001 jerarquia");
    expect(texto).toContain("#1 Comprar bastones");
  });

  it("los commits de siempre siguen entrando", async () => {
    const db = d1EnMemoria({ salta: ["0006"] });
    await sembrar(db);
    const resultado = await store(db).commit({
      mensaje: "Commit normal con el esquema viejo",
      reglas: [
        { accion: "crear", id: "R010", tema: "nueva", contenido: "Sin resumen" },
        { accion: "modificar", id: "R001", contenido: "Correr manda, matizado" },
      ],
      estado: { bloque: "base-2" },
      pendientes: [{ accion: "añadir", texto: "Otro pendiente" }, { accion: "resolver", id: 1 }],
      carreras: [{ accion: "actualizar", id: 1, estado: "confirmada", notas: "inscrito" }],
    });
    // La caducidad se dispara al LEER, y aquí aún no se ha leído: v1 siembra, v2 esta.
    expect(resultado.version).toBe(2);
    const snap = await store(db).snapshot();
    expect(snap.reglas.map((r) => r.id)).toEqual(["R001", "R010"]);
    expect(snap.reglas.find((r) => r.id === "R001").contenido).toBe("Correr manda, matizado");
    expect(snap.pendientes.map((p) => p.texto)).toEqual(["Otro pendiente"]);
    expect(snap.carreras[0]).toMatchObject({ estado: "confirmada", notas: "inscrito" });
  });

  it("pedir un campo que la base no puede guardar se rechaza entero y explicado", async () => {
    const db = d1EnMemoria({ salta: ["0006"] });
    await sembrar(db);
    const antes = await store(db).version();

    for (const [caso, cambios] of [
      ["resumen de regla", { reglas: [{ accion: "crear", id: "R020", tema: "t", contenido: "c", resumen: "corto" }] }],
      ["resumen de pendiente", { pendientes: [{ accion: "añadir", texto: "x", resumen: "corto" }] }],
      ["vence de pendiente", { pendientes: [{ accion: "añadir", texto: "x", vence: "2026-12-31" }] }],
      ["actualizar con resumen", { pendientes: [{ accion: "actualizar", id: 1, resumen: "corto" }] }],
    ]) {
      const fallo = await store(db)
        .commit({ mensaje: `intento: ${caso}`, ...cambios })
        .then(() => null, (exc) => exc);
      expect(fallo, caso).toBeInstanceOf(ContractError);
      expect(fallo.message, caso).toMatch(/migración 0006/);
      expect(fallo.message, caso).toMatch(/npm run db:migrate/);
      expect(fallo.message, caso).toMatch(/No se ha escrito nada/);
    }
    // Ni una fila ni un bump de versión: el rechazo es antes de escribir.
    expect(await store(db).version()).toBe(antes);
    expect(db.filas("SELECT id FROM reglas WHERE id = 'R020'")).toHaveLength(0);
    expect(db.filas("SELECT id FROM pendientes WHERE texto = 'x'")).toHaveLength(0);
    expect(db.filas("SELECT id FROM log WHERE mensaje LIKE 'intento:%'")).toHaveLength(0);
  });

  it("actualizar un pendiente conserva el id aun sin las columnas nuevas", async () => {
    const db = d1EnMemoria({ salta: ["0006"] });
    await sembrar(db);
    await store(db).commit({
      mensaje: "Comprimir el pendiente 1",
      pendientes: [{ accion: "actualizar", id: 1, texto: "Bastones: decidir marca" }],
    });
    const snap = await store(db).snapshot();
    expect(snap.pendientes).toHaveLength(1);
    expect(snap.pendientes[0]).toMatchObject({ id: 1, texto: "Bastones: decidir marca" });
  });
});

describe("base al día", () => {
  it("no avisa de nada y guarda resumen y vencimiento", async () => {
    const db = d1EnMemoria();
    await sembrar(db);
    await store(db).commit({
      mensaje: "Con la 0006 puesta",
      reglas: [{ accion: "modificar", id: "R001", resumen: "Correr manda en cualquier conflicto" }],
      pendientes: [{ accion: "actualizar", id: 1, resumen: "Bastones", vence: "2026-12-31" }],
    });
    const snap = await store(db).snapshot();
    expect(snap.columnasAusentes).toEqual([]);
    expect(snap.reglas.find((r) => r.id === "R001").resumen).toBe("Correr manda en cualquier conflicto");
    expect(snap.pendientes[0]).toMatchObject({ id: 1, resumen: "Bastones", vence: "2026-12-31" });

    const texto = renderContract(snap);
    expect(texto).not.toContain("ESQUEMA ATRASADO");
    expect(texto).toContain("R001 jerarquia | vence nunca | Correr manda en cualquier conflicto");
  });

  it("un pendiente vencido se cierra solo, con log y bump de versión", async () => {
    const db = d1EnMemoria();
    await sembrar(db);
    await store(db).commit({
      mensaje: "Pendiente con fecha",
      pendientes: [{ accion: "añadir", texto: "Decidir la media", vence: "2026-09-01" }],
    });
    const antes = await store(db).version();
    const snap = await store(db).snapshot();
    // «Comprar bastones» se sembró el 01/06 y nunca se tocó: a 95 días, cae
    // solo por inactividad junto al que tenía fecha propia.
    expect(snap.pendientesVencidosHoy.map((p) => p.texto).sort()).toEqual([
      "Comprar bastones",
      "Decidir la media",
    ]);
    expect(snap.pendientes).toEqual([]);
    expect(await store(db).version()).toBe(antes + 1);
    expect(db.filas("SELECT mensaje FROM log WHERE mensaje LIKE '%pendiente #2%'")).toHaveLength(1);
  });
});

describe("el estado no se recorre carácter a carácter", () => {
  // El v168 recibió 'estado' como cadena. Object.entries de una cadena la
  // recorre letra a letra: 309 claves basura escritas, la clave real no. El
  // commit fue atómico y válido, así que nada falló. Esto lo para antes.

  it("una cadena en 'estado' se rechaza entera, sin escribir ni una clave", async () => {
    const db = d1EnMemoria();
    await sembrar(db);
    const antes = await store(db).version();
    await expect(
      store(db).commit({ mensaje: "umbral", estado: "LTHR 193 provisional" }),
    ).rejects.toThrow(ContractError);
    expect(await store(db).version()).toBe(antes);
    // Solo la clave que sembró la siembra: ni una letra suelta escrita.
    expect(db.filas("SELECT clave FROM estado").map((f) => f.clave)).toEqual(["nivel_tobillo"]);
  });

  it("una clave de un carácter o puramente numérica se rechaza", async () => {
    const db = d1EnMemoria();
    await sembrar(db);
    for (const clave of ["0", "7", "x", "309"]) {
      await expect(
        store(db).commit({ mensaje: "basura", estado: { [clave]: "algo" } }),
      ).rejects.toThrow(/no válida/);
    }
    expect(db.filas("SELECT clave FROM estado").map((f) => f.clave)).toEqual(["nivel_tobillo"]);
  });

  it("las claves de verdad siguen entrando", async () => {
    const db = d1EnMemoria();
    await sembrar(db);
    await store(db).commit({
      mensaje: "Estado normal",
      estado: { nivel_tobillo: "1", umbral: "LTHR 190 (Garmin)" },
    });
    const snap = await store(db).snapshot();
    expect(snap.estado.map((e) => e.clave).sort()).toEqual(["nivel_tobillo", "umbral"]);
  });
});

describe("vencimiento por condición", () => {
  // R008, R011 y R019 no caducan en una fecha: caducan cuando pasa algo. Salían
  // como «vence nunca», que es justo lo contrario de lo que pasa (pendiente 17).

  it("una regla con condición no caduca por fecha, y se lee la condición", async () => {
    const db = d1EnMemoria();
    await sembrar(db);
    await store(db).commit({
      mensaje: "R008 vence cuando el test fije el LTHR",
      reglas: [
        {
          accion: "crear",
          id: "R008",
          tema: "zonas",
          contenido: "El umbral no está fijado por test.",
          vence: "cond: hasta que el test fije el LTHR",
        },
      ],
    });
    // Una lectura un año después: sigue viva, porque no depende del calendario.
    const futuro = new ContractStore(db, () => "2027-09-01");
    const snap = await futuro.snapshot();
    const r008 = snap.reglas.find((r) => r.id === "R008");
    expect(r008).toBeTruthy();
    expect(r008.vence).toBe("cond:hasta que el test fije el LTHR");
    expect(renderContract(snap)).toContain(
      "vence por condición: hasta que el test fije el LTHR",
    );
  });

  it("una condición sin decir cuál se rechaza: eso ya era «nunca»", async () => {
    const db = d1EnMemoria();
    await sembrar(db);
    for (const vence of ["cond:", "condición", "cond"]) {
      await expect(
        store(db).commit({
          mensaje: "sin condición",
          reglas: [{ accion: "crear", id: "R099", tema: "x", contenido: "y", vence }],
        }),
      ).rejects.toThrow(ContractError);
    }
  });

  it("las reglas con fecha siguen caducando solas", async () => {
    const db = d1EnMemoria();
    await sembrar(db);
    // R002 se sembró con vence 2026-08-01 y HOY es el 03/09: ya no está.
    const snap = await store(db).snapshot();
    expect(snap.reglas.find((r) => r.id === "R002")).toBeUndefined();
  });

  it("un pendiente con condición sigue caducando por inactividad", async () => {
    const db = d1EnMemoria();
    await sembrar(db);
    await store(db).commit({
      mensaje: "Pendiente con condición",
      fecha: "2026-06-01",
      pendientes: [{ accion: "añadir", texto: "Decidir la media", vence: "cond: cuando confirme" }],
    });
    // Una condición no es una fecha: la red de los 90 días sin tocarse le aplica
    // igual que a los que no tienen ninguna, o no caducaría nunca.
    const futuro = new ContractStore(db, () => "2026-12-01");
    const snap = await futuro.snapshot();
    expect(snap.pendientes.find((p) => p.texto === "Decidir la media")).toBeUndefined();
  });
});
