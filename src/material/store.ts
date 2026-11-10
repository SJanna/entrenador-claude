/**
 * Inventario de material en D1: qué tiene el atleta, por categorías.
 *
 * Dos reglas que gobiernan el módulo:
 *
 * - **Las categorías se normalizan.** "Recuperación", "recuperacion" y
 *   "RECUPERACIÓN" son la misma. Si se fragmentaran, pedir el material de una
 *   categoría devolvería media estantería con pinta de estantería entera, que
 *   es peor que no devolver nada.
 * - **Nada se borra, se retira.** Unas zapatillas gastadas siguen explicando
 *   los entrenos de hace seis meses. El alta de algo que ya existe lo
 *   actualiza (y lo reactiva) en vez de duplicarlo.
 */

import { normalizarClave } from "../claves";

export type EstadoMaterial = "disponible" | "retirado";

export interface Articulo {
  id: number;
  categoria: string;
  categoriaEtiqueta: string;
  nombre: string;
  detalle: string;
  estado: EstadoMaterial;
  desde: string | null;
  actualizadoEn: string;
}

/** Lo que hace falta para dar de alta o modificar un artículo. */
export interface EntradaMaterial {
  categoria: string;
  nombre: string;
  detalle?: string;
  desde?: string | null;
}

export interface CategoriaMaterial {
  categoria: string;
  etiqueta: string;
  disponibles: number;
  retirados: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface FilaMaterial {
  id: number;
  categoria: string;
  categoria_etiqueta: string;
  nombre: string;
  detalle: string;
  estado: string;
  desde: string | null;
  actualizado_en: string;
}

function aArticulo(fila: FilaMaterial): Articulo {
  return {
    id: fila.id,
    categoria: fila.categoria,
    categoriaEtiqueta: fila.categoria_etiqueta,
    nombre: fila.nombre,
    detalle: fila.detalle ?? "",
    estado: fila.estado === "retirado" ? "retirado" : "disponible",
    desde: fila.desde,
    actualizadoEn: fila.actualizado_en,
  };
}

/**
 * Valida una entrada suelta. Pura a propósito: la usan la herramienta MCP y el
 * panel, y las dos tienen que aceptar y rechazar exactamente lo mismo.
 */
export function validarEntrada(bruto: unknown): EntradaMaterial {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) {
    throw new Error("Cada artículo es un objeto con al menos 'categoria' y 'nombre'.");
  }
  const item = bruto as Record<string, unknown>;
  const etiqueta = String(item.categoria ?? "").trim();
  if (!normalizarClave(etiqueta)) {
    throw new Error(
      `Falta 'categoria' (recibido ${JSON.stringify(item.categoria)}). Es cómo se agrupa: ` +
        "running, fuerza, recuperación… La eliges tú, no hay lista cerrada.",
    );
  }
  const nombre = String(item.nombre ?? "").split(/\s+/).join(" ").trim();
  if (!nombre) {
    throw new Error(`Falta 'nombre' del artículo en la categoría '${etiqueta}'.`);
  }
  const desde = item.desde === null || item.desde === undefined || item.desde === ""
    ? null
    : String(item.desde).slice(0, 10);
  if (desde !== null && !DATE_RE.test(desde)) {
    throw new Error(`'desde' de '${nombre}' debe ser una fecha YYYY-MM-DD (recibido ${JSON.stringify(item.desde)}).`);
  }
  return {
    categoria: etiqueta,
    nombre,
    detalle: String(item.detalle ?? "").trim(),
    desde,
  };
}

export class MaterialStore {
  constructor(private db: D1Database) {}

  /** El inventario, ordenado por categoría y nombre. Sin retirados por defecto. */
  async listar(
    opts: { categoria?: string | null; incluirRetirados?: boolean } = {},
  ): Promise<Articulo[]> {
    const clave = opts.categoria ? normalizarClave(opts.categoria) : null;
    const condiciones: string[] = [];
    const binds: unknown[] = [];
    if (clave) {
      condiciones.push(`categoria = ?${binds.length + 1}`);
      binds.push(clave);
    }
    if (!opts.incluirRetirados) condiciones.push("estado = 'disponible'");
    const where = condiciones.length ? ` WHERE ${condiciones.join(" AND ")}` : "";
    const { results } = await this.db
      .prepare(
        `SELECT * FROM material${where} ORDER BY categoria_etiqueta, estado, nombre`,
      )
      .bind(...binds)
      .all<FilaMaterial>();
    return (results ?? []).map(aArticulo);
  }

  /** Categorías con cuántas cosas hay en cada una. Para el resumen del contrato. */
  async categorias(): Promise<CategoriaMaterial[]> {
    const { results } = await this.db
      .prepare(
        `SELECT categoria, categoria_etiqueta AS etiqueta,
                SUM(CASE WHEN estado = 'disponible' THEN 1 ELSE 0 END) AS disponibles,
                SUM(CASE WHEN estado = 'retirado' THEN 1 ELSE 0 END) AS retirados
           FROM material GROUP BY categoria, categoria_etiqueta ORDER BY categoria_etiqueta`,
      )
      .all<CategoriaMaterial>();
    return results ?? [];
  }

