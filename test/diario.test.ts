import { describe, expect, it } from "vitest";
import {
  formatearValor,
  normalizarClave,
  validarValor,
  type CampoDiario,
} from "../src/diario/store";

const DOLOR: CampoDiario = {
  campo: "dolor_tobillo",
  etiqueta: "tobillo",
  tipo: "numero",
  minimo: 0,
  maximo: 10,
  descripcion: "0 nada, 10 insoportable",
};
const SINTOMAS: CampoDiario = {
  campo: "sintomas",
  etiqueta: "sínt",
  tipo: "si_no",
  minimo: null,
  maximo: null,
  descripcion: "",
};
const NOTA: CampoDiario = {
  campo: "nota",
  etiqueta: "nota",
  tipo: "texto",
  minimo: null,
  maximo: null,
  descripcion: "",
};

describe("normalizarClave", () => {
  it("deja una clave estable con la que escribir cada día", () => {
    expect(normalizarClave("Dolor del tobillo")).toBe("dolor_del_tobillo");
    expect(normalizarClave("  DOLOR-tobillo  ")).toBe("dolor_tobillo");
    expect(normalizarClave("Sensación (mañana)")).toBe("sensacion_manana");
    expect(normalizarClave("¿?")).toBe("");
    expect(normalizarClave(null)).toBe("");
  });

  it("la misma etiqueta escrita de dos formas da la misma clave", () => {
    expect(normalizarClave("dolor tobillo")).toBe(normalizarClave("Dolor_Tobillo"));
  });
});

describe("validarValor", () => {
  it("acepta un número dentro de la escala declarada", () => {
    expect(validarValor(DOLOR, 4)).toEqual({ campo: "dolor_tobillo", valor: 4, texto: null });
    expect(validarValor(DOLOR, "7.5").valor).toBe(7.5);
    expect(validarValor(DOLOR, 0).valor).toBe(0);
  });

  it("rechaza fuera de escala diciendo cuál es la escala", () => {
    expect(() => validarValor(DOLOR, 44)).toThrow(/va de 0 a 10/);
    expect(() => validarValor(DOLOR, -1)).toThrow(/va de 0 a 10/);
    expect(() => validarValor(DOLOR, "mucho")).toThrow(/no es un número/);
  });

  it("entiende el sí/no en las formas en que se escribe de verdad", () => {
    for (const si of [true, 1, "sí", "si", "SI", "true"]) {
      expect(validarValor(SINTOMAS, si).valor).toBe(1);
    }
    for (const no of [false, 0, "no", "NO", "false"]) {
      expect(validarValor(SINTOMAS, no).valor).toBe(0);
    }
    expect(() => validarValor(SINTOMAS, "regular")).toThrow(/sí\/no/);
  });

  it("un valor vacío borra la medición en vez de guardar un cero", () => {
    // No apuntar el dolor y apuntar un 0 son cosas distintas: la diferencia es
    // justo lo que hace que un hueco en la serie signifique algo.
    expect(validarValor(DOLOR, null)).toEqual({ campo: "dolor_tobillo", valor: null, texto: null });
    expect(validarValor(DOLOR, "")).toEqual({ campo: "dolor_tobillo", valor: null, texto: null });
    expect(validarValor(DOLOR, 0).valor).toBe(0);
  });

  it("el texto se guarda tal cual en su columna", () => {
    expect(validarValor(NOTA, "molesta al apoyar")).toEqual({
      campo: "nota",
      valor: null,
      texto: "molesta al apoyar",
    });
  });
});

describe("formatearValor", () => {
  it("cada tipo se lee como se escribió", () => {
    expect(formatearValor(DOLOR, { campo: "dolor_tobillo", valor: 4, texto: null })).toBe("4");
    expect(formatearValor(DOLOR, { campo: "dolor_tobillo", valor: 7.5, texto: null })).toBe("7.5");
    expect(formatearValor(SINTOMAS, { campo: "sintomas", valor: 1, texto: null })).toBe("sí");
    expect(formatearValor(SINTOMAS, { campo: "sintomas", valor: 0, texto: null })).toBe("no");
    expect(formatearValor(NOTA, { campo: "nota", valor: null, texto: "ok" })).toBe("ok");
  });

  it("sin registro es un guion, no un cero", () => {
    expect(formatearValor(DOLOR, undefined)).toBe("—");
    expect(formatearValor(DOLOR, { campo: "dolor_tobillo", valor: null, texto: null })).toBe("—");
  });
});
