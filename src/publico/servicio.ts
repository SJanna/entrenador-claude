/**
 * Calcula y publica el JSON de la página pública. Lo llama el cron cada noche
 * y, desde el panel (con login), la vista previa.
 *
 *  - Km, tirada larga e hitos salen del histórico de intervals.icu, entero, en
 *    una petición. Si intervals falla no se publica nada: la página sigue con
 *    lo de ayer, que lleva su fecha.
 *  - El cumplimiento sale de Garmin, que es donde vive el plan. Se guardan las
 *    sesiones en D1 y se releen solo los últimos 21 días (Garmin sincroniza
 *    tarde). Si Garmin falla, el cumplimiento se queda en el último día leído y
 *    lo dice (`cumplimiento.hasta`); el resto se publica igual.
 *  - Antes de escribir en KV, el JSON pasa por la lista blanca. Si no encaja,
 *    no se publica.
 */

import type { AppConfig, Env } from "../env";
import { addDays } from "../dates";
import * as fmt from "../intervals/format";
import { IntervalsClient, type JsonRecord } from "../intervals/client";
import { GarminAlmacen } from "../garmin/almacen";
import { GarminCliente } from "../garmin/cliente";
import { leerCalendario, MAX_MESES, type ItemCalendario } from "../garmin/calendario";
import { listarActividades } from "../garmin/actividades";
import { leerUmbrales } from "../garmin/umbrales";
import {
  calcularProgreso,
  categoriaDe,
  categoriaIntervals,
  emparejar,
  type ActividadKm,
  type ProgresoPublico,
  type SesionHecha,
  type SesionProgramada,
} from "./compute";
import { erroresPublicos } from "./esquema";
import { PublicoStore, type ConfigPublica, type FilaProgramada } from "./store";

/** Días recientes que se releen de Garmin cada noche. */
export const DIAS_EN_VIVO = 21;
/** La clave de KV que lee la página. */
export const CLAVE_KV = "progreso.json";

const HISTORICO_DESDE = "2000-01-01";
// «name» solo para descartar caminatas y terapia: no sale de esta función.
const CAMPOS_ACTIVIDAD = [
  "id", "type", "name", "start_date_local", "distance", "moving_time", "elapsed_time",
  "average_heartrate", "max_heartrate", "average_weather_temp", "gap",
];

export interface FilaDiagnostico {
  fecha: string;
  titulo: string;
  deporte: string | null;
  categoria: string | null;
  minutos: number | null;
  cumplida: boolean | null;
}

export interface ResultadoPublico {
  publico: ProgresoPublico;
  /** Lo que se escribe en KV, byte a byte. */
  json: string;
  errores: string[];
  publicado: boolean;
  avisos: string[];
  /** Solo para la vista previa del panel: lleva títulos, nunca sale a KV. */
  diagnostico: { leidoDesde: string | null; leidoHasta: string | null; sesiones: FilaDiagnostico[] };
}

function numero(v: unknown): number | null {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : null;
}

/** Km de cada actividad, del histórico entero de intervals.icu. */
export async function actividadesKm(client: IntervalsClient, hoy: string): Promise<ActividadKm[]> {
  const lista = await client.activities(HISTORICO_DESDE, hoy, 5000, CAMPOS_ACTIVIDAD);
  return lista
    .map((a: JsonRecord) => ({
      fecha: fmt.dateShort(a.start_date_local),
      tipo: String(a.type ?? ""),
      km: Number(a.distance) / 1000,
      categoria: categoriaIntervals(String(a.type ?? ""), String(a.name ?? "")),
      segundos: numero(fmt.firstPresent(a, ["moving_time", "elapsed_time"])),
      fcMedia: numero(a.average_heartrate),
      fcMax: numero(a.max_heartrate),
      temp: numero(a.average_weather_temp),
      gap: numero(a.gap),
    }))
    .filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a.fecha) && Number.isFinite(a.km));
}

/** Tramos de como mucho MAX_MESES meses naturales, que es lo que lee el calendario. */
export function tramosCalendario(desde: string, hasta: string): Array<[string, string]> {
  const tramos: Array<[string, string]> = [];
  let inicio = desde;
  while (inicio <= hasta) {
    const año = Number(inicio.slice(0, 4));
    const mes = Number(inicio.slice(5, 7)) - 1 + MAX_MESES;
    const primeroFuera = new Date(Date.UTC(año, mes, 1)).toISOString().slice(0, 10);
    const fin = addDays(primeroFuera, -1) < hasta ? addDays(primeroFuera, -1) : hasta;
    tramos.push([inicio, fin]);
    inicio = addDays(fin, 1);
  }
  return tramos;
}

