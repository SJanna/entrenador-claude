/**
 * Calcula y publica el JSON de la página pública. Lo llama el cron cada noche
 * y, desde el panel (con login), la vista previa.
 *
 *  - Km, tirada larga, hitos, sesiones de ayer, pulso fijo y predicción salen
 *    del histórico de Garmin que guarda la app (D1, lo llena el cron cada
 *    hora), con los últimos días releídos en vivo porque Garmin sincroniza
 *    tarde. Si el histórico no está o está vacío no se publica nada: la página
 *    sigue con lo de ayer, que lleva su fecha. intervals.icu no se usa.
 *  - El cumplimiento sale de Garmin, que es donde vive el plan. Se guardan las
 *    sesiones en D1 y se releen solo los últimos 21 días (Garmin sincroniza
 *    tarde). Si Garmin falla, el cumplimiento se queda en el último día leído y
 *    lo dice (`cumplimiento.hasta`); el resto se publica igual.
 *  - Antes de escribir en KV, el JSON pasa por la lista blanca. Si no encaja,
 *    no se publica.
 */

import type { AppConfig, Env } from "../env";
import { addDays } from "../dates";
import { GarminAlmacen } from "../garmin/almacen";
import { GarminCliente } from "../garmin/cliente";
import { leerCalendario, MAX_MESES, type ItemCalendario } from "../garmin/calendario";
import { listarActividades, type Actividad } from "../garmin/actividades";
import { leerUmbrales } from "../garmin/umbrales";
import { conClima, HistoricoStore, type FilaActividad } from "../historico/store";
import {
  calcularProgreso,
  categoriaDe,
  emparejar,
  TIPOS_CARRERA,
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
  diagnostico: {
    leidoDesde: string | null;
    leidoHasta: string | null;
    sesiones: FilaDiagnostico[];
    /** Las últimas carreras tal como entran al cálculo, para cuadrarlas con Garmin Connect. */
    carreras: FilaCarrera[];
  };
}

export interface FilaCarrera {
  fecha: string;
  titulo: string;
  deporte: string;
  km: number;
  minutos: number | null;
  /** Ritmo ajustado por pendiente, en s/km. */
  gap: number | null;
  temp: number | null;
}

/** Lo que entra al cálculo de una fila del histórico de Garmin. «nombre» solo descarta caminatas y terapia. */
export function actividadDeFila(f: FilaActividad): ActividadKm {
  const nombre = f.nombre ?? "";
  return {
    fecha: f.fecha,
    tipo: f.deporte,
    km: (f.distancia_m ?? 0) / 1000,
    categoria: categoriaDe(f.deporte, nombre),
    // Tiempo en movimiento, como siempre: las paradas para beber no cuentan.
    segundos: f.segundos_mov ?? f.segundos,
    fcMedia: f.fc_media,
    fcMax: f.fc_max ?? null,
    temp: f.temp_clima ?? null,
    gap: f.gap_ms ?? null,
  };
}

/**
 * Las actividades de la serie: el histórico de Garmin entero (D1) y, encima,
 * las de los últimos días leídas en vivo (Garmin sincroniza tarde y una
 * actividad se edita después). De lo vivo se toma el resumen; el GAP, si no
 * viene, y el clima, que es una llamada aparte, salen de D1.
 */
