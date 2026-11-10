import { describe, expect, it } from "vitest";
import { normalizarClave } from "../src/claves";
import { validarEntrada } from "../src/material/store";
import { resumenMaterial } from "../src/tools/materialTools";
import type { Articulo } from "../src/material/store";

function articulo(parcial: Partial<Articulo>): Articulo {
  return {
    id: 1,
    categoria: "running",
    categoriaEtiqueta: "Running",
    nombre: "Zapatillas",
    detalle: "",
    estado: "disponible",
    desde: null,
    actualizadoEn: "2026-08-13T00:00:00.000Z",
    ...parcial,
  };
}

describe("categorías", () => {
  it("la misma categoría escrita de tres formas es una sola", () => {
    // Si se fragmentaran, pedir el material de recuperación devolvería media
    // estantería con pinta de estantería entera.
    const clave = normalizarClave("Recuperación");
    expect(normalizarClave("recuperacion")).toBe(clave);
    expect(normalizarClave("  RECUPERACIÓN ")).toBe(clave);
    expect(clave).toBe("recuperacion");
  });
});

describe("validarEntrada", () => {
  it("acepta lo mínimo y normaliza los espacios del nombre", () => {
    const entrada = validarEntrada({ categoria: "Running", nombre: "  Zapatillas   Pegasus 40 " });
    expect(entrada).toEqual({
      categoria: "Running",
      nombre: "Zapatillas Pegasus 40",
      detalle: "",
      desde: null,
    });
  });

  it("exige categoría y nombre, y lo dice con ejemplos", () => {
    expect(() => validarEntrada({ nombre: "Bastones" })).toThrow(/Falta 'categoria'/);
    expect(() => validarEntrada({ categoria: "¿?", nombre: "x" })).toThrow(/Falta 'categoria'/);
    expect(() => validarEntrada({ categoria: "Running" })).toThrow(/Falta 'nombre'/);
    expect(() => validarEntrada("zapatillas")).toThrow(/objeto/);
  });

  it("rechaza una fecha que no es fecha", () => {
    expect(() => validarEntrada({ categoria: "R", nombre: "x", desde: "ayer" })).toThrow(/YYYY-MM-DD/);
    expect(validarEntrada({ categoria: "R", nombre: "x", desde: "2026-02-10" }).desde).toBe("2026-02-10");
    expect(validarEntrada({ categoria: "R", nombre: "x", desde: "" }).desde).toBe(null);
  });
});

describe("resumenMaterial", () => {
  it("una línea por categoría con los nombres", () => {
    const texto = resumenMaterial([
      articulo({ id: 1, nombre: "Zapatillas Pegasus" }),
      articulo({ id: 2, nombre: "Bastones" }),
      articulo({ id: 3, categoriaEtiqueta: "Recuperación", nombre: "Pistola de masaje" }),
    ]).join("\n");
    expect(texto).toContain("MATERIAL DISPONIBLE (3):");
    expect(texto).toContain("Running: Zapatillas Pegasus, Bastones");
    expect(texto).toContain("Recuperación: Pistola de masaje");
  });

  it("con el inventario vacío manda preguntar en vez de callar", () => {
    // El modo de fallo que importa es recomendar material que no se tiene.
    const texto = resumenMaterial([]).join("\n");
    expect(texto).toContain("(vacío)");
    expect(texto).toContain("pregunta qué tiene");
  });
});
