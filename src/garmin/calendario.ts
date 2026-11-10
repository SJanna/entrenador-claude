/**
 * El calendario de Garmin: qué hay escrito y qué día.
 *
 * Es la mitad que faltaba. Se podía escribir en Garmin y no leer lo escrito, y
 * eso rompe el protocolo de esta app: antes de programar hay que mirar qué hay,
 * y si lo que hay vive en Garmin, `list_events` de intervals.icu devuelve un
 * calendario vacío. Un calendario vacío que no lo está no es un hueco de
 * información: es una invitación a escribir la semana por segunda vez.
 *
 * Garmin sirve el calendario por MESES (y numerándolos desde 0), así que un
 * rango se traduce en una llamada por mes y luego se filtra por fecha.
 *
 * De la forma de esa respuesta no hay documentación, así que se lee con la
 * misma prudencia que los umbrales: se buscan las claves que suele traer y lo
 * que no se reconoce se deja fuera en vez de adivinarlo.
 */

import type { GarminCliente } from "./cliente";
import { listarActividades } from "./actividades";

export const MAX_MESES = 6;

export interface ItemCalendario {
  fecha: string;
  /** workout, activity, note… tal y como lo llama Garmin. */
  tipo: string;
  titulo: string;
  /** Id del entreno de la biblioteca, si el item es un entreno programado. */
  workoutId: number | null;
  /** Id de la programación, que es lo que hace falta para desprogramar. */
  scheduleId: number | null;
  /** Id de la actividad ya hecha, para pedirle el detalle y sus series. */
  activityId: number | null;
  deporte: string | null;
  duracionSegundos: number | null;
  /** Ya hecho: Garmin marca como completados los entrenos cumplidos. */
  completado: boolean;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

function numero(valor: unknown): number | null {
  if (valor === null || valor === undefined || typeof valor === "boolean") return null;
  const n = typeof valor === "number" ? valor : Number(valor);
  return Number.isFinite(n) ? n : null;
}

/**
 * La duración de un item del calendario, en segundos.
 *
 * Garmin la manda en MILISEGUNDOS para las actividades y en segundos para otras
 * cosas (las siestas). Leerlo mal no da error: el 16/09/2026 un paseo de hora y
 * media salía como «2479h50», que es absurdo pero es un número. El umbral son
 * 24 horas: nadie entrena un día entero, y lo que lo supere son milisegundos.
 */
function duracionDe(item: Record<string, unknown>): number | null {
  const bruto = numero(item.duration ?? item.estimatedDurationInSecs);
  if (bruto === null || bruto <= 0) return null;
  return bruto > 86_400 ? Math.round(bruto / 1000) : bruto;
}

/**
 * El deporte, que Garmin nombra distinto en cada tipo de item.
 *
 * Los entrenos traen `sportTypeKey`. Las actividades del calendario, no: el
 * 16/09/2026 salieron las cuarenta con «—» y un segundo intento buscando
 * cualquier clave acabada en `typeKey` tampoco las encontró. Lo que sí traen es
 * un `activityTypeId` numérico, y sin el catálogo de ids de Garmin ese número
 * no se puede convertir en un nombre sin inventárselo.
 *
 * Así que el nombre no se adivina: se le pregunta a Garmin. La lista de
 * actividades del mismo rango sí trae el deporte de cada una, y se cruza por id
 * (`completarDeportes`). Lo que no se pueda cruzar se queda como «tipo 13», que
 * es feo pero verdad. Para saber qué trae de verdad un item, la herramienta
 * acepta `debug: true`.
 */
function deporteDe(item: Record<string, unknown>): string | null {
  const directo =
    texto(item.sportTypeKey) ??
    texto((item.sportType as Record<string, unknown> | undefined)?.sportTypeKey) ??
    texto(item.activityType) ??
    texto((item.activityType as Record<string, unknown> | undefined)?.typeKey);
  if (directo) return directo;
  for (const [clave, valor] of Object.entries(item)) {
    if (/typeKey$/i.test(clave) && typeof valor === "string" && valor.trim()) {
      return valor.trim();
    }
  }
  const id = numero(item.activityTypeId ?? item.sportTypeId ?? item.typeId);
  return id === null ? null : `tipo ${id}`;
}

/** Fecha del item, mire donde mire Garmin. */
function fechaDe(item: Record<string, unknown>): string | null {
  for (const clave of ["date", "calendarDate", "scheduleDate", "startDate"]) {
    const valor = texto(item[clave]);
    if (valor && /^\d{4}-\d{2}-\d{2}/.test(valor)) return valor.slice(0, 10);
  }
  return null;
}

function normalizar(bruto: unknown): ItemCalendario | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const item = bruto as Record<string, unknown>;
  const fecha = fechaDe(item);
  if (!fecha) return null;
  const tipo = (texto(item.itemType) ?? texto(item.type) ?? "?").toLowerCase();
  // En una actividad, el `id` del item ES el id de la actividad. Enseñarlo en
  // la columna de programación manda a desprogramar algo que ya pasó.
  const suyo = numero(item.id ?? item.scheduleId ?? item.workoutScheduleId);
  const esActividad = tipo === "activity";
  return {
    fecha,
    tipo,
    activityId: esActividad ? (numero(item.activityId) ?? suyo) : numero(item.activityId),
    scheduleId: esActividad ? null : suyo,
    titulo: texto(item.title) ?? texto(item.workoutName) ?? texto(item.activityName) ?? "(sin nombre)",
    workoutId: numero(item.workoutId),
    deporte: deporteDe(item),
    duracionSegundos: duracionDe(item),
    completado: item.completed === true || item.isCompleted === true,
  };
}