async function duracionesEntrenos(cliente: GarminCliente, ids: Set<number>): Promise<Map<number, number>> {
  const duraciones = new Map<number, number>();
  const leer = (w: Record<string, unknown>) => {
    const id = Number(w.workoutId);
    const segundos = Number(w.estimatedDurationInSecs);
    if (Number.isFinite(id) && Number.isFinite(segundos) && segundos > 0) duraciones.set(id, segundos);
  };
  for (let pagina = 0; pagina < 5; pagina++) {
    const respuesta = await cliente.api(
      `/workout-service/workouts?start=${pagina * 100}&limit=100&myWorkoutsOnly=true`,
    );
    if (!respuesta.ok) throw new Error(`Garmin respondió ${respuesta.status} a la biblioteca de entrenos`);
    const lista = (await respuesta.json()) as Array<Record<string, unknown>> | null;
    if (!Array.isArray(lista)) break;
    lista.forEach(leer);
    if (lista.length < 100 || [...ids].every((id) => duraciones.has(id))) break;
  }
  // Lo que no esté en las primeras páginas (entrenos viejos reprogramados), uno a uno.
  const faltan = [...ids].filter((id) => !duraciones.has(id)).slice(0, 30);
  for (const id of faltan) {
    const respuesta = await cliente.api(`/workout-service/workout/${id}`);
    if (respuesta.ok) leer((await respuesta.json()) as Record<string, unknown>);
    else await respuesta.body?.cancel();
  }
  return duraciones;
}

async function actividadesGarmin(cliente: GarminCliente, desde: string, hasta: string) {
  const todas = [];
  for (let pagina = 0; pagina < 20; pagina++) {
    const lote = await listarActividades(cliente, { limite: 100, inicio: pagina * 100, desde, hasta });
    todas.push(...lote);
    if (lote.length < 100) break;
  }
  return todas.filter((a) => a.fecha >= desde && a.fecha <= hasta);
}

/**
 * Lee de Garmin los días que faltan (como mínimo los últimos 21), empareja
 * plan y actividades y lo guarda en D1.
 *
 * El plan de un día se congela al empezar ese día: el cron de las 03:00 guarda
 * ya las sesiones de HOY. Hace falta porque borrar un entreno de la biblioteca
 * de Garmin borra también sus citas pasadas: el 22/10/2026 los rodajes del 13 al
 * 21 estaban hechos y ya no constaban como programados. Lo de hoy se guarda
 * pero no cuenta hasta que el día acaba (`cumplimientoHasta` = ayer).
 */
export async function actualizarCumplimiento(
  cliente: GarminCliente,
  store: PublicoStore,
  cfg: ConfigPublica,
  hoy: string,
  ahora: string,
): Promise<ResultadoPublico["diagnostico"]> {
  const t0 = [...cfg.temporadas].sort((a, b) => a.numero - b.numero)[0];
  const hasta = addDays(hoy, -1);
  const vivo = addDays(hoy, -DIAS_EN_VIVO);
  const hueco = cfg.cumplimientoHasta ? addDays(cfg.cumplimientoHasta, 1) : t0?.desde ?? vivo;
  let desde = hueco < vivo ? hueco : vivo;
  if (t0 && desde < t0.desde) desde = t0.desde;
  if (!t0 || desde > hoy) return { leidoDesde: null, leidoHasta: null, sesiones: [] };

  const items: ItemCalendario[] = [];
  for (const [a, b] of tramosCalendario(desde, hoy)) {
    const calendario = await leerCalendario(cliente, a, b);
    if (calendario.fallos.length) {
      // Un mes que no se pudo leer parecería un mes sin plan: no se guarda nada.
      throw new Error(`Garmin no dejó leer el calendario: ${calendario.fallos.join(", ")}`);
    }
    items.push(...calendario.items);
  }

  const entrenos = items.filter((i) => i.tipo === "workout");
  const duraciones = await duracionesEntrenos(
    cliente,
    new Set(entrenos.map((i) => i.workoutId).filter((id): id is number => id !== null)),
  );

  const sesiones: FilaDiagnostico[] = [];
  const frescas: Array<SesionProgramada & { titulo: string }> = [];
  entrenos.forEach((item, indice) => {
    const categoria = categoriaDe(item.deporte, item.titulo);
    const segundos = item.workoutId !== null ? (duraciones.get(item.workoutId) ?? null) : null;
    sesiones.push({
      fecha: item.fecha,
      titulo: item.titulo,
      deporte: item.deporte,
      categoria,
      minutos: segundos === null ? null : Math.round(segundos / 60),
      cumplida: null,
    });
    if (!categoria) return;
    const id =
      item.scheduleId !== null ? `s${item.scheduleId}` : `w${item.workoutId ?? "?"}-${item.fecha}-${indice}`;
    frescas.push({ id, fecha: item.fecha, categoria, segundos, titulo: item.titulo });
  });

  // Lo guardado de esos días sigue contando aunque ya no esté en Garmin.
  const union = new Map<string, SesionProgramada>();
  for (const f of await store.programadas(desde)) {
    if (f.fecha <= hoy) {
      union.set(f.programacion, {
        id: f.programacion,
        fecha: f.fecha,
        categoria: f.categoria as SesionProgramada["categoria"],
        segundos: f.segundos,
      });
    }
  }
  for (const f of frescas) union.set(f.id, f);

  const hechas: SesionHecha[] = [];
  for (const a of await actividadesGarmin(cliente, desde, hoy)) {
    const categoria = categoriaDe(a.deporte, a.nombre);
    if (categoria) hechas.push({ fecha: a.fecha, categoria, segundos: a.segundos ?? 0 });
  }

  const cumplidas = emparejar([...union.values()], hechas);
  const filas: FilaProgramada[] = [...union.values()].map((s) => ({
    programacion: s.id,
    fecha: s.fecha,
    categoria: s.categoria,
    segundos: s.segundos,
    cumplida: cumplidas.has(s.id),
  }));
  await store.guardarProgramadas(filas, hasta, ahora);

  const porTitulo = new Map(frescas.map((f) => [`${f.fecha}|${f.titulo}`, cumplidas.has(f.id)]));
  for (const s of sesiones) {
    if (s.categoria) s.cumplida = porTitulo.get(`${s.fecha}|${s.titulo}`) ?? null;
  }
  return { leidoDesde: desde, leidoHasta: hoy, sesiones };
}

