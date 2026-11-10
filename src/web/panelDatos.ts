/**
 * Datos del panel «zancada», todos de Garmin: el histórico de D1 (que llena el
 * cron cada hora) y el calendario de Garmin en vivo para lo programado.
 *
 * Aquí no hay red salvo `calendario`, que llega inyectado: así los tests pasan
 * un calendario de mentira y el cálculo es el mismo que ve el atleta. El panel
 * solo pinta; lo que se calcula, se calcula aquí, una vez.
 */

import { addDays, mondayOf } from "../dates";
import type { Calendario, ItemCalendario } from "../garmin/calendario";
import type { DiaBienestar } from "../garmin/bienestar";
import {
  banda,
  esCarrera,
  marcasHistoricas,
  semanas,
  serieCarga,
  type Banda,
} from "../historico/calculos";
import type { Cobertura, FilaActividad, FilaBienestar, HistoricoStore } from "../historico/store";
import { agregarDias, densificar, rachasDeDias, type RachasResultado } from "../streaks/compute";

export interface FuentesPanel {
  store: HistoricoStore;
  hoy: string;
  /** Calendario de Garmin. Si falla, el panel lo dice en vez de enseñar un hueco. */
  calendario: (desde: string, hasta: string) => Promise<Calendario>;
  /** Lectura en vivo de un día de bienestar, para cuando D1 lo tiene a medias. */
  bienestarEnVivo?: (fecha: string) => Promise<DiaBienestar>;
}

/** Ventana de las bandas de «tu normal»: la misma que usa el entrenador. */
export const DIAS_BANDA = 120;

// ------------------------------------------------------------- piezas

export interface ActividadPanel {
  id: number;
  fecha: string;
  hora: string | null;
  deporte: string;
  nombre: string | null;
  segundos: number | null;
  distancia_m: number | null;
  fc_media: number | null;
  carga: number | null;
  desacople_pct: number | null;
}

export interface Programado {
  fecha: string;
  titulo: string;
  deporte: string | null;
  segundos: number | null;
  workoutId: number | null;
  /** Hay una actividad hecha ese día que cumple la sesión (Garmin la marca). */
  completado: boolean;
}

export interface BandasPanel {
  dias: number;
  fc_reposo: Banda | null;
  hrv: Banda | null;
  sueno_h: Banda | null;
}

export interface CargaPanel {
  ctl: number;
  atl: number;
  tsb: number;
  /** La CTL arranca en 0: hasta 42 días después del primer dato, subestima. */
  fiable: boolean;
}

function actividad(a: FilaActividad): ActividadPanel {
  return {
    id: a.id,
    fecha: a.fecha,
    hora: a.inicio ? a.inicio.slice(11, 16) : null,
    deporte: a.deporte,
    nombre: a.nombre ?? null,
    segundos: a.segundos,
    distancia_m: a.distancia_m,
    fc_media: a.fc_media,
    carga: a.carga,
    desacople_pct: a.desacople_pct ?? null,
  };
}