/** Todos los items de un mes, vengan en la raíz o dentro de `calendarItems`. */
function itemsDe(cuerpo: unknown): unknown[] {
  if (Array.isArray(cuerpo)) return cuerpo;
  if (!cuerpo || typeof cuerpo !== "object") return [];
  const raiz = cuerpo as Record<string, unknown>;
  for (const clave of ["calendarItems", "items", "calendarItemList"]) {
    if (Array.isArray(raiz[clave])) return raiz[clave];
  }
  return [];
}

/** Los meses (year, month base 1) que cubre un rango de fechas. */
export function mesesEntre(desde: string, hasta: string): Array<[number, number]> {
  const meses: Array<[number, number]> = [];
  let año = Number(desde.slice(0, 4));
  let mes = Number(desde.slice(5, 7));
  const añoFin = Number(hasta.slice(0, 4));
  const mesFin = Number(hasta.slice(5, 7));
  while ((año < añoFin || (año === añoFin && mes <= mesFin)) && meses.length < MAX_MESES) {
    meses.push([año, mes]);
    mes += 1;
    if (mes > 12) {
      mes = 1;
      año += 1;
    }
  }
  return meses;
}

export interface Calendario {
  items: ItemCalendario[];
  /** Meses que no se pudieron leer, con su motivo. */
  fallos: string[];
  /** El rango pedido no cabía y se ha recortado. */
  recortado: boolean;
  /**
   * Qué claves trae un item de cada tipo. Solo los NOMBRES, nunca los valores:
   * sirve para saber dónde mirar cuando un campo sale vacío, sin volcar los
   * datos del atleta en una respuesta.
   */
  claves: Record<string, string[]>;
}

/**
 * Pone a cada actividad del calendario el nombre de su deporte, preguntándoselo
 * a la lista de actividades en vez de traducir el id por nuestra cuenta. Una
 * llamada más, y solo si hay actividades que completar.
 */
async function completarDeportes(
  cliente: GarminCliente,
  items: ItemCalendario[],
  desde: string,
  hasta: string,
): Promise<void> {
  const pendientes = items.filter(
    (i) => i.activityId !== null && (i.deporte === null || i.deporte.startsWith("tipo ")),
  );
  if (!pendientes.length) return;
  try {
    const actividades = await listarActividades(cliente, { limite: 50, desde, hasta });
    const porId = new Map(actividades.map((a) => [a.id, a.deporte]));
    for (const item of pendientes) {
      const deporte = porId.get(item.activityId!);
      if (deporte && deporte !== "—") item.deporte = deporte;
    }
  } catch {
    // Si la lista no se puede leer, cada actividad se queda con su «tipo N»:
    // menos legible, pero cierto.
  }
}

