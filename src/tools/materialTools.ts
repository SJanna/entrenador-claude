/**
 * Herramientas MCP del inventario: qué material tiene el atleta y para qué.
 *
 * El caso que las justifica: cuando se pide "terapia para una lesión", la
 * diferencia entre una recomendación aplicable y una genérica es saber si hay
 * pistola de masaje, bandas y hielo, o solo una pelota de tenis. Por eso el
 * resumen por categorías se cuela también en get_contract: prescribir sin mirar
 * el inventario es adivinar, y con el resumen delante ya no hay excusa.
 */

import {
  MaterialStore,
  validarEntrada,
  type Articulo,
  type EstadoMaterial,
} from "../material/store";

/** Agrupa por categoría conservando el orden en que vienen (categoría, nombre). */
function porCategoria(articulos: Articulo[]): Array<[string, Articulo[]]> {
  const grupos = new Map<string, Articulo[]>();
  for (const item of articulos) {
    const grupo = grupos.get(item.categoriaEtiqueta) ?? [];
    grupo.push(item);
    grupos.set(item.categoriaEtiqueta, grupo);
  }
  return [...grupos.entries()];
}

function lineaArticulo(item: Articulo): string {
  const bits = [`#${item.id}`, item.nombre];
  let linea = bits.join(" ");
  if (item.detalle) linea += ` — ${item.detalle}`;
  if (item.desde) linea += ` · desde ${item.desde}`;
  return `  ${linea}`;
}

/**
 * Resumen de una línea por categoría con los nombres. Va dentro de
 * get_contract: cabe en tres líneas y evita prescribir material que no existe.
 */
export function resumenMaterial(articulos: Articulo[]): string[] {
  if (!articulos.length) {
    return [
      "",
      "MATERIAL: (vacío) — nada registrado todavía. Antes de recomendar material, " +
        "pregunta qué tiene y anótalo con set_material en vez de suponerlo.",
    ];
  }
  const out = ["", `MATERIAL DISPONIBLE (${articulos.length}):`];
  for (const [categoria, items] of porCategoria(articulos)) {
    out.push(`${categoria}: ${items.map((i) => i.nombre).join(", ")}`);
  }
  out.push("Detalle (para qué sirve cada cosa) con get_material.");
  return out;
}

export class MaterialTools {
  constructor(private store: MaterialStore) {}

  private async guard(fn: () => Promise<string>, name: string): Promise<string> {
    try {
      return await fn();
    } catch (exc) {
      if (exc instanceof Error) return `Error: ${exc.message}`;
      return `Error inesperado en ${name}: ${String(exc)}`;
    }
  }

  getMaterial(categoria: unknown = null, incluirRetirados: unknown = false): Promise<string> {
    return this.guard(async () => {
      const filtro = categoria === null || categoria === undefined ? null : String(categoria);
      const articulos = await this.store.listar({
        categoria: filtro,
        incluirRetirados: !!incluirRetirados,
      });

      if (!articulos.length) {
        const categorias = await this.store.categorias();
        if (filtro && categorias.length) {
          return (
            `No hay material en la categoría '${filtro}'. Categorías con algo: ` +
            `${categorias.map((c) => `${c.etiqueta} (${c.disponibles})`).join(" · ")}.`
          );
        }
        return (
          "El inventario está vacío. Antes de recomendar material, pregunta qué tiene " +
          "el atleta y anótalo con set_material: recomendar sobre material supuesto es " +
          "prescribir a ciegas."
        );
      }

      const disponibles = articulos.filter((a) => a.estado === "disponible");
      const retirados = articulos.filter((a) => a.estado === "retirado");
      const out = [
        `[MATERIAL] ${disponibles.length} cosas disponibles` +
          (filtro ? ` en '${filtro}'` : ` en ${porCategoria(disponibles).length} categorías`) +
          (retirados.length ? ` · ${retirados.length} retiradas` : ""),
        "El '#' es el id: se usa para modificar o retirar con set_material.",
      ];

      for (const [categoria, items] of porCategoria(disponibles)) {
        out.push("", `${categoria} (${items.length}):`);
        for (const item of items) out.push(lineaArticulo(item));
      }

      if (retirados.length) {
        out.push(
          "",
          `Retirados (${retirados.length}) — ya no se usan, pero explican el pasado:`,
          ...retirados.map((i) => `  #${i.id} ${i.nombre} (${i.categoriaEtiqueta})`),
        );
      }
      return out.join("\n");
    }, "get_material");
  }

  setMaterial(articulos: unknown, ahora: string): Promise<string> {
    return this.guard(async () => {
      if (!Array.isArray(articulos) || !articulos.length) {
        throw new Error(
          "'articulos' es una lista con al menos un elemento. Alta o cambio: " +
            '{"accion": "añadir", "categoria": "recuperación", "nombre": "pistola de masaje", ' +
            '"detalle": "para qué te sirve"}. Sobre algo que ya existe: ' +
            '{"accion": "retirar"|"reactivar"|"editar", "id": 3, …}.',
        );
      }

      const resumen: string[] = [];
      for (const bruto of articulos) {
        if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) {
          throw new Error("Cada elemento de 'articulos' es un objeto con su 'accion'.");
        }
        const item = bruto as Record<string, unknown>;
        const accion = String(item.accion ?? "añadir").trim().toLowerCase();

        if (accion === "añadir" || accion === "anadir" || accion === "actualizar") {
          const { articulo, creado } = await this.store.guardar(validarEntrada(item), ahora);
          resumen.push(
            `${creado ? "añadido" : "actualizado"} #${articulo.id} ${articulo.nombre} ` +
              `(${articulo.categoriaEtiqueta})`,
          );
          continue;
        }

        const id = parseInt(String(item.id ?? ""), 10);
        if (!Number.isFinite(id)) {
          throw new Error(
            `La acción '${accion}' necesita el 'id' del artículo (la columna '#' de get_material).`,
          );
        }

        if (accion === "retirar" || accion === "reactivar") {
          const estado: EstadoMaterial = accion === "retirar" ? "retirado" : "disponible";
          const articulo = await this.store.cambiarEstado(id, estado, ahora);
          resumen.push(`${accion === "retirar" ? "retirado" : "reactivado"} #${id} ${articulo.nombre}`);
          continue;
        }

        if (accion === "editar") {
          const articulo = await this.store.editar(
            id,
            {
              nombre: item.nombre === undefined ? undefined : String(item.nombre),
              detalle: item.detalle === undefined ? undefined : String(item.detalle),
              categoria: item.categoria === undefined ? undefined : String(item.categoria),
              desde: item.desde === undefined ? undefined : (item.desde === null ? null : String(item.desde)),
            },
            ahora,
          );
          resumen.push(`editado #${id} ${articulo.nombre} (${articulo.categoriaEtiqueta})`);
          continue;
        }

        throw new Error(
          `Acción '${accion}' no reconocida. Son: añadir, actualizar, editar, retirar, reactivar.`,
        );
      }

      const total = (await this.store.listar()).length;
      return [
        `Material actualizado (${resumen.length} ${resumen.length === 1 ? "cambio" : "cambios"}):`,
        ...resumen.map((r) => `  ${r}`),
        "",
        `El inventario queda con ${total} cosas disponibles.`,
      ].join("\n");
    }, "set_material");
  }
}
