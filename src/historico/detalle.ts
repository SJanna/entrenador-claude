/**
 * Series de una actividad desde Garmin: pulso, velocidad y distancia en el
 * tiempo. Es lo que hace falta para las mejores marcas y el desacople.
 *
 * El endpoint devuelve una tabla: `metricDescriptors` dice qué columna es cada
 * métrica y `activityDetailMetrics` trae las filas. Las claves que se usan son
 * las que documenta python-garminconnect; si una no está, la serie va vacía y
 * el cálculo que la necesita sale null, no un número inventado.
 */

import type { GarminCliente } from "../garmin/cliente";
import { GarminError } from "../garmin/cliente";
import type { Series } from "./calculos";

/** Muestras pedidas: con 2.000, una tirada de 3 h queda a ~5 s por muestra. */
export const MUESTRAS = 2000;

function columna(descriptores: unknown, ...claves: string[]): number | null {
  if (!Array.isArray(descriptores)) return null;
  for (const clave of claves) {
    const d = descriptores.find(
      (x) => x && typeof x === "object" && (x as Record<string, unknown>).key === clave,
    ) as Record<string, unknown> | undefined;
    const i = Number(d?.metricsIndex);
    if (Number.isInteger(i) && i >= 0) return i;
  }
  return null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : v === null || v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function seriesDeDetalle(cuerpo: unknown): Series | null {
  if (!cuerpo || typeof cuerpo !== "object") return null;
  const c = cuerpo as Record<string, unknown>;
  const filas = Array.isArray(c.activityDetailMetrics) ? c.activityDetailMetrics : [];
  if (!filas.length) return null;
  const iT = columna(c.metricDescriptors, "sumElapsedDuration", "sumDuration");
  const iTs = columna(c.metricDescriptors, "directTimestamp");
  const iD = columna(c.metricDescriptors, "sumDistance");
  const iV = columna(c.metricDescriptors, "directSpeed");
  const iF = columna(c.metricDescriptors, "directHeartRate");
  if (iT === null && iTs === null) return null;

  const s: Series = { segundos: [], distancia: [], velocidad: [], fc: [] };
  let t0: number | null = null;
  for (const fila of filas) {
    const m = (fila as Record<string, unknown>)?.metrics;
    if (!Array.isArray(m)) continue;
    let t = iT !== null ? num(m[iT]) : null;
    if (t === null && iTs !== null) {
      const ts = num(m[iTs]);
      if (ts !== null) {
        t0 ??= ts;
        t = (ts - t0) / 1000;
      }
    }
    if (t === null) continue;
    s.segundos.push(t);
    s.distancia.push(iD !== null ? num(m[iD]) : null);
    s.velocidad.push(iV !== null ? num(m[iV]) : null);
    s.fc.push(iF !== null ? num(m[iF]) : null);
  }
  return s.segundos.length >= 2 ? s : null;
}

export async function leerSeries(cliente: GarminCliente, id: number): Promise<Series | null> {
  const r = await cliente.api(
    `/activity-service/activity/${id}/details?maxChartSize=${MUESTRAS}&maxPolylineSize=0`,
  );
  const texto = await r.text();
  if (r.status === 404 || r.status === 204) return null;
  if (!r.ok) {
    throw new GarminError("protocolo", `Garmin respondió ${r.status} al detalle de ${id}.`);
  }
  if (!texto.trim()) return null;
  return seriesDeDetalle(JSON.parse(texto));
}
