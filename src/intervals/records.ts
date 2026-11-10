/**
 * Récords y máximos históricos a partir de las curvas de intervals.icu.
 * Port fiel de records.py del servidor anterior.
 *
 * Existe porque estimar la FC máxima leyendo actividades fila a fila es lento y
 * frágil: con una ventana corta se acaba tomando el máximo de una sola sesión
 * como si fuera el máximo del atleta. Aquí el barrido es explícito y el valor
 * viene siempre con la fecha y el id de la actividad que lo produjo.
 *
 * Dos fuentes, ninguna interpretada:
 *   · la lista de actividades da el `max_heartrate` de cada sesión;
 *   · `activity-hr-curves` y `activity-pace-curves` dan, por actividad, la mejor
 *     FC sostenida en cada duración y el mejor tiempo en cada distancia.
 * El máximo (o el mínimo, en tiempos) se calcula sobre esas filas y nada más.
 */

import * as fmt from "./format";
import type { JsonRecord } from "./client";

// Duraciones para la mejor FC media sostenida. 20 y 60 min son las que sirven
// para estimar el umbral, pero se piden todas de una vez porque cuestan igual.
export const HR_DURATIONS = [300, 600, 1200, 1800, 3600];

/** Distancias de las marcas pedidas, en metros (21,1 y 42,2 km incluidas). */
export const RACE_DISTANCES = [1000, 5000, 10000, 15000, 21100, 42200];

// Curva de ritmo: las de arriba más los tramos cortos, para que la curva tenga
// forma y no solo los seis puntos de competición.
export const CURVE_DISTANCES = [
  200, 400, 800, 1000, 1609, 3000, 5000, 10000, 15000, 21100, 42200,
];

export const WINDOWS = [30, 90, 365];

/** Campos que basta pedir de cada actividad para todo lo que calcula el módulo. */
export const ACTIVITY_FIELDS = [
  "id",
  "name",
  "type",
  "start_date_local",
  "max_heartrate",
  "average_heartrate",
  "distance",
  "moving_time",
  "total_elevation_gain",
];

/** Un récord: el valor, y de qué actividad salió. */
export interface Best {
  value: number;
  activityId: string;
  date: string;
}

export type ActividadConFC = JsonRecord & { _max_hr: number };

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(num) ? num : null;
}

function eje(payload: JsonRecord, names: string[]): number[] {
  const values = fmt.firstPresent(payload, names);
  if (!Array.isArray(values)) return [];
  return values.map((item) => asNumber(item) ?? Number.NaN);
}

function serie(curve: JsonRecord, names: string[]): unknown[] {
  const values = fmt.firstPresent(curve, names);
  return Array.isArray(values) ? values : [];
}

/**
 * Mejor valor de cada punto del eje, con la actividad que lo consiguió.
 *
 * `lowest=true` para tiempos (mejor = menor) y false para frecuencias cardiacas
 * (mejor = mayor). Los huecos se quedan en null: una actividad más corta que la
 * distancia pedida no puntúa, y eso no se rellena con nada.
 */
function mejores(
  payload: JsonRecord,
  axisNames: string[],
  valueNames: string[],
  lowest: boolean,
): [number[], Array<Best | null>] {
  const axis = eje(payload, axisNames);
  const best: Array<Best | null> = axis.map(() => null);
  const curves = payload.curves;
  if (!Array.isArray(curves)) return [axis, best];

  for (const curve of curves) {
    if (!curve || typeof curve !== "object" || Array.isArray(curve)) continue;
    const record = curve as JsonRecord;
    const activityId = String(record.id ?? "");
    const date = fmt.dateShort(record.start_date_local);
    serie(record, valueNames).forEach((raw, index) => {
      if (index >= axis.length || raw === null || raw === undefined) return;
      const value = asNumber(raw);
      if (value === null || value <= 0) return;
      const actual = best[index] ?? null;
      const mejora = actual === null || (lowest ? value < actual.value : value > actual.value);
      if (mejora) best[index] = { value, activityId, date };
    });
  }
  return [axis, best];
}

/** Mejor FC media sostenida en cada duración de la curva. */
export function mejorFcPorDuracion(payload: JsonRecord): [number[], Array<Best | null>] {
  return mejores(payload, ["secs"], ["bpm", "values"], false);
}

/** Mejor tiempo en cada distancia de la curva. */
export function mejorTiempoPorDistancia(payload: JsonRecord): [number[], Array<Best | null>] {
  return mejores(payload, ["distances", "distance"], ["secs", "values"], true);
}

/** Posición exacta de un punto del eje. Sin aproximar: o está o no está. */
export function indiceDe(axis: number[], target: number): number | null {
  for (let i = 0; i < axis.length; i++) {
    const value = axis[i]!;
    if (!Number.isNaN(value) && Math.abs(value - target) < 0.5) return i;
  }
  return null;
}

/**
 * Tiempo de UNA actividad concreta en una distancia. Sirve para el GAP: el GAP
 * de una marca tiene que salir de la misma actividad que puso la marca, no de la
 * que mejor GAP tenga, o se comparan dos carreras distintas.
 */
export function tiempoDe(
  payload: JsonRecord | null,
  activityId: string,
  meters: number,
): number | null {
  if (!payload) return null;
  const axis = eje(payload, ["distances", "distance"]);
  const index = indiceDe(axis, meters);
  if (index === null) return null;
  const curves = Array.isArray(payload.curves) ? payload.curves : [];
  for (const curve of curves) {
    if (!curve || typeof curve !== "object" || Array.isArray(curve)) continue;
    const record = curve as JsonRecord;
    if (String(record.id ?? "") !== activityId) continue;
    const values = serie(record, ["secs", "values"]);
    const seconds = asNumber(values[index]);
    return seconds !== null && seconds > 0 ? seconds : null;
  }
  return null;
}

export function etiquetaDuracion(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${Math.floor(seconds / 3600)} h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${Math.floor(seconds / 60)} min`;
  return `${Math.round(seconds)} s`;
}

export function etiquetaDistancia(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1).replace(/0$/, "").replace(/\.$/, "")} km`;
  }
  return `${Math.round(meters)} m`;
}

/** Actividades con FC máxima, de mayor a menor. */
export function maximosDeFc(activities: JsonRecord[]): ActividadConFC[] {
  const scored: ActividadConFC[] = [];
  for (const item of activities) {
    const bpm = asNumber(fmt.firstPresent(item, ["max_heartrate"]));
    if (bpm === null || bpm <= 0) continue;
    scored.push({ ...item, _max_hr: bpm });
  }
  scored.sort((a, b) => b._max_hr - a._max_hr);
  return scored;
}
