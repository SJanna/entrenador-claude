/**
 * Doble llave de las restricciones médicas, hecha cumplir por el servidor.
 *
 * Antes era una frase de la constitución («esta sección solo se enmienda si yo
 * lo digo, y citas mi frase en el log») y nada impedía a un commit relajarla
 * por inferencia. Ahora la base lo rechaza.
 */

import { describe, expect, it } from "vitest";
import { ContractStore, ContractError } from "../src/contract/store.ts";
import { d1EnMemoria } from "./apoyo-d1.mjs";

const HOY = "2026-11-07";
const store = (db) => new ContractStore(db, () => HOY);
const CITA = "Sí, ya puedes subir el colgado a 20 segundos, el cirujano lo aprobó";

async function conProtegida(db) {
  await store(db).commit({
    mensaje: "Alta de la restricción",
    cita_textual: "Apunta que nunca entreno al fallo con el brazo operado",
    reglas: [
      {
        accion: "crear",
        id: "R001",
        tema: "lesion",
        resumen: "Nunca al fallo en nada que cargue el brazo operado.",
        contenido: "Esguince de tobillo.",
        vence: "nunca",
        protegida: true,
      },
    ],
  });
}

describe("reglas protegidas", () => {
  it("crear una protegida sin cita se rechaza y no escribe nada", async () => {
    const db = d1EnMemoria();
    await expect(
      store(db).commit({
        mensaje: "x",
        reglas: [{ accion: "crear", tema: "lesion", contenido: "y", protegida: true }],
      }),
    ).rejects.toThrow(/PROTEGIDA/);
    expect(await store(db).version()).toBe(0);
  });

  it("modificar o retirar una protegida sin cita se rechaza entero", async () => {
    const db = d1EnMemoria();
    await conProtegida(db);
    const antes = await store(db).version();
    for (const cambio of [
      { accion: "modificar", id: "R001", resumen: "Al fallo vale si va bien" },
      { accion: "retirar", id: "R001", motivo: "dos semanas buenas" },
      { accion: "modificar", id: "R001", protegida: false },
    ]) {
      await expect(
        store(db).commit({ mensaje: "relajar", reglas: [cambio], estado: { bloque: "base" } }),
      ).rejects.toBeInstanceOf(ContractError);
    }
    expect(await store(db).version()).toBe(antes);
    const snap = await store(db).snapshot();
    expect(snap.reglas[0].resumen).toBe("Nunca al fallo en nada que cargue el brazo operado.");
    expect(snap.estado).toHaveLength(0);
  });

  it("una paráfrasis corta no vale como cita", async () => {
    const db = d1EnMemoria();
    await conProtegida(db);
    await expect(
      store(db).commit({
        mensaje: "x",
        cita_textual: "sí",
        reglas: [{ accion: "retirar", id: "R001" }],
      }),
    ).rejects.toThrow(/PROTEGIDA/);
  });

  it("con la cita se aplica y la cita queda en el log", async () => {
    const db = d1EnMemoria();
    await conProtegida(db);
    const r = await store(db).commit({
      mensaje: "SUBE EL COLGADO",
      cita_textual: CITA,
      reglas: [{ accion: "modificar", id: "R001", resumen: "Nunca al fallo; colgado hasta 20 s." }],
    });
    const log = db.filas(`SELECT mensaje, detalles FROM log WHERE version = ${r.version}`)[0];
    expect(log.mensaje).toContain(`«${CITA}»`);
    expect(JSON.parse(log.detalles).cita_textual).toBe(CITA);
  });

  it("una protegida no puede vencer por fecha, sí por condición", async () => {
    const db = d1EnMemoria();
    const base = { accion: "crear", tema: "lesion", contenido: "y", protegida: true };
    await expect(
      store(db).commit({ mensaje: "x", cita_textual: CITA, reglas: [{ ...base, vence: "2027-01-01" }] }),
    ).rejects.toThrow(/no puede vencer por fecha/);
    await store(db).commit({
      mensaje: "x",
      cita_textual: CITA,
      reglas: [{ ...base, vence: "cond: alta del traumatólogo" }],
    });
  });

  it("las reglas normales no piden cita", async () => {
    const db = d1EnMemoria();
    await store(db).commit({
      mensaje: "x",
      reglas: [{ accion: "crear", tema: "jerarquia", contenido: "Correr manda", vence: "nunca" }],
    });
    await store(db).commit({ mensaje: "y", reglas: [{ accion: "retirar", id: "R001" }] });
  });

  it("base sin la 0009: lo de siempre funciona, y pedir protección dice qué falta", async () => {
    const db = d1EnMemoria({ salta: ["0009"] });
    await store(db).commit({
      mensaje: "x",
      reglas: [{ accion: "crear", tema: "jerarquia", contenido: "Correr manda" }],
    });
    await expect(
      store(db).commit({
        mensaje: "y",
        cita_textual: CITA,
        reglas: [{ accion: "crear", tema: "lesion", contenido: "z", protegida: true }],
      }),
    ).rejects.toThrow(/protegida/);
  });
});
