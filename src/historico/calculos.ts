/**
 * Cálculos del histórico de Garmin: lo que antes hacía intervals.icu.
 *
 * Todo puro (sin red ni D1) para poder probarlo con números conocidos. Dos
 * principios que vienen del log de errores del entrenador:
 *
 *  - Un número plausible y falso no da error. Por eso cada cálculo devuelve
 *    también su COBERTURA (cuántos días o actividades lo sostienen), y las
 *    marcas físicamente imposibles se descartan en vez de enseñarse.
 *  - Una ventana corta da una imagen falsa del atleta (R026). Las bandas de
 *    bienestar se calculan sobre la ventana que se pida, pero dicen con cuántos
 *    días reales se calcularon.
 */

import { addDays, mondayOf } from "../dates";

// ------------------------------------------------------------- tipos

export interface ActividadH {
  id: number;
  fecha: string;
  deporte: string;
  nombre?: string | null;
  segundos: number | null;
  distancia_m: number | null;
  desnivel_m: number | null;
  fc_media: number | null;
  carga: number | null;
  desacople_pct?: number | null;
  mejores?: Record<string, number> | null;
  fc_max_serie?: number | null;
  fc_max?: number | null;
  /** Segundos en Z1..Z5 de FC del reloj (migración 0012), si ya se leyeron. */
  zonas?: number[] | null;
}

/** Series de una actividad, alineadas por índice. */
export interface Series {
  segundos: number[]; // tiempo transcurrido desde el inicio
  distancia: Array<number | null>; // metros acumulados
  velocidad: Array<number | null>; // m/s
  fc: Array<number | null>;
}

// ------------------------------------------------------------- deportes

const CORRER = new Set([
  "running", "trail_running", "treadmill_running", "track_running", "street_running",
  "indoor_running", "virtual_run", "ultra_run", "obstacle_run",
]);
const A_PIE = new Set(["walking", "hiking", "casual_walking", "speed_walking", "indoor_walking"]);

export function esCarrera(deporte: string): boolean {
  return CORRER.has(deporte) || deporte.endsWith("_running");
}

export function esAPie(deporte: string): boolean {
  return esCarrera(deporte) || A_PIE.has(deporte);
}

// --------------------------------------------------- carga: CTL / ATL / TSB

export interface CargaDia {
  fecha: string;
  carga: number;
  ctl: number;
  atl: number;
  /** Forma del día = CTL − ATL del día anterior (convención de intervals.icu). */
  tsb: number;
}

const K_CTL = 1 - Math.exp(-1 / 42);
const K_ATL = 1 - Math.exp(-1 / 7);

/**
 * Medias exponenciales de 42 y 7 días sobre la carga diaria de Garmin.
 * Arranca en 0 el primer día con datos: los primeros ~6 semanas subestiman la
 * CTL, y `fiable` lo dice.
 */
export function serieCarga(
  actividades: ActividadH[],
  desde: string,
  hasta: string,
): { dias: CargaDia[]; sinCarga: number; fiableDesde: string } {
  const porDia = new Map<string, number>();
  let sinCarga = 0;
  for (const a of actividades) {
    if (a.carga === null || a.carga === undefined) {
      if ((a.segundos ?? 0) >= 600) sinCarga++;
      continue;
    }
    porDia.set(a.fecha, (porDia.get(a.fecha) ?? 0) + a.carga);
  }
  const dias: CargaDia[] = [];
  let ctl = 0;
  let atl = 0;
  for (let d = desde; d <= hasta; d = addDays(d, 1)) {
    const tsb = ctl - atl;
    const carga = porDia.get(d) ?? 0;
    ctl += (carga - ctl) * K_CTL;
    atl += (carga - atl) * K_ATL;
    dias.push({ fecha: d, carga, ctl, atl, tsb });
  }
  return { dias, sinCarga, fiableDesde: addDays(desde, 42) };
}

// ------------------------------------------------------- resumen semanal