export interface OpcionesPublico {
  /** false = vista previa: calcula y guarda en D1, pero no toca KV. */
  publicar: boolean;
  /** Para los tests: otro cliente de Garmin. */
  garmin?: GarminCliente;
}

export async function calcularPublico(
  env: Env,
  config: AppConfig,
  opciones: OpcionesPublico,
): Promise<ResultadoPublico> {
  const store = new PublicoStore(env.DB);
  const hoy = config.today();
  const ahora = new Date().toISOString();
  const avisos: string[] = [];

  let cfg = await store.config();
  const actividades = await actividadesKm(new IntervalsClient(config), hoy);

  let diagnostico: ResultadoPublico["diagnostico"] = { leidoDesde: null, leidoHasta: null, sesiones: [] };
  try {
    const garmin = opciones.garmin ?? new GarminCliente(new GarminAlmacen(env.DB, env.SESSION_SECRET));
    diagnostico = await actualizarCumplimiento(garmin, store, cfg, hoy, ahora);
    cfg = await store.config();
  } catch (exc) {
    avisos.push(
      `Cumplimiento sin actualizar (se queda en ${cfg.cumplimientoHasta ?? "nunca"}): ` +
        (exc instanceof Error ? exc.message : String(exc)),
    );
  }

  // Las zonas de FC del reloj: sin ellas valen las de siempre.
  let zonasFc: number[] | null = null;
  try {
    const garmin = opciones.garmin ?? new GarminCliente(new GarminAlmacen(env.DB, env.SESSION_SECRET));
    zonasFc = (await leerUmbrales(garmin, hoy, {}, "RUNNING")).zonas?.suelos ?? null;
    if (!zonasFc) avisos.push("Garmin no dio zonas de FC: se usan 134/155/172.");
  } catch (exc) {
    avisos.push("Zonas de FC sin leer (se usan 134/155/172): " + (exc instanceof Error ? exc.message : String(exc)));
  }

  const t0 = [...cfg.temporadas].sort((a, b) => a.numero - b.numero)[0];
  const [plan, hitosManuales, programadas] = await Promise.all([
    store.plan(),
    store.hitosManuales(),
    store.cumplimientoDias(t0?.desde ?? hoy),
  ]);

  const publico = calcularProgreso({
    hoy,
    generado: ahora,
    diaD: cfg.diaD,
    temporadas: cfg.temporadas,
    actividades,
    plan,
    hitosManuales,
    programadas,
    cumplimientoHasta: cfg.cumplimientoHasta,
    zonasFc,
  });
  const json = JSON.stringify(publico);
  const errores = erroresPublicos(publico);

  let publicado = false;
  if (opciones.publicar) {
    if (errores.length) {
      avisos.push(`NO publicado: el JSON no pasa la lista blanca (${errores.slice(0, 3).join("; ")}).`);
    } else if (!env.PUBLICO) {
      avisos.push("NO publicado: falta el binding KV «PUBLICO» en wrangler.jsonc.");
    } else {
      await env.PUBLICO.put(CLAVE_KV, json);
      publicado = true;
    }
  }
  await store.guardarSnapshot(hoy, json, publicado, ahora);
  return { publico, json, errores, publicado, avisos, diagnostico };
}