/** Solo lo que está por hacer: las actividades hechas ya salen del histórico. */
function programados(items: ItemCalendario[]): Programado[] {
  return items
    .filter((i) => i.activityId === null && (i.workoutId !== null || i.tipo === "workout"))
    .map((i) => ({
      fecha: i.fecha,
      titulo: i.titulo,
      deporte: i.deporte,
      segundos: i.duracionSegundos,
      workoutId: i.workoutId,
      completado: i.completado,
    }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

async function leerCalendario(
  f: FuentesPanel,
  desde: string,
  hasta: string,
): Promise<{ items: ItemCalendario[]; error: string | null }> {
  try {
    const cal = await f.calendario(desde, hasta);
    return {
      items: cal.items,
      error: cal.fallos.length ? `Meses sin leer: ${cal.fallos.join(", ")}` : null,
    };
  } catch (exc) {
    return { items: [], error: exc instanceof Error ? exc.message : String(exc) };
  }
}

export function bandas(filas: FilaBienestar[]): BandasPanel {
  return {
    dias: DIAS_BANDA,
    fc_reposo: banda(filas.map((x) => x.fc_reposo)),
    hrv: banda(filas.map((x) => x.hrv_noche)),
    sueno_h: banda(filas.map((x) => (x.sueno_seg ? x.sueno_seg / 3600 : null))),
  };
}

/**
 * Serie de carga desde el primer dato (o desde `desde`, si es antes): la
 * gráfica pide una fila por día de su ventana aunque el histórico sea corto.
 */
function cargaDe(todas: FilaActividad[], hoy: string, desde = hoy) {
  const primera = todas[0]?.fecha ?? hoy;
  const inicio = primera < desde ? primera : desde;
  const serie = serieCarga(todas, inicio <= hoy ? inicio : hoy, hoy);
  // La fiabilidad cuenta desde el primer dato real, no desde el relleno.
  return { ...serie, fiableDesde: addDays(primera, 42) };
}

function datosDia(fila: FilaBienestar | undefined): Partial<DiaBienestar> | null {
  const bruto = (fila as unknown as { datos?: string | null } | undefined)?.datos;
  if (!bruto) return null;
  try {
    return JSON.parse(bruto) as Partial<DiaBienestar>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- hoy

export interface BienestarHoy {
  fecha: string;
  /** Leído hoy o el último día con datos (el reloj puede sincronizar tarde). */
  esHoy: boolean;
  fc_reposo: number | null;
  hrv: number | null;
  hrv_estado: string | null;
  sueno_seg: number | null;
  sueno_puntuacion: number | null;
  body_battery: number | null;
  readiness: number | null;
  readiness_nivel: string | null;
  estado_entreno: string | null;
}

export interface DatosHoy {
  hoy: string;
  cobertura: Cobertura;
  bienestar: BienestarHoy | null;
  bandas: BandasPanel;
  carga: CargaPanel | null;
  hechas: ActividadPanel[];
  agenda: Programado[];
  agendaError: string | null;
  semana: { lunes: string; kmCarrera: number; sesiones: number; segundos: number; diasActivos: number };
}

export async function datosHoy(f: FuentesPanel): Promise<DatosHoy> {
  const hoy = f.hoy;
  const lunes = mondayOf(hoy);
  const [todas, bien, cobertura, cal] = await Promise.all([
    f.store.actividades(),
    f.store.bienestar(addDays(hoy, -(DIAS_BANDA - 1)), hoy),
    f.store.cobertura(),
    leerCalendario(f, hoy, addDays(hoy, 7)),
  ]);

  // Hoy sin sueño o sin VFC en D1: el reloj sincronizó después del cron. Se lee
  // en vivo y, si trae algo, se guarda (con la misma regla que la sync: un día
  // con tres o más lecturas fallidas no se guarda, para que se vuelva a pedir).
  const filaHoy = bien.find((b) => b.fecha === hoy);
  if (f.bienestarEnVivo && (!filaHoy || filaHoy.sueno_seg === null || filaHoy.hrv_noche === null)) {
    try {
      const vivo = await f.bienestarEnVivo(hoy);
      const aporta = vivo.sueñoSegundos !== null || vivo.hrvNoche !== null || vivo.fcReposo !== null;
      if (aporta && vivo.fallos.length < 3) {
        await f.store.guardarDia(vivo);
        const fila: FilaBienestar = {
          fecha: hoy, fc_reposo: vivo.fcReposo, hrv_noche: vivo.hrvNoche, sueno_seg: vivo.sueñoSegundos,
          sueno_puntuacion: vivo.sueñoPuntuacion, readiness: vivo.readiness, carga_aguda: vivo.cargaAguda,
          carga_cronica: vivo.cargaCronica, peso_kg: filaHoy?.peso_kg ?? null, fallos: null,
          actualizado_en: new Date().toISOString(),
        };
        (fila as unknown as { datos: string }).datos = JSON.stringify(vivo);
        const i = bien.findIndex((b) => b.fecha === hoy);
        if (i >= 0) bien[i] = fila;
        else bien.push(fila);
      }
    } catch {
      // Sin Garmin en vivo se enseña lo que haya en D1, que ya dice de qué día es.
    }
  }

  // El día más reciente con algo leído, mirando como mucho dos días atrás.
  let bienestar: BienestarHoy | null = null;
  for (const fila of [...bien].reverse()) {
    if (fila.fecha < addDays(hoy, -2)) break;
    const d = datosDia(fila);
    if (fila.fc_reposo === null && fila.sueno_seg === null && !d) continue;
    bienestar = {
      fecha: fila.fecha,
      esHoy: fila.fecha === hoy,
      fc_reposo: fila.fc_reposo,
      hrv: fila.hrv_noche,
      hrv_estado: d?.hrvEstado ?? null,
      sueno_seg: fila.sueno_seg,
      sueno_puntuacion: fila.sueno_puntuacion,
      body_battery: d?.bodyBatteryAlto ?? null,
      readiness: fila.readiness,
      readiness_nivel: d?.readinessNivel ?? null,
      estado_entreno: d?.estadoEntreno ?? null,
    };
    break;
  }

  const carga = cargaDe(todas, hoy);
  const ultimo = carga.dias[carga.dias.length - 1];
  const deLaSemana = todas.filter((a) => a.fecha >= lunes && a.fecha <= hoy);

  return {
    hoy,
    cobertura,
    bienestar,
    bandas: bandas(bien),
    carga: ultimo
      ? { ctl: ultimo.ctl, atl: ultimo.atl, tsb: ultimo.tsb, fiable: hoy >= carga.fiableDesde }
      : null,
    hechas: todas.filter((a) => a.fecha === hoy).map(actividad),
    agenda: programados(cal.items),
    agendaError: cal.error,
    semana: {
      lunes,
      kmCarrera: deLaSemana.filter((a) => esCarrera(a.deporte)).reduce((s, a) => s + (a.distancia_m ?? 0) / 1000, 0),
      sesiones: deLaSemana.length,
      segundos: deLaSemana.reduce((s, a) => s + (a.segundos ?? 0), 0),
      diasActivos: new Set(deLaSemana.filter((a) => (a.segundos ?? 0) >= 600).map((a) => a.fecha)).size,
    },
  };
}

// -------------------------------------------------------------- semana

export interface DiaSemana {
  fecha: string;
  hechas: ActividadPanel[];
  /** Lo programado que no tiene actividad: lo que queda o lo que se saltó. */
  programado: Programado[];
}

export interface DatosSemana {
  hoy: string;
  lunes: string;
  kmCarrera: number;
  segundos: number;
  carga: number;
  sesiones: number;
  diasActivos: number;
  dias: DiaSemana[];
  agendaError: string | null;
}

export async function datosSemana(f: FuentesPanel, lunesPedido: string): Promise<DatosSemana> {
  const lunes = mondayOf(lunesPedido);
  const domingo = addDays(lunes, 6);
  const [acts, cal] = await Promise.all([
    f.store.actividades({ desde: lunes, hasta: domingo }),
    leerCalendario(f, lunes, domingo),
  ]);
  const plan = programados(cal.items);
  const dias: DiaSemana[] = [];
  for (let d = lunes; d <= domingo; d = addDays(d, 1)) {
    dias.push({
      fecha: d,
      hechas: acts.filter((a) => a.fecha === d).map(actividad),
      programado: plan.filter((p) => p.fecha === d && !p.completado),
    });
  }
  const s = semanas(acts, lunes, domingo)[0];
  return {
    hoy: f.hoy,
    lunes,
    kmCarrera: s?.kmCarrera ?? 0,
    segundos: s?.segundos ?? 0,
    carga: s?.carga ?? 0,
    sesiones: s?.sesiones ?? 0,
    diasActivos: new Set(acts.filter((a) => (a.segundos ?? 0) >= 600).map((a) => a.fecha)).size,
    dias,
    agendaError: cal.error,
  };
}

// ------------------------------------------------------------ progreso

export interface DatosProgreso {
  hoy: string;
  dias: number;
  cobertura: Cobertura;
  /** Una fila por día de la ventana pedida. */
  carga: Array<{ fecha: string; carga: number; ctl: number; atl: number; tsb: number }>;
  cargaFiableDesde: string;
  semanas: Array<{ lunes: string; kmCarrera: number; segundos: number; carga: number; sesiones: number }>;
  bandas: BandasPanel;
  /** Último valor de cada métrica, para situarlo dentro de su banda. */
  ultimo: { fc_reposo: number | null; hrv: number | null; sueno_h: number | null };
  marcas: Array<{ distancia: number; segundos: number; fecha: string; nombre: string | null }>;
}

export async function datosProgreso(f: FuentesPanel, dias: number): Promise<DatosProgreso> {
  const hoy = f.hoy;
  const desde = addDays(hoy, -(dias - 1));
  const [todas, bien, cobertura] = await Promise.all([
    f.store.actividades(),
    f.store.bienestar(addDays(hoy, -(DIAS_BANDA - 1)), hoy),
    f.store.cobertura(),
  ]);
  const carga = cargaDe(todas, hoy, desde);
  const ultimoDe = <T>(fn: (b: FilaBienestar) => T | null): T | null => {
    for (let i = bien.length - 1; i >= 0; i--) {
      const v = fn(bien[i]!);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  const marcas = [...marcasHistoricas(todas, 1).values()]
    .map((l) => l[0])
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) => ({ distancia: m.distancia, segundos: m.segundos, fecha: m.fecha, nombre: m.nombre }));
  return {
    hoy,
    dias,
    cobertura,
    carga: carga.dias
      .filter((d) => d.fecha >= desde)
      .map((d) => ({ fecha: d.fecha, carga: d.carga, ctl: d.ctl, atl: d.atl, tsb: d.tsb })),
    cargaFiableDesde: carga.fiableDesde,
    semanas: semanas(todas, desde, hoy).map((s) => ({
      lunes: s.lunes,
      kmCarrera: Math.round(s.kmCarrera * 10) / 10,
      segundos: s.segundos,
      carga: Math.round(s.carga),
      sesiones: s.sesiones,
    })),
    bandas: bandas(bien),
    ultimo: {
      fc_reposo: ultimoDe((b) => b.fc_reposo),
      hrv: ultimoDe((b) => b.hrv_noche),
      sueno_h: ultimoDe((b) => (b.sueno_seg ? b.sueno_seg / 3600 : null)),
    },
    marcas,
  };
}

// -------------------------------------------------------------- rachas

/** Mismas reglas que garmin_streaks: un día vacío es un día perdido, no un descanso. */
export async function datosRachas(
  f: FuentesPanel,
  dias = 120,
): Promise<{ rachas: RachasResultado; cobertura: Cobertura; calendarioLeido: boolean }> {
  const hoy = f.hoy;
  const desde = addDays(hoy, -(dias - 1));
  const [acts, bien, cal, cobertura] = await Promise.all([
    f.store.actividades({ desde, hasta: hoy }),
    f.store.bienestar(desde, hoy),
    f.calendario(desde, hoy).catch(() => null),
    f.store.cobertura(),
  ]);
  const eventos = (cal?.items ?? [])
    .filter((i) => i.activityId === null)
    .map((i) => ({
      fecha: i.fecha,
      categoria: i.workoutId !== null || i.tipo === "workout" ? "WORKOUT" : "NOTE",
      nombre: i.titulo,
      segundos: i.duracionSegundos,
    }));
  const agregados = agregarDias({
    hoy,
    desde,
    actividades: acts.map((a) => ({ fecha: a.fecha, deporte: a.deporte, segundos: a.segundos, carga: a.carga })),
    eventos,
    bienestar: bien.map((b) => ({ fecha: b.fecha, sueno_secs: b.sueno_seg })),
  });
  return {
    rachas: rachasDeDias(densificar(desde, hoy, agregados), { hoy }),
    cobertura,
    // Un mes que Garmin no dejó leer cuenta como no leído: sus descansos no se ven.
    calendarioLeido: cal !== null && cal.fallos.length === 0,
  };
}
