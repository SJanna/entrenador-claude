/**
 * Diario subjetivo en D1: campos declarados por el atleta y su valor por día.
 *
 * La regla que gobierna el módulo: **un campo sin declarar no se escribe**. Es
 * lo contrario de lo que hace intervals.icu con sus campos personalizados, que
 * descarta en silencio lo que no reconoce, y es justo el motivo de que esto
 * viva aquí: una errata en el nombre tiene que dar error, no crear una serie
 * paralela que luego parezca un hueco de datos.
 */

import { normalizarClave } from "../claves";

export { normalizarClave };

export type TipoCampo = "numero" | "si_no" | "texto";

export const TIPOS: TipoCampo[] = ["numero", "si_no", "texto"];

export interface CampoDiario {
  campo: string;
  etiqueta: string;
  tipo: TipoCampo;
  minimo: number | null;
  maximo: number | null;
  descripcion: string;
}

/** Un valor ya validado, listo para la base. */
export interface ValorDiario {
  campo: string;
  valor: number | null;
  texto: string | null;
}

/** Lo guardado de un día: campo → valor. */
export type DiaDiario = Map<string, ValorDiario>;

/**
 * Comprueba un valor contra la declaración de su campo. Devuelve las dos
 * columnas de la tabla (numérica y de texto) para no repetir el `switch` en
 * cada llamante.
 */
export function validarValor(campo: CampoDiario, valor: unknown): ValorDiario {
  if (valor === null || valor === undefined || valor === "") {
    return { campo: campo.campo, valor: null, texto: null };
  }

  if (campo.tipo === "texto") {
    return { campo: campo.campo, valor: null, texto: String(valor) };
  }

  if (campo.tipo === "si_no") {
    const si = valor === true || valor === 1 || /^(1|si|sí|true|yes)$/i.test(String(valor));
    const no = valor === false || valor === 0 || /^(0|no|false)$/i.test(String(valor));
    if (!si && !no) {
      throw new Error(
        `'${campo.campo}' es un campo de sí/no: pasa true/false (o 1/0), no ${JSON.stringify(valor)}.`,
      );
    }
    return { campo: campo.campo, valor: si ? 1 : 0, texto: null };
  }

  const num = typeof valor === "number" ? valor : parseFloat(String(valor));
  if (!Number.isFinite(num)) {
    throw new Error(`'${campo.campo}' es numérico y ${JSON.stringify(valor)} no es un número.`);
  }
  if (campo.minimo !== null && num < campo.minimo) {
    throw new Error(
      `'${campo.campo}' va de ${campo.minimo} a ${campo.maximo ?? "sin tope"} y has pasado ${num}.`,
    );
  }
  if (campo.maximo !== null && num > campo.maximo) {
    throw new Error(
      `'${campo.campo}' va de ${campo.minimo ?? "sin tope"} a ${campo.maximo} y has pasado ${num}.`,
    );
  }
  return { campo: campo.campo, valor: num, texto: null };
}

/**
 * Cabeceras fijas de la tabla de get_wellness: una etiqueta del diario no puede
 * pisar ninguna o no habría forma de saber cuál de las dos columnas es cuál.
 */
export const COLUMNAS_BIENESTAR = new Set([
  "fecha", "sueño", "prof/lig/REM", "punt", "HRV", "FCrep",
  "BB", "Prep", "peso", "pasos", "CTL", "ATL", "TSB",
]);

/** "0-10" / "sí/no": cómo se resume la escala de un campo. */
export function descripcionEscala(campo: CampoDiario): string {
  if (campo.tipo === "si_no") return "sí/no";
  if (campo.tipo === "texto") return "texto";
  if (campo.minimo === null && campo.maximo === null) return "número";
  return `${campo.minimo ?? "sin tope"}-${campo.maximo ?? "sin tope"}`;
}

/**
 * Valida una lista de declaraciones de campo. Vive aquí, y no en la
 * herramienta MCP, porque el panel web declara campos por su cuenta: las dos
 * puertas de entrada tienen que aceptar y rechazar exactamente lo mismo.
 */
export function parsearDefiniciones(valor: unknown): CampoDiario[] {
  if (!Array.isArray(valor)) {
    throw new Error(
      "'definir' es una lista de campos a declarar, p. ej. " +
        '[{"campo": "dolor_lesion", "tipo": "numero", "minimo": 0, "maximo": 10}].',
    );
  }
  return valor.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Cada elemento de 'definir' es un objeto con al menos 'campo' y 'tipo'.");
    }
    const bruto = item as Record<string, unknown>;
    const campo = normalizarClave(bruto.campo);
    if (!campo) {
      throw new Error(
        `Falta 'campo' en una definición (recibido ${JSON.stringify(bruto.campo)}). ` +
          "Es la clave con la que lo escribirás cada día.",
      );
    }
    const tipo = String(bruto.tipo ?? "numero").trim().toLowerCase() as TipoCampo;
    if (!TIPOS.includes(tipo)) {
      throw new Error(`'tipo' de '${campo}' debe ser uno de: ${TIPOS.join(", ")}.`);
    }
    const etiqueta = String(bruto.etiqueta ?? campo).trim() || campo;
    if (COLUMNAS_BIENESTAR.has(etiqueta)) {
      throw new Error(
        `La etiqueta '${etiqueta}' ya es una columna de bienestar ` +
          `(${[...COLUMNAS_BIENESTAR].join(", ")}). Ponle otra a '${campo}'.`,
      );
    }
    const minimo = numeroONulo(bruto.minimo);
    const maximo = numeroONulo(bruto.maximo);
    if (minimo !== null && maximo !== null && minimo > maximo) {
      throw new Error(`En '${campo}', 'minimo' (${minimo}) es mayor que 'maximo' (${maximo}).`);
    }
    return {
      campo,
      etiqueta,
      tipo,
      minimo: tipo === "numero" ? minimo : null,
      maximo: tipo === "numero" ? maximo : null,
      descripcion: String(bruto.descripcion ?? "").trim(),
    };
  });
}

