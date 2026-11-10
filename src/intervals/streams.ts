/**
 * Series punto a punto de una actividad: normalización, remuestreo y desnivel.
 *
 * Dos decisiones que gobiernan todo el módulo:
 *
 * - **El desnivel se acumula con umbral.** El barómetro tiene ruido de décimas
 *   de metro y sumar cada subida punto a punto convierte una llanura en cientos
 *   de metros falsos. Solo cuenta un cambio cuando se aleja `umbralM` del último
 *   punto de referencia (histéresis).
 * - **Un tramo remuestreado se agrega, no se muestrea.** El ritmo de un tramo es
 *   su distancia entre su tiempo, y la FC su media: coger el valor instantáneo
 *   del último punto daría una serie llena de picos del sensor.
 */

export type Serie = (number | null)[];
export type Series = Map<string, Serie>;

/** Un tramo remuestreado, por índices sobre las series originales. */
export interface Tramo {
  desde: number;
  hasta: number;
}

export interface Desnivel {
  subida: number;
  bajada: number;
}

/** Umbral por defecto del acumulador de desnivel, en metros. */
export const UMBRAL_DESNIVEL_M = 1;

function numeroONulo(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(num) ? num : null;
}

/**
 * Convierte la respuesta de /activity/{id}/streams (lista de {type, data}) en un
 * mapa tipo → serie numérica. Las series que no son de números sueltos (latlng)
 * se descartan: aquí no sirven y ocuparían memoria.
 */
export function indexarSeries(payload: unknown): Series {
  const series: Series = new Map();
  if (!Array.isArray(payload)) return series;
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const tipo = String(record.type ?? "").trim();
    if (!tipo || record.valueTypeIsArray === true || record.allNull === true) continue;
    if (!Array.isArray(record.data)) continue;
    series.set(tipo, record.data.map(numeroONulo));
  }
  return series;
}

/** Último valor no nulo de la serie en [desde, hasta], o null. */
export function ultimoValor(serie: Serie | undefined, desde: number, hasta: number): number | null {
  if (!serie) return null;
  for (let i = Math.min(hasta, serie.length - 1); i >= Math.max(0, desde); i--) {
    const valor = serie[i];
    if (valor !== null && valor !== undefined) return valor;
  }
  return null;
}

/** Primer valor no nulo de la serie en [desde, hasta], o null. */
export function primerValor(serie: Serie | undefined, desde: number, hasta: number): number | null {
  if (!serie) return null;
  for (let i = Math.max(0, desde); i <= Math.min(hasta, serie.length - 1); i++) {
    const valor = serie[i];
    if (valor !== null && valor !== undefined) return valor;
  }
  return null;
}

/** Media de la serie en [desde, hasta] ignorando huecos, o null si no hay ninguno. */
export function media(serie: Serie | undefined, desde: number, hasta: number): number | null {
  if (!serie) return null;
  let suma = 0;
  let cuenta = 0;
  for (let i = Math.max(0, desde); i <= Math.min(hasta, serie.length - 1); i++) {
    const valor = serie[i];
    if (valor === null || valor === undefined) continue;
    suma += valor;
    cuenta += 1;
  }
  return cuenta ? suma / cuenta : null;
}

/**
 * Ascenso y descenso acumulados en [desde, hasta] con histéresis: un cambio solo
 * cuenta cuando supera `umbralM` respecto al último punto de referencia. No
 * coincidirá al metro con el `total_elevation_gain` de intervals.icu, que usa su
 * propio filtro; quien lo muestre debe decir de dónde sale.
 */
export function desnivelAcumulado(
  altitud: Serie | undefined,
  desde = 0,
  hasta = Number.MAX_SAFE_INTEGER,
  umbralM = UMBRAL_DESNIVEL_M,
): Desnivel {
  const resultado: Desnivel = { subida: 0, bajada: 0 };
  if (!altitud) return resultado;
  let referencia: number | null = null;
  for (let i = Math.max(0, desde); i <= Math.min(hasta, altitud.length - 1); i++) {
    const alt = altitud[i];
    if (alt === null || alt === undefined) continue;
    if (referencia === null) {
      referencia = alt;
      continue;
    }
    const delta = alt - referencia;
    if (delta >= umbralM) {
      resultado.subida += delta;
      referencia = alt;
    } else if (delta <= -umbralM) {
      resultado.bajada += -delta;
      referencia = alt;
    }
  }
  return resultado;
}

/**
 * Corta [desde, hasta] en tramos cada vez que la serie guía (tiempo en segundos
 * o distancia en metros) avanza `cada`. El último tramo se cierra en `hasta`
 * aunque quede corto: es el final de la actividad, no un tramo perdido.
 */
export function tramos(
  guia: Serie | undefined,
  cada: number,
  desde: number,
  hasta: number,
): Tramo[] {
  const salida: Tramo[] = [];
  if (!guia || !Number.isFinite(cada) || cada <= 0) return salida;
  const primero = Math.max(0, desde);
  const ultimo = Math.min(hasta, guia.length - 1);
  if (ultimo <= primero) return salida;

  let inicio = primero;
  let base: number | null = null;
  for (let i = primero; i <= ultimo; i++) {
    const valor = guia[i];
    if (valor === null || valor === undefined) continue;
    if (base === null) {
      base = valor;
      inicio = i;
      continue;
    }
    if (valor - base >= cada) {
      salida.push({ desde: inicio, hasta: i });
      inicio = i;
      base = valor;
    }
  }
  if (inicio < ultimo) salida.push({ desde: inicio, hasta: ultimo });
  return salida;
}

/**
 * Serie de tiempo en segundos desde el inicio. intervals.icu la sirve como
 * stream 'time'; si falta, las muestras son de 1 Hz y el índice ya es el segundo.
 */
export function serieTiempo(series: Series, longitud: number): Serie {
  const tiempo = series.get("time");
  if (tiempo && tiempo.length) return tiempo;
  return Array.from({ length: longitud }, (_, i) => i);
}

/** Longitud de la serie más larga: cuántas muestras tiene la actividad. */
export function longitudSeries(series: Series): number {
  let maximo = 0;
  for (const serie of series.values()) maximo = Math.max(maximo, serie.length);
  return maximo;
}

/**
 * Paso de remuestreo en segundos para que salgan como mucho `objetivoFilas`
 * filas, redondeado a múltiplos de 5 s para que la tabla se lea en voz alta.
 */
export function pasoAutomatico(segundos: number, objetivoFilas: number): number {
  if (!Number.isFinite(segundos) || segundos <= 0) return 5;
  return Math.max(5, Math.ceil(segundos / objetivoFilas / 5) * 5);
}