export async function leerCalendario(
  cliente: GarminCliente,
  desde: string,
  hasta: string,
): Promise<Calendario> {
  const meses = mesesEntre(desde, hasta);
  const recortado = mesesEntre(desde, hasta).length === MAX_MESES;
  const fallos: string[] = [];
  const items: ItemCalendario[] = [];
  const claves: Record<string, string[]> = {};

  for (const [año, mes] of meses) {
    try {
      // Garmin numera los meses desde 0. Un mes de desfase aquí devuelve un
      // calendario ajeno que parece el bueno.
      const respuesta = await cliente.api(`/calendar-service/year/${año}/month/${mes - 1}`);
      if (respuesta.status === 204 || respuesta.status === 404) {
        await respuesta.body?.cancel();
        continue;
      }
      const cuerpo = await respuesta.text();
      if (!respuesta.ok) {
        fallos.push(`${año}-${String(mes).padStart(2, "0")} (${respuesta.status})`);
        continue;
      }
      if (!cuerpo.trim()) continue;
      for (const bruto of itemsDe(JSON.parse(cuerpo))) {
        const item = normalizar(bruto);
        if (!item || item.fecha < desde || item.fecha > hasta) continue;
        items.push(item);
        if (!claves[item.tipo] && bruto && typeof bruto === "object") {
          claves[item.tipo] = Object.keys(bruto as Record<string, unknown>).sort();
        }
      }
    } catch (exc) {
      fallos.push(
        `${año}-${String(mes).padStart(2, "0")} (${exc instanceof Error ? exc.message : String(exc)})`,
      );
    }
  }

  await completarDeportes(cliente, items, desde, hasta);
  items.sort((a, b) => (a.fecha === b.fecha ? a.titulo.localeCompare(b.titulo) : a.fecha.localeCompare(b.fecha)));
  return { items, fallos, recortado, claves };
}

function duracion(segundos: number | null): string {
  if (segundos === null || segundos <= 0) return "—";
  const h = Math.floor(segundos / 3600);
  const m = Math.round((segundos % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m} min`;
}

export function formatearCalendario(
  calendario: Calendario,
  desde: string,
  hasta: string,
  diagnostico = false,
): string {
  const lineas: string[] = [];
  if (!calendario.items.length) {
    lineas.push(`El calendario de Garmin está vacío entre ${desde} y ${hasta}.`);
  } else {
    lineas.push(
      `Calendario de Garmin entre ${desde} y ${hasta} (${calendario.items.length} entradas):`,
      "fecha        tipo      id entreno    programación   id actividad  duración  " +
        "deporte            título",
      ...calendario.items.map((i) =>
        [
          i.fecha,
          (i.completado ? "✓" : " ") + i.tipo.padEnd(8).slice(0, 8),
          String(i.workoutId ?? "—").padStart(11),
          String(i.scheduleId ?? "—").padStart(14),
          String(i.activityId ?? "—").padStart(13),
          duracion(i.duracionSegundos).padStart(9),
          (i.deporte ?? "—").padEnd(18).slice(0, 18),
          i.titulo,
        ].join(" "),
      ),
      "",
      "«✓» es lo que Garmin da por hecho. «id entreno» vuelve a programarlo o lo borra; " +
        "«programación» es esta cita concreta y sirve para quitarla del calendario; " +
        "«id actividad» es una sesión ya hecha, y con él garmin_activity da sus series.",
    );
  }

  if (calendario.recortado) {
    lineas.push(
      "",
      `El rango se ha recortado a ${MAX_MESES} meses: Garmin sirve el calendario mes a mes.`,
    );
  }
  if (calendario.fallos.length) {
    lineas.push("", `No se pudieron leer estos meses: ${calendario.fallos.join(", ")}.`);
  }
  if (diagnostico) {
    lineas.push("", "Claves que trae Garmin en cada tipo de item (solo los nombres):");
    for (const [tipo, nombres] of Object.entries(calendario.claves)) {
      lineas.push(`  ${tipo}: ${nombres.join(", ")}`);
    }
  }

  lineas.push(
    "",
    "Esto NO se ve en list_events (intervals.icu): son dos calendarios distintos. " +
      "Antes de programar, mira los dos.",
  );
  return lineas.join("\n");
}
