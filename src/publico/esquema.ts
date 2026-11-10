/**
 * Lista blanca de lo que puede salir a la página pública.
 *
 * El JSON se compara entero contra esta forma ANTES de escribirse en KV. Una
 * clave que no esté aquí, un texto que no sea una fecha o una etiqueta
 * conocida, un número donde no toca: no se publica nada y el cron lo registra.
 * Es la única puerta: añadir un dato a la página obliga a describirlo aquí,
 * que es donde se ve si filtra algo.
 *
 * Los textos libres están prohibidos salvo los nombres de temporada (los
 * escribe el atleta con set_plan_publico y son públicos por diseño) y las
 * etiquetas de los hitos, que salen de una lista fija del código.
 */

import { HITOS } from "./compute";

type Forma =
  | "fecha"
  | "instante"
  | "numero"
  | "entero"
  | "booleano"
  | "nulo"
  | { texto: (valor: string) => boolean }
  | { uno: Forma[] }
  | { lista: Forma }
  | { objeto: Record<string, Forma> };

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const o = (campos: Record<string, Forma>): Forma => ({ objeto: campos });
const o_nulo = (forma: Forma): Forma => ({ uno: [forma, "nulo"] });

const ETIQUETAS_HITO = new Set<string>(HITOS.map((h) => h.etiqueta));
const CLAVES_HITO = new Set<string>(HITOS.map((h) => h.clave));
const etiquetaHito = (v: string) =>
  ETIQUETAS_HITO.has(v) || /^Más de (\d+(,\d)?|—) km$/.test(v);

const CATEGORIA = { texto: (v: string) => v === "carrera" || v === "fuerza" || v === "natacion" } as const;

const RECUENTO = o({ programadas: "entero", cumplidas: "entero", pct: o_nulo("entero") });

export const FORMA_PUBLICA: Forma = o({
  version: "entero",
  generado: "instante",
  datos_hasta: "fecha",
  dia_d: o({ fecha: "fecha", dias: "entero" }),
  temporadas: {
    lista: o({
      numero: "entero",
      nombre: { texto: (v) => v.length >= 1 && v.length <= 30 && !/[<>{}\\]/.test(v) },
      desde: "fecha",
      hasta: "fecha",
    }),
  },
  temporada_actual: o_nulo("entero"),
  semanas: {
    lista: o({
      lunes: "fecha",
      temporada: o_nulo("entero"),
      km: "numero",
      km_plan: o_nulo("numero"),
      km_max: "numero",
      programadas: "entero",
      cumplidas: "entero",
      en_curso: "booleano",
    }),
  },
  tirada_larga: o_nulo(o({ km: "numero", fecha: "fecha" })),
  referencia: o_nulo(o({ km: "numero", fecha: "fecha" })),
  hitos: {
    lista: o({
      clave: { texto: (v) => CLAVES_HITO.has(v) },
      etiqueta: { texto: etiquetaHito },
      km_objetivo: o_nulo("numero"),
      fecha: o_nulo("fecha"),
      km: o_nulo("numero"),
      manual: "booleano",
    }),
  },
  cumplimiento: o({ total: RECUENTO, desde_t1: o_nulo(RECUENTO), hasta: o_nulo("fecha") }),
  racha_semanas: o({ actual: "entero", mejor: "entero" }),
  // Sesiones de ayer: sin hora ni nombre. El pulso y la temperatura son una
  // decisión explícita del atleta (ver compute.ts).
  ayer: o_nulo(
    o({
      fecha: "fecha",
      sesiones: {
        lista: o({
          deporte: CATEGORIA,
          km: o_nulo("numero"),
          segundos: o_nulo("entero"),
          ritmo: o_nulo("entero"),
          fc_media: o_nulo("entero"),
          fc_max: o_nulo("entero"),
          temp: o_nulo("numero"),
        }),
      },
    }),
  ),
  semana_dias: o_nulo(
    o({ lunes: "fecha", dias: { lista: o({ fecha: "fecha", km: "numero", sesiones: { lista: CATEGORIA } }) } }),
  ),
  totales: o_nulo(o({ km: "numero", horas: "numero", sesiones: "entero", desde: "fecha" })),
  test_pulso_fijo: o_nulo(
    o({
      pulso: "entero",
      techo_z1: "entero",
      semanas: { lista: o({ lunes: "fecha", ritmo: "entero", sesiones: "entero", temp: o_nulo("numero") }) },
    }),
  ),
  prediccion: o_nulo(
    o({
      segundos: "entero",
      km_base: "numero",
      fecha_base: "fecha",
      exponente: "numero",
      semanas: { lista: o({ lunes: "fecha", segundos: "entero" }) },
    }),
  ),
  ruta: "nulo",
  live: "nulo",
  salud: "nulo",
});

function comprobar(valor: unknown, forma: Forma, ruta: string, errores: string[]): void {
  if (errores.length > 20) return;
  if (forma === "nulo") {
    if (valor !== null) errores.push(`${ruta}: tiene que ser null`);
    return;
  }
  if (forma === "fecha" || forma === "instante") {
    const patron = forma === "fecha" ? FECHA : INSTANTE;
    if (typeof valor !== "string" || !patron.test(valor)) errores.push(`${ruta}: no es ${forma}`);
    return;
  }
  if (forma === "numero" || forma === "entero") {
    const ok =
      typeof valor === "number" &&
      Number.isFinite(valor) &&
      (forma === "numero" || Number.isInteger(valor));
    if (!ok) errores.push(`${ruta}: no es ${forma}`);
    return;
  }
  if (forma === "booleano") {
    if (typeof valor !== "boolean") errores.push(`${ruta}: no es booleano`);
    return;
  }
  if ("texto" in forma) {
    if (typeof valor !== "string" || !forma.texto(valor)) {
      errores.push(`${ruta}: texto no permitido (${JSON.stringify(valor)?.slice(0, 40)})`);
    }
    return;
  }
  if ("uno" in forma) {
    for (const alternativa of forma.uno) {
      const propios: string[] = [];
      comprobar(valor, alternativa, ruta, propios);
      if (!propios.length) return;
    }
    errores.push(`${ruta}: no encaja en ninguna forma permitida`);
    return;
  }
  if ("lista" in forma) {
    if (!Array.isArray(valor)) {
      errores.push(`${ruta}: no es una lista`);
      return;
    }
    valor.forEach((item, i) => comprobar(item, forma.lista, `${ruta}[${i}]`, errores));
    return;
  }
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) {
    errores.push(`${ruta}: no es un objeto`);
    return;
  }
  const objeto = valor as Record<string, unknown>;
  for (const clave of Object.keys(objeto)) {
    if (!(clave in forma.objeto)) errores.push(`${ruta}.${clave}: clave no permitida`);
  }
  for (const [clave, sub] of Object.entries(forma.objeto)) {
    if (!(clave in objeto)) errores.push(`${ruta}.${clave}: falta`);
    else comprobar(objeto[clave], sub, `${ruta}.${clave}`, errores);
  }
}

/** Errores de forma; una lista vacía es lo único que autoriza a publicar. */
export function erroresPublicos(valor: unknown): string[] {
  const errores: string[] = [];
  comprobar(valor, FORMA_PUBLICA, "$", errores);
  return errores;
}