export interface SemanaH {
  lunes: string;
  sesiones: number;
  segundos: number;
  carga: number;
  kmCarrera: number;
  kmAPie: number;
  desnivel: number;
  porDeporte: Record<string, { n: number; segundos: number }>;
  /** Segundos en Z1..Z5 sumados de las actividades que ya tienen zonas. */
  zonas: number[];
  /** Cuántas actividades con pulso tiene la semana, y cuántas ya con zonas. */
  conFc: number;
  conZonas: number;
}

export function semanas(actividades: ActividadH[], desde: string, hasta: string): SemanaH[] {
  const mapa = new Map<string, SemanaH>();
  for (let l = mondayOf(desde); l <= hasta; l = addDays(l, 7)) {
    mapa.set(l, {
      lunes: l, sesiones: 0, segundos: 0, carga: 0, kmCarrera: 0, kmAPie: 0, desnivel: 0,
      porDeporte: {}, zonas: [0, 0, 0, 0, 0], conFc: 0, conZonas: 0,
    });
  }
  for (const a of actividades) {
    if (a.fecha < desde || a.fecha > hasta) continue;
    const s = mapa.get(mondayOf(a.fecha));
    if (!s) continue;
    s.sesiones++;
    s.segundos += a.segundos ?? 0;
    s.carga += a.carga ?? 0;
    s.desnivel += a.desnivel_m ?? 0;
    const km = (a.distancia_m ?? 0) / 1000;
    if (esCarrera(a.deporte)) s.kmCarrera += km;
    if (esAPie(a.deporte)) s.kmAPie += km;
    const p = (s.porDeporte[a.deporte] ??= { n: 0, segundos: 0 });
    p.n++;
    p.segundos += a.segundos ?? 0;
    if (a.fc_media) s.conFc++;
    if (Array.isArray(a.zonas) && a.zonas.length === 5) {
      s.conZonas++;
      a.zonas.forEach((seg, i) => (s.zonas[i]! += seg || 0));
    }
  }
  return [...mapa.values()];
}

// ------------------------------------------------------- mejores marcas

export const DISTANCIAS_MARCA = [400, 800, 1000, 1609, 3000, 5000, 10000, 21097, 42195] as const;

/** Más rápido que esto en carrera a pie es un error de GPS, no una marca. */
const VELOCIDAD_MAXIMA_CREIBLE = 1000 / 150; // 2:30/km

/**
 * Mejor tiempo para cubrir cada distancia dentro de una actividad, con dos
 * punteros sobre la distancia acumulada. Interpola en el borde para no regalar
 * ni quitar segundos por la resolución de la muestra.
 */
export function mejoresDeSeries(s: Series): Record<string, number> {
  const t: number[] = [];
  const d: number[] = [];
  for (let k = 0; k < s.segundos.length; k++) {
    const dk = s.distancia[k];
    if (dk === null || dk === undefined || !Number.isFinite(dk)) continue;
    if (d.length && dk < d[d.length - 1]!) continue; // la distancia no retrocede
    t.push(s.segundos[k]!);
    d.push(dk);
  }
  const salida: Record<string, number> = {};
  if (d.length < 2) return salida;
  const total = d[d.length - 1]! - d[0]!;
  for (const objetivo of DISTANCIAS_MARCA) {
    if (total < objetivo) break;
    let mejor = Infinity;
    let i = 0;
    for (let j = 1; j < d.length; j++) {
      while (i + 1 < j && d[j]! - d[i + 1]! >= objetivo) i++;
      const tramo = d[j]! - d[i]!;
      if (tramo < objetivo) continue;
      const tiempo = ((t[j]! - t[i]!) * objetivo) / tramo;
      if (tiempo > 0 && tiempo < mejor) mejor = tiempo;
    }
    if (Number.isFinite(mejor) && objetivo / mejor <= VELOCIDAD_MAXIMA_CREIBLE) {
      salida[String(objetivo)] = Math.round(mejor);
    }
  }
  return salida;
}

/**
 * Desacople aeróbico (Pa:FC): eficiencia (velocidad / pulso) de la primera
 * mitad frente a la segunda, en tiempo en movimiento. Positivo = el pulso subió
 * para la misma velocidad. Solo con 40 min o más en movimiento y pulso en la
 * mayor parte de las muestras; si no, null antes que un número sin base.
 */