  /**
   * Alta o actualización por (categoría, nombre). Devuelve si era nuevo, para
   * que quien llame pueda decir «añadido» o «actualizado» sin adivinarlo.
   *
   * Reaparecer algo retirado lo vuelve a poner disponible: es lo que significa
   * volver a darlo de alta, y evita tener que inventarle un nombre distinto.
   */
  async guardar(entrada: EntradaMaterial, ahora: string): Promise<{ articulo: Articulo; creado: boolean }> {
    const categoria = normalizarClave(entrada.categoria);
    // La etiqueta de una categoría la fija quien la crea primero: así no cambia
    // sola porque alguien la escriba distinto la segunda vez.
    const existenteCat = await this.db
      .prepare("SELECT categoria_etiqueta AS etiqueta FROM material WHERE categoria = ?1 LIMIT 1")
      .bind(categoria)
      .first<{ etiqueta: string }>();
    const etiqueta = existenteCat?.etiqueta ?? entrada.categoria;

    const previo = await this.db
      .prepare("SELECT * FROM material WHERE categoria = ?1 AND nombre = ?2")
      .bind(categoria, entrada.nombre)
      .first<FilaMaterial>();

    if (previo) {
      await this.db
        .prepare(
          `UPDATE material SET detalle = ?1, desde = ?2, estado = 'disponible',
                               actualizado_en = ?3 WHERE id = ?4`,
        )
        // Un alta sin detalle no borra el detalle que ya había: se actualiza lo
        // que se trae, no lo que se calla.
        .bind(entrada.detalle || previo.detalle, entrada.desde ?? previo.desde, ahora, previo.id)
        .run();
      const fila = await this.porId(previo.id);
      return { articulo: fila!, creado: false };
    }

    const insertado = await this.db
      .prepare(
        `INSERT INTO material
           (categoria, categoria_etiqueta, nombre, detalle, estado, desde, creado_en, actualizado_en)
         VALUES (?1, ?2, ?3, ?4, 'disponible', ?5, ?6, ?6) RETURNING *`,
      )
      .bind(categoria, etiqueta, entrada.nombre, entrada.detalle ?? "", entrada.desde ?? null, ahora)
      .first<FilaMaterial>();
    return { articulo: aArticulo(insertado!), creado: true };
  }

  async porId(id: number): Promise<Articulo | null> {
    const fila = await this.db
      .prepare("SELECT * FROM material WHERE id = ?1")
      .bind(id)
      .first<FilaMaterial>();
    return fila ? aArticulo(fila) : null;
  }

  /** Retira o reactiva. No hay borrado: lo retirado sigue explicando el pasado. */
  async cambiarEstado(id: number, estado: EstadoMaterial, ahora: string): Promise<Articulo> {
    const antes = await this.porId(id);
    if (!antes) {
      throw new Error(`No existe el artículo ${id}. Míralos con get_material.`);
    }
    await this.db
      .prepare("UPDATE material SET estado = ?1, actualizado_en = ?2 WHERE id = ?3")
      .bind(estado, ahora, id)
      .run();
    return { ...antes, estado, actualizadoEn: ahora };
  }

  /** Cambia campos sueltos de un artículo ya existente. */
  async editar(
    id: number,
    cambios: { nombre?: string; detalle?: string; categoria?: string; desde?: string | null },
    ahora: string,
  ): Promise<Articulo> {
    const antes = await this.porId(id);
    if (!antes) {
      throw new Error(`No existe el artículo ${id}. Míralos con get_material.`);
    }
    const nombre = cambios.nombre?.trim() || antes.nombre;
    const categoriaEtiqueta = cambios.categoria?.trim() || antes.categoriaEtiqueta;
    const categoria = normalizarClave(categoriaEtiqueta);
    const choque = await this.db
      .prepare("SELECT id FROM material WHERE categoria = ?1 AND nombre = ?2 AND id <> ?3")
      .bind(categoria, nombre, id)
      .first<{ id: number }>();
    if (choque) {
      throw new Error(
        `Ya hay otro '${nombre}' en '${categoriaEtiqueta}' (id ${choque.id}): serían dos filas iguales.`,
      );
    }
    await this.db
      .prepare(
        `UPDATE material SET categoria = ?1, categoria_etiqueta = ?2, nombre = ?3,
                             detalle = ?4, desde = ?5, actualizado_en = ?6 WHERE id = ?7`,
      )
      .bind(
        categoria,
        categoriaEtiqueta,
        nombre,
        cambios.detalle === undefined ? antes.detalle : String(cambios.detalle).trim(),
        cambios.desde === undefined ? antes.desde : cambios.desde,
        ahora,
        id,
      )
      .run();
    return (await this.porId(id))!;
  }
}