export function mezclarActividades(guardadas: FilaActividad[], vivas: Actividad[]): FilaActividad[] {
  const porId = new Map(guardadas.map((f) => [f.id, f]));
  for (const a of vivas) {
    const antes = porId.get(a.id);
    porId.set(a.id, {
      ...(antes ?? { inicio: null, efecto_aerobico: null, detalle_estado: "pendiente", detalle_error: null }),
      id: a.id,
      fecha: a.fecha,
      deporte: a.deporte,
      nombre: a.nombre,
      segundos: a.segundos,
      segundos_mov: a.segundosMov,
      distancia_m: a.distanciaM,
      desnivel_m: a.desnivelM,
      fc_media: a.fcMedia,
      fc_max: a.fcMax,
      carga: a.carga,
      gap_ms: a.gapMs ?? antes?.gap_ms ?? null,
      temp_clima: antes?.temp_clima ?? null,
    });
  }
  return [...porId.values()]
    .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.fecha))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
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
): Promise<Omit<ResultadoPublico["diagnostico"], "carreras">> {
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

  // El calendario se lee por meses y Garmin repite en cada mes los días de las
  // semanas que lo tocan: la misma cita sale dos veces. Una por programación.
  const vistas = new Set<number>();
  const entrenos = items.filter((i) => {
    if (i.tipo !== "workout") return false;
    if (i.scheduleId === null) return true;
    if (vistas.has(i.scheduleId)) return false;
    vistas.add(i.scheduleId);
    return true;
  });
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
  const garmin = () => opciones.garmin ?? new GarminCliente(new GarminAlmacen(env.DB, env.SESSION_SECRET));

  // Las actividades: el histórico de Garmin de la app. Sin él no se publica
  // nada (lanzar aquí deja la página con lo de ayer, que lleva su fecha).
  const historico = new HistoricoStore(env.DB);
  if (!(await historico.disponible())) {
    throw new Error("No hay histórico de Garmin (falta la migración 0010): no se calcula la página.");
  }
  const guardadas = await historico.actividades();
  if (!guardadas.length) {
    throw new Error("El histórico de Garmin está vacío (¿Garmin sin enlazar?): no se calcula la página.");
  }
  let vivas: Actividad[] = [];
  try {
    vivas = await actividadesGarmin(garmin(), addDays(hoy, -DIAS_EN_VIVO), hoy);
  } catch (exc) {
    avisos.push(
      "Últimos días sin releer de Garmin (se usa el histórico guardado): " +
        (exc instanceof Error ? exc.message : String(exc)),
    );
  }
  if (!(await historico.conGapYClima())) {
    avisos.push("Falta la migración 0011 (npm run db:migrate): sin GAP ni clima, no hay pulso fijo, predicción ni temperatura.");
  }
  const filas = mezclarActividades(guardadas, vivas);
  const actividades = filas.map(actividadDeFila);

  let diagnostico: ResultadoPublico["diagnostico"] = { leidoDesde: null, leidoHasta: null, sesiones: [], carreras: [] };
  try {
    diagnostico = { ...(await actualizarCumplimiento(garmin(), store, cfg, hoy, ahora)), carreras: [] };
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
    zonasFc = (await leerUmbrales(garmin(), hoy, {}, "RUNNING")).zonas?.suelos ?? null;
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

  // Para cuadrar con Garmin Connect: las últimas carreras tal como entran, y
  // cuántas de la serie no traen GAP o clima (sin GAP no hay pulso fijo ni
  // predicción; sin clima, la sesión de ayer sale sin temperatura).
  const t1 = cfg.temporadas.find((t) => t.numero === 1);
  const inicio = t1?.desde ?? t0?.desde ?? hoy;
  const carreras = filas.filter((f) => TIPOS_CARRERA.has(f.deporte) && (f.distancia_m ?? 0) > 0);
  diagnostico.carreras = carreras.slice(-8).reverse().map((f) => {
    const a = actividadDeFila(f);
    return {
      fecha: f.fecha,
      titulo: f.nombre ?? "",
      deporte: f.deporte,
      km: Math.round(a.km * 100) / 100,
      minutos: a.segundos ? Math.round(a.segundos / 60) : null,
      gap: a.gap ? Math.round(1000 / a.gap) : null,
      temp: a.temp ?? null,
    };
  });
  const deLaSerie = carreras.filter((f) => f.fecha >= inicio && f.fecha < hoy);
  const sinGap = deLaSerie.filter((f) => !f.gap_ms).length;
  const sinClima = deLaSerie.filter((f) => f.temp_clima == null && conClima(f.deporte)).length;
  if (sinGap) avisos.push(`${sinGap} de ${deLaSerie.length} carreras desde el ${inicio} sin GAP de Garmin.`);
  if (sinClima) avisos.push(`${sinClima} de ${deLaSerie.length} carreras desde el ${inicio} sin clima todavía (se pide poco a poco cada hora).`);

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