export function desacople(s: Series): number | null {
  const muestras: Array<{ dt: number; v: number; fc: number }> = [];
  for (let k = 1; k < s.segundos.length; k++) {
    const v = s.velocidad[k];
    const fc = s.fc[k];
    const dt = s.segundos[k]! - s.segundos[k - 1]!;
    if (!(dt > 0) || dt > 60) continue;
    if (v === null || v === undefined || v < 0.5) continue; // parado
    if (fc === null || fc === undefined || fc < 60) continue;
    muestras.push({ dt, v, fc });
  }
  const total = muestras.reduce((acc, m) => acc + m.dt, 0);
  if (total < 40 * 60) return null;
  if (muestras.length < 0.6 * (s.segundos.length - 1)) return null;
  let acumulado = 0;
  const mitades = [
    { t: 0, v: 0, fc: 0 },
    { t: 0, v: 0, fc: 0 },
  ];
  for (const m of muestras) {
    const h = acumulado < total / 2 ? 0 : 1;
    mitades[h]!.t += m.dt;
    mitades[h]!.v += m.v * m.dt;
    mitades[h]!.fc += m.fc * m.dt;
    acumulado += m.dt;
  }
  const ef = mitades.map((m) => m.v / m.t / (m.fc / m.t));
  if (!(ef[0]! > 0)) return null;
  return Math.round(((ef[0]! - ef[1]!) / ef[0]!) * 1000) / 10;
}

/** Pulso máximo SOSTENIDO: el menor de los dos valores más altos consecutivos. */
export function fcMaxSostenida(s: Series): number | null {
  let mejor: number | null = null;
  for (let k = 1; k < s.fc.length; k++) {
    const a = s.fc[k - 1];
    const b = s.fc[k];
    if (a == null || b == null) continue;
    const v = Math.min(a, b);
    if (v >= 60 && v <= 240 && (mejor === null || v > mejor)) mejor = v;
  }
  return mejor;
}

export interface Marca {
  distancia: number;
  segundos: number;
  fecha: string;
  actividad: number;
  nombre: string | null;
}

/** La mejor de cada distancia sobre todo el histórico, y las siguientes. */
export function marcasHistoricas(actividades: ActividadH[], cuantas = 3): Map<number, Marca[]> {
  const salida = new Map<number, Marca[]>();
  for (const dist of DISTANCIAS_MARCA) salida.set(dist, []);
  for (const a of actividades) {
    if (!esCarrera(a.deporte) || !a.mejores) continue;
    for (const [clave, seg] of Object.entries(a.mejores)) {
      const lista = salida.get(Number(clave));
      if (!lista || !(seg > 0)) continue;
      lista.push({ distancia: Number(clave), segundos: seg, fecha: a.fecha, actividad: a.id, nombre: a.nombre ?? null });
    }
  }
  for (const [dist, lista] of salida) {
    lista.sort((x, y) => x.segundos - y.segundos);
    salida.set(dist, lista.slice(0, cuantas));
  }
  return salida;
}

// ------------------------------------------------------- bandas de bienestar

export interface Banda {
  n: number;
  media: number;
  sd: number;
  mediana: number;
  p10: number;
  p90: number;
}

export function banda(valores: Array<number | null | undefined>): Banda | null {
  const v = valores.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < 3) return null;
  const n = v.length;
  const media = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - media) ** 2, 0) / (n - 1));
  const q = (p: number) => {
    const pos = (n - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
  };
  return { n, media, sd, mediana: q(0.5), p10: q(0.1), p90: q(0.9) };
}

// ------------------------------------------------------- formato común

export function hms(segundos: number): string {
  const s = Math.round(segundos);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function ritmo(segundos: number, metros: number): string {
  if (!(metros > 0)) return "—";
  const porKm = Math.round((segundos * 1000) / metros);
  return `${Math.floor(porKm / 60)}:${String(porKm % 60).padStart(2, "0")}/km`;
}