function numeroONulo(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const num = typeof valor === "number" ? valor : parseFloat(String(valor));
  return Number.isFinite(num) ? num : null;
}

/** Cómo se enseña un valor en una tabla, según el tipo de su campo. */
export function formatearValor(campo: CampoDiario | undefined, valor: ValorDiario | undefined): string {
  if (!valor || (valor.valor === null && valor.texto === null)) return "—";
  if (valor.texto !== null) return valor.texto;
  if (campo?.tipo === "si_no") return valor.valor ? "sí" : "no";
  const num = valor.valor ?? 0;
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
}

interface FilaCampo {
  campo: string;
  etiqueta: string;
  tipo: string;
  minimo: number | null;
  maximo: number | null;
  descripcion: string;
}

interface FilaValor {
  fecha: string;
  campo: string;
  valor: number | null;
  texto: string | null;
}

function aCampo(fila: FilaCampo): CampoDiario {
  return {
    campo: fila.campo,
    etiqueta: fila.etiqueta,
    tipo: (TIPOS.includes(fila.tipo as TipoCampo) ? fila.tipo : "numero") as TipoCampo,
    minimo: fila.minimo,
    maximo: fila.maximo,
    descripcion: fila.descripcion ?? "",
  };
}

export class DiarioStore {
  constructor(private db: D1Database) {}

  /** Los campos declarados, en orden de creación (el más antiguo primero). */
  async campos(): Promise<CampoDiario[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM diario_campos ORDER BY creado_en, campo")
      .all<FilaCampo>();
    return (results ?? []).map(aCampo);
  }

  /**
   * Declara un campo nuevo o actualiza su etiqueta, escala y descripción.
   *
   * La etiqueta tiene que ser única entre campos: es la cabecera con la que
   * salen en la tabla de bienestar, y dos columnas llamadas igual no hay forma
   * de distinguirlas. La comprobación vive aquí y no en la validación pura
   * porque hace falta saber qué campos existen ya.
   */
  async definir(campo: CampoDiario, ahora: string): Promise<void> {
    const choque = await this.db
      .prepare("SELECT campo FROM diario_campos WHERE etiqueta = ?1 AND campo <> ?2")
      .bind(campo.etiqueta, campo.campo)
      .first<{ campo: string }>();
    if (choque) {
      throw new Error(
        `La etiqueta '${campo.etiqueta}' ya la usa el campo '${choque.campo}'. ` +
          `Ponle otra a '${campo.campo}' o serán dos columnas iguales en la tabla.`,
      );
    }
    await this.db
      .prepare(
        `INSERT INTO diario_campos (campo, etiqueta, tipo, minimo, maximo, descripcion, creado_en)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(campo) DO UPDATE SET
           etiqueta = ?2, tipo = ?3, minimo = ?4, maximo = ?5, descripcion = ?6`,
      )
      .bind(
        campo.campo,
        campo.etiqueta,
        campo.tipo,
        campo.minimo,
        campo.maximo,
        campo.descripcion,
        ahora,
      )
      .run();
  }

  /**
   * Escribe los valores de un día. Idempotente por (fecha, campo): registrar
   * dos veces el mismo día corrige el valor, no lo duplica. Un valor vacío
   * borra la medición en vez de guardar un cero, que no es lo mismo que "no lo
   * apunté".
   */
  async escribir(fecha: string, valores: ValorDiario[], ahora: string): Promise<void> {
    if (!valores.length) return;
    const escribe = this.db.prepare(
      `INSERT INTO diario (fecha, campo, valor, texto, actualizado_en)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(fecha, campo) DO UPDATE SET
         valor = ?3, texto = ?4, actualizado_en = ?5`,
    );
    const borra = this.db.prepare("DELETE FROM diario WHERE fecha = ?1 AND campo = ?2");
    await this.db.batch(
      valores.map((v) =>
        v.valor === null && v.texto === null
          ? borra.bind(fecha, v.campo)
          : escribe.bind(fecha, v.campo, v.valor, v.texto, ahora),
      ),
    );
  }

  /** Lo guardado entre dos fechas, indexado por día. */
  async leer(desde: string, hasta: string): Promise<Map<string, DiaDiario>> {
    const dias = new Map<string, DiaDiario>();
    if (desde > hasta) return dias;
    const { results } = await this.db
      .prepare("SELECT * FROM diario WHERE fecha >= ?1 AND fecha <= ?2 ORDER BY fecha")
      .bind(desde, hasta)
      .all<FilaValor>();
    for (const fila of results ?? []) {
      const dia = dias.get(fila.fecha) ?? new Map<string, ValorDiario>();
      dia.set(fila.campo, { campo: fila.campo, valor: fila.valor, texto: fila.texto });
      dias.set(fila.fecha, dia);
    }
    return dias;
  }
}
