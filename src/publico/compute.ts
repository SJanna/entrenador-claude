/**
 * Agregados de la página pública de progreso (módulo opcional). Cálculo puro: sin red ni D1, para
 * poder probarlo con datos fijos y cuadrarlo contra lo que enseña intervals.icu.
 *
 * Qué sale de aquí y qué no:
 *  - Km por semana, la tirada más larga de cada semana, los hitos y el % de
 *    sesiones cumplidas; los totales desde el día 1 y la semana día a día.
 *  - Las sesiones de AYER, una a una (decisión del atleta, 23/10/2026): deporte,
 *    km, duración, ritmo, pulso medio y máximo y temperatura del clima. Siempre
 *    de ayer, nunca de hoy: lo publica el cron de la madrugada, así que nadie
 *    sabe en tiempo real si está fuera. El pulso entra porque es parte de la
 *    historia del calor; el resto de la salud (sueño, HRV, molestias) no.
 *  - Ninguna hora, ningún nombre de actividad, ningún lugar, ninguna coordenada.
 *    Los nombres de las actividades dicen dónde se corre («Rampa 1» puede ser la calle
 *    de casa): solo sirven, fuera de aquí, para descartar caminatas y terapia
 *    (`categoriaIntervals`), y no entran en el resultado.
 *  - `salud: null` sigue ahí: añadir más salud tiene que ser otra decisión
 *    explícita y no un campo que se cuela.
 */

import { addDays, mondayOf, weekdayMonday0 } from "../dates";

/** Lo que cuenta como km: lo que se camine dentro de una salida ya va dentro. */
export const TIPOS_CARRERA = new Set(["Run", "TrailRun", "VirtualRun"]);

/** Un maratón son 42,195 km; el GPS que mida menos se marca a mano. */
export const HITOS = [
  { clave: "horas3", etiqueta: "3 horas", km: null, segundos: 3 * 3600 },
  { clave: "supera_referencia", etiqueta: "Más de {ref} km", km: null },
  { clave: "maraton", etiqueta: "Maratón · 42,2 km", km: 42.195 },
  { clave: "noche", etiqueta: "Primera salida de noche", km: null },
  { clave: "km50", etiqueta: "50 km", km: 50 },
  { clave: "sol", etiqueta: "Sol de mediodía", km: null },
  { clave: "km70", etiqueta: "70 km", km: 70 },
  { clave: "km120", etiqueta: "120 km", km: 120 },
  { clave: "secreto", etiqueta: "Secreto", km: null },
] as const;

export type ClaveHito = (typeof HITOS)[number]["clave"];
export const CLAVES_HITO = HITOS.map((h) => h.clave) as readonly string[];

export interface Temporada {
  numero: number;
  nombre: string;
  desde: string;
  hasta: string;
}

export interface ActividadKm {
  fecha: string;
  tipo: string;
  km: number;
  /** Como sesión: null si no cuenta (caminata, terapia, otro deporte). */
  categoria?: Categoria | null;
  segundos?: number | null;
  fcMedia?: number | null;
  fcMax?: number | null;
  /** Temperatura del clima (no la del sensor del reloj, que calienta la muñeca). */
  temp?: number | null;
  /** Ritmo ajustado por pendiente, como velocidad en m/s. */
  gap?: number | null;
}

export interface PlanSemana {
  lunes: string;
  km: number;
}

export interface HitoManual {
  clave: string;
  fecha: string;
}

export interface CumplimientoDia {
  fecha: string;
  cumplida: boolean;
}

export interface EntradaProgreso {
  hoy: string;
  generado: string;
  diaD: string;
  temporadas: Temporada[];
  /** Todo el histórico: la marca de referencia sale de lo anterior a la T1. */
  actividades: ActividadKm[];
  plan: PlanSemana[];
  hitosManuales: HitoManual[];
  /** Una fila por sesión programada que cuenta, con si se cumplió (las de hoy se ignoran). */
  programadas: CumplimientoDia[];
  /** Último día cuyo cumplimiento se leyó de Garmin (null = nunca). */
  cumplimientoHasta: string | null;
  /** Suelos de las 5 zonas de FC del reloj (Garmin), de Z1 a Z5; sin ellos, los de siempre. */
  zonasFc?: number[] | null;
}

export interface SemanaPublica {
  lunes: string;
  temporada: number | null;
  km: number;
  km_plan: number | null;
  km_max: number;
  programadas: number;
  cumplidas: number;
  en_curso: boolean;
}

export interface Recuento {
  programadas: number;
  cumplidas: number;
  pct: number | null;
}

export interface HitoPublico {
  clave: string;
  etiqueta: string;
  km_objetivo: number | null;
  fecha: string | null;
  km: number | null;
  manual: boolean;
}

export interface SesionDia {
  deporte: Categoria;
  km: number | null;
  segundos: number | null;
  /** Segundos por km, solo en carrera. */
  ritmo: number | null;
  fc_media: number | null;
  fc_max: number | null;
  temp: number | null;
}

export interface DiaSemana {
  fecha: string;
  km: number;
  sesiones: Categoria[];
}

export interface PulsoFijo {
  pulso: number;
  /** Techo de la zona 1: los rodajes que cuentan van de 125 a aquí. */
  techo_z1: number;
  semanas: Array<{ lunes: string; ritmo: number; sesiones: number; temp: number | null }>;
}

export interface Prediccion {
  segundos: number;
  km_base: number;
  fecha_base: string;
  exponente: number;
  semanas: Array<{ lunes: string; segundos: number }>;
}

export interface ProgresoPublico {
  version: 1;
  generado: string;
  datos_hasta: string;
  dia_d: { fecha: string; dias: number };
  temporadas: Temporada[];
  temporada_actual: number | null;
  semanas: SemanaPublica[];
  tirada_larga: { km: number; fecha: string } | null;
  referencia: { km: number; fecha: string } | null;
  hitos: HitoPublico[];
  cumplimiento: { total: Recuento; desde_t1: Recuento | null; hasta: string | null };
  racha_semanas: { actual: number; mejor: number };
  /** Las sesiones de ayer; sin sesiones = descanso. null antes del día 1. */
  ayer: { fecha: string; sesiones: SesionDia[] } | null;
  /** La semana de ayer, de lunes a ayer. */
  semana_dias: { lunes: string; dias: DiaSemana[] } | null;
  /** Desde el día 1 hasta ayer. */
  totales: { km: number; horas: number; sesiones: number; desde: string } | null;
  /** Ritmo equivalente a PULSO_FIJO ppm en rodajes suaves, semana a semana. */
  test_pulso_fijo: PulsoFijo | null;
  /** «Si fuera hoy»: 120 km extrapolados de la tirada aeróbica más larga reciente. */
  prediccion: Prediccion | null;
  // Versión 2: la página no pinta un bloque que venga a null.
  ruta: null;
  live: null;
  salud: null;
}

/** Un decimal, que es lo que da de sí un GPS. */
export function redondear(km: number): number {
  return Math.round(km * 10) / 10;
}

export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
}

/** La temporada de un día, o null si cae fuera de todas. */
export function temporadaDe(fecha: string, temporadas: Temporada[]): number | null {
  const t = temporadas.find((x) => x.desde <= fecha && fecha <= x.hasta);
  return t ? t.numero : null;
}

function recuento(programadas: number, cumplidas: number): Recuento {
  return {
    programadas,
    cumplidas,
    pct: programadas ? Math.round((100 * cumplidas) / programadas) : null,
  };
}

/** `31.1` → `31,1`; `31` → `31`. */
function kmTexto(km: number): string {
  return String(redondear(km)).replace(".", ",");
}

export function calcularProgreso(e: EntradaProgreso): ProgresoPublico {
  const temporadas = [...e.temporadas].sort((a, b) => a.numero - b.numero);
  const t1 = temporadas.find((t) => t.numero === 1);
  const fin = temporadas[temporadas.length - 1]?.hasta ?? e.diaD;
  // La serie cuenta desde la T1 (decisión del atleta, 10/11/2026): el Prólogo
  // (T0) está en el calendario, pero no suma km, semanas, sesiones ni récord.
  const inicioSerie = t1?.desde ?? temporadas[0]?.desde ?? e.hoy;
  const finSerie = e.hoy < fin ? e.hoy : fin;

  const carrera = e.actividades
    .filter((a) => TIPOS_CARRERA.has(a.tipo) && Number.isFinite(a.km) && a.km > 0)
    .sort((a, b) => (a.fecha === b.fecha ? b.km - a.km : a.fecha.localeCompare(b.fecha)));

  // ------------------------------------------------------------- semanas
  const plan = new Map(e.plan.map((p) => [p.lunes, p.km]));
  const programadasPorSemana = new Map<string, { p: number; c: number }>();
  for (const s of e.programadas) {
    // Hoy no cuenta hasta que acabe: una sesión de esta tarde no es un fallo.
    if (s.fecha < inicioSerie || s.fecha > finSerie || s.fecha >= e.hoy) continue;
    const lunes = mondayOf(s.fecha);
    const acc = programadasPorSemana.get(lunes) ?? { p: 0, c: 0 };
    acc.p += 1;
    if (s.cumplida) acc.c += 1;
    programadasPorSemana.set(lunes, acc);
  }

  const semanas: SemanaPublica[] = [];
  if (inicioSerie <= finSerie) {
    for (let lunes = mondayOf(inicioSerie); lunes <= finSerie; lunes = addDays(lunes, 7)) {
      const domingo = addDays(lunes, 6);
      const desde = lunes < inicioSerie ? inicioSerie : lunes;
      const de = carrera.filter((a) => a.fecha >= desde && a.fecha <= domingo);
      const cum = programadasPorSemana.get(lunes) ?? { p: 0, c: 0 };
      semanas.push({
        lunes,
        // La del jueves: así una semana partida entre dos temporadas va con
        // la que tiene más días.
        temporada: temporadaDe(addDays(lunes, 3), temporadas),
        km: redondear(de.reduce((s, a) => s + a.km, 0)),
        km_plan: plan.has(lunes) ? redondear(plan.get(lunes)!) : null,
        km_max: redondear(de.reduce((m, a) => Math.max(m, a.km), 0)),
        programadas: cum.p,
        cumplidas: cum.c,
        en_curso: domingo >= e.hoy,
      });
    }
  }

  // ---------------------------------------------------- tirada más larga
  const mayor = (lista: ActividadKm[]): ActividadKm | null =>
    lista.reduce<ActividadKm | null>((m, a) => (!m || a.km > m.km ? a : m), null);
  const larga = mayor(carrera.filter((a) => a.fecha >= inicioSerie && a.fecha <= finSerie));
  const previa = t1 ? mayor(carrera.filter((a) => a.fecha < t1.desde)) : null;

  // --------------------------------------------------------------- hitos
  const manuales = new Map(e.hitosManuales.map((h) => [h.clave, h.fecha]));
  const desdeT1 = t1 ? carrera.filter((a) => a.fecha >= t1.desde && a.fecha <= e.hoy) : [];
  const hitos: HitoPublico[] = HITOS.map((h) => {
    const umbral = h.clave === "supera_referencia" ? (previa?.km ?? null) : h.km;
    const etiqueta = h.etiqueta.replace("{ref}", previa ? kmTexto(previa.km) : "—");
    const manual = manuales.get(h.clave);
    if (manual) {
      return { clave: h.clave, etiqueta, km_objetivo: umbral, fecha: manual, km: null, manual: true };
    }
    // Por duración: la primera salida desde la T1 que dura eso o más.
    if ("segundos" in h) {
      const dura = desdeT1.find((a) => (a.segundos ?? 0) >= h.segundos) ?? null;
      return { clave: h.clave, etiqueta, km_objetivo: null, fecha: dura?.fecha ?? null, km: dura ? redondear(dura.km) : null, manual: false };
    }
    // La referencia se SUPERA (más de); las distancias redondas se alcanzan.
    const cae =
      umbral === null
        ? null
        : desdeT1.find((a) =>
            h.clave === "supera_referencia" ? redondear(a.km) > redondear(umbral) : a.km >= umbral,
          ) ?? null;
    return {
      clave: h.clave,
      etiqueta,
      km_objetivo: umbral === null ? null : redondear(umbral),
      fecha: cae?.fecha ?? null,
      km: cae ? redondear(cae.km) : null,
      manual: false,
    };
  });

  // ------------------------------------------------- ayer, semana, totales
  // Hasta ayer: lo de hoy no sale hasta mañana.
  const ayer = addDays(e.hoy, -1);
  const conDatos = ayer >= inicioSerie && ayer <= fin;
  const sesiones = e.actividades.filter((a) => a.categoria && a.fecha >= inicioSerie && a.fecha <= ayer);
  const entero = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
  const sesionDia = (a: ActividadKm): SesionDia => {
    const km = a.categoria === "fuerza" || !(a.km > 0) ? null : Math.round(a.km * 100) / 100;
    const segundos = entero(a.segundos);
    return {
      deporte: a.categoria!,
      km,
      segundos,
      ritmo: a.categoria === "carrera" && km && segundos ? Math.round(segundos / km) : null,
      fc_media: entero(a.fcMedia),
      fc_max: entero(a.fcMax),
      temp: a.temp != null && Number.isFinite(a.temp) ? Math.round(a.temp * 10) / 10 : null,
    };
  };
  const lunesAyer = mondayOf(ayer);
  const dias: DiaSemana[] = [];
  if (conDatos) {
    for (let f = lunesAyer < inicioSerie ? inicioSerie : lunesAyer; f <= ayer; f = addDays(f, 1)) {
      dias.push({
        fecha: f,
        km: redondear(carrera.filter((a) => a.fecha === f).reduce((s, a) => s + a.km, 0)),
        sesiones: sesiones.filter((a) => a.fecha === f).map((a) => a.categoria!),
      });
    }
  }

  const zonas = zonasDe(e.zonasFc);

  // -------------------------------------------------------- cumplimiento
  let total = { p: 0, c: 0 };
  let t1Acc = { p: 0, c: 0 };
  for (const s of semanas) {
    total = { p: total.p + s.programadas, c: total.c + s.cumplidas };
    if (s.temporada !== null && s.temporada >= 1) {
      t1Acc = { p: t1Acc.p + s.programadas, c: t1Acc.c + s.cumplidas };
    }
  }

  return {
    version: 1,
    generado: e.generado,
    datos_hasta: e.hoy,
    dia_d: { fecha: e.diaD, dias: diasEntre(e.hoy, e.diaD) },
    temporadas,
    temporada_actual: temporadaDe(e.hoy, temporadas),
    semanas,
    tirada_larga: larga ? { km: redondear(larga.km), fecha: larga.fecha } : null,
    referencia: previa ? { km: redondear(previa.km), fecha: previa.fecha } : null,
    hitos,
    cumplimiento: {
      total: recuento(total.p, total.c),
      desde_t1: t1 && e.hoy >= t1.desde ? recuento(t1Acc.p, t1Acc.c) : null,
      hasta: e.cumplimientoHasta,
    },
    racha_semanas: rachaSemanas(semanas),
    ayer: conDatos ? { fecha: ayer, sesiones: sesiones.filter((a) => a.fecha === ayer).map(sesionDia) } : null,
    semana_dias: conDatos ? { lunes: lunesAyer, dias } : null,
    totales: conDatos
      ? {
          km: redondear(carrera.filter((a) => a.fecha >= inicioSerie && a.fecha <= ayer).reduce((s, a) => s + a.km, 0)),
          horas: Math.round(sesiones.reduce((s, a) => s + (a.segundos ?? 0), 0) / 360) / 10,
          sesiones: sesiones.length,
          desde: inicioSerie,
        }
      : null,
    test_pulso_fijo: conDatos ? pulsoFijo(carreraSesiones(e.actividades, inicioSerie, ayer), zonas) : null,
    prediccion: conDatos
      ? prediccion(carreraSesiones(e.actividades, inicioSerie, ayer), inicioSerie, ayer, zonas)
      : null,
    ruta: null,
    live: null,
    salud: null,
  };
}

// ------------------------------------------------------------------------
// Ritmo a pulso fijo y predicción. Las dos miran el esfuerzo aeróbico, con
// el ritmo ajustado por pendiente (GAP): buena parte de los rodajes son en
// rampas, y sin GAP una semana de cuestas parecería una semana peor.

/**
 * Las zonas son las 5 del reloj (Garmin), que son con las que entrena el
 * atleta. Rodaje suave = hasta el techo de la Z1, desde 125 ppm (por debajo es
 * caminar cuesta arriba). Pulso de referencia = el centro de la Z1. Esfuerzo
 * aeróbico para predecir = hasta el techo de la Z2.
 */
const SUAVE = { fcMin: 125, minSegundos: 20 * 60 };
const AEROBICO = { minKm: 10 };
export interface Zonas {
  /** Suelo y techo de la Z1, techo de la Z2. */
  z1Suelo: number;
  z1: number;
  z2: number;
}
/** Las de Garmin a 23/10/2026 (Z1 134–154, Z2 155–171), por si la lectura falla. */
export const ZONAS_POR_DEFECTO: Zonas = { z1Suelo: 134, z1: 154, z2: 171 };

export function zonasDe(suelos: number[] | null | undefined): Zonas {
  const [s1, s2, s3] = (suelos ?? []).map(Number);
  const ok = [s1, s2, s3].every((v) => Number.isFinite(v)) && s1! > SUAVE.fcMin && s2! > s1! && s3! > s2!;
  return ok ? { z1Suelo: s1!, z1: s2! - 1, z2: s3! - 1 } : ZONAS_POR_DEFECTO;
}
/** El pulso de referencia: el centro de la Z1. */
export function pulsoReferencia(z: Zonas): number {
  return Math.round((z.z1Suelo + z.z1) / 2);
}
/** Riegel con el exponente de ultra: el clásico 1,06 promete demasiado a 120 km. */
export const EXPONENTE_RIEGEL = 1.15;
const VENTANA_PREDICCION = 56;

function carreraSesiones(actividades: ActividadKm[], desde: string, hasta: string): ActividadKm[] {
  return actividades.filter(
    (a) => a.categoria === "carrera" && a.fecha >= desde && a.fecha <= hasta && (a.gap ?? 0) > 0 && (a.fcMedia ?? 0) > 0,
  );
}

/**
 * Eficiencia = velocidad GAP / pulso, media ponderada por tiempo; el ritmo a
 * PULSO_FIJO es la velocidad que esa eficiencia da a ese pulso. Supone que
 * velocidad y pulso van en proporción dentro de la zona suave, que es lo que
 * hace el factor de eficiencia de toda la vida. No corrige el calor: la
 * temperatura sale al lado, porque es parte de la historia.
 */
export function pulsoFijo(sesiones: ActividadKm[], zonas: Zonas = ZONAS_POR_DEFECTO): PulsoFijo | null {
  const suaves = sesiones.filter(
    (a) => a.fcMedia! >= SUAVE.fcMin && a.fcMedia! <= zonas.z1 && (a.segundos ?? 0) >= SUAVE.minSegundos,
  );
  const pulso = pulsoReferencia(zonas);
  const porSemana = new Map<string, ActividadKm[]>();
  for (const a of suaves) {
    const lunes = mondayOf(a.fecha);
    porSemana.set(lunes, [...(porSemana.get(lunes) ?? []), a]);
  }
  const semanas = [...porSemana.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lunes, lista]) => {
      const peso = lista.reduce((s, a) => s + a.segundos!, 0);
      const eficiencia = lista.reduce((s, a) => s + (a.gap! / a.fcMedia!) * a.segundos!, 0) / peso;
      const conTemp = lista.filter((a) => a.temp != null && Number.isFinite(a.temp));
      return {
        lunes,
        ritmo: Math.round(1000 / (eficiencia * pulso)),
        sesiones: lista.length,
        temp: conTemp.length ? Math.round((conTemp.reduce((s, a) => s + a.temp!, 0) / conTemp.length) * 10) / 10 : null,
      };
    });
  return semanas.length ? { pulso, techo_z1: zonas.z1, semanas } : null;
}

/** Riegel: el tiempo GAP de la base, llevado a 120 km. */
function riegel(a: ActividadKm): number {
  const segundosGap = (a.km * 1000) / a.gap!;
  return segundosGap * Math.pow(120 / a.km, EXPONENTE_RIEGEL);
}

/** La base de cada fecha: la tirada aeróbica más larga de las 8 semanas anteriores. */
function baseHasta(sesiones: ActividadKm[], hasta: string, zonas: Zonas): ActividadKm | null {
  const desde = addDays(hasta, -(VENTANA_PREDICCION - 1));
  return sesiones
    .filter((a) => a.fecha >= desde && a.fecha <= hasta && a.km >= AEROBICO.minKm && a.fcMedia! <= zonas.z2)
    .reduce<ActividadKm | null>((m, a) => (!m || a.km > m.km || (a.km === m.km && riegel(a) < riegel(m)) ? a : m), null);
}

export function prediccion(
  sesiones: ActividadKm[],
  inicioSerie: string,
  ayer: string,
  zonas: Zonas = ZONAS_POR_DEFECTO,
): Prediccion | null {
  const base = baseHasta(sesiones, ayer, zonas);
  if (!base) return null;
  const semanas: Prediccion["semanas"] = [];
  for (let lunes = mondayOf(inicioSerie); lunes <= ayer; lunes = addDays(lunes, 7)) {
    const fin = addDays(lunes, 6) < ayer ? addDays(lunes, 6) : ayer;
    const b = baseHasta(sesiones, fin, zonas);
    if (b) semanas.push({ lunes, segundos: Math.round(riegel(b)) });
  }
  return {
    segundos: Math.round(riegel(base)),
    km_base: redondear(base.km),
    fecha_base: base.fecha,
    exponente: EXPONENTE_RIEGEL,
    semanas,
  };
}

/**
 * Semanas seguidas con algún km de carrera. Una semana en blanco es la que
 * acaba con 0 km: el patrón que esto vigila es pico → parón.
 * La semana en curso suma si ya tiene km y no rompe nada mientras no acabe.
 */
export function rachaSemanas(semanas: SemanaPublica[]): { actual: number; mejor: number } {
  let mejor = 0;
  let corrida = 0;
  for (const s of semanas) {
    if (s.km > 0) {
      corrida += 1;
      mejor = Math.max(mejor, corrida);
    } else if (!s.en_curso) {
      corrida = 0;
    }
  }
  return { actual: corrida, mejor };
}

// ------------------------------------------------------------------------
// Cumplimiento: qué sesiones programadas cuentan y cuándo se dan por hechas.

export type Categoria = "carrera" | "fuerza" | "natacion";

/**
 * Caminatas y terapia de una lesión no cuentan: inflarían el % con sesiones de
 * diez minutos. Se reconocen por el nombre porque en Garmin la terapia es
 * `strength_training` igual que la fuerza de piernas, y alguna caminata está
 * guardada como `running`. «Colgado» es un ejercicio de rehabilitación del brazo.
 */
const EXCLUIDAS = /terapia|colgado|caminata|caminar|paseo/i;

const DEPORTES: Record<string, Categoria> = {
  running: "carrera",
  trail_running: "carrera",
  treadmill_running: "carrera",
  track_running: "carrera",
  indoor_running: "carrera",
  virtual_run: "carrera",
  street_running: "carrera",
  strength_training: "fuerza",
  swimming: "natacion",
  lap_swimming: "natacion",
  open_water_swimming: "natacion",
};

/** Lo mismo con los tipos de intervals.icu, para las sesiones de la página. */
const TIPOS_INTERVALS: Record<string, Categoria> = {
  Run: "carrera",
  TrailRun: "carrera",
  VirtualRun: "carrera",
  WeightTraining: "fuerza",
  Swim: "natacion",
  OpenWaterSwim: "natacion",
};
export function categoriaIntervals(tipo: string, nombre: string): Categoria | null {
  if (EXCLUIDAS.test(nombre)) return null;
  return TIPOS_INTERVALS[tipo] ?? null;
}

export function categoriaDe(deporte: string | null, nombre: string): Categoria | null {
  if (!deporte || EXCLUIDAS.test(nombre)) return null;
  return DEPORTES[deporte.toLowerCase()] ?? null;
}

export interface SesionProgramada {
  id: string;
  fecha: string;
  categoria: Categoria;
  segundos: number | null;
}

export interface SesionHecha {
  fecha: string;
  categoria: Categoria;
  segundos: number;
}

/**
 * Cumplida = una actividad del mismo deporte el mismo día con al menos la mitad
 * de la duración programada. Hacer de más cuenta: esto mide si apareció, no si
 * obedeció. Cada actividad cubre UNA sesión: dos rodajes programados y uno
 * hecho son uno de dos.
 *
 * Se empareja para cubrir el máximo de sesiones: las de menor exigencia
 * primero, cada una con la actividad más corta que le basta.
 */
export function emparejar(programadas: SesionProgramada[], hechas: SesionHecha[]): Set<string> {
  const cumplidas = new Set<string>();
  const grupos = new Map<string, { p: SesionProgramada[]; h: number[] }>();
  const clave = (fecha: string, categoria: string) => `${fecha}|${categoria}`;
  for (const p of programadas) {
    const k = clave(p.fecha, p.categoria);
    const g = grupos.get(k) ?? { p: [], h: [] };
    g.p.push(p);
    grupos.set(k, g);
  }
  for (const h of hechas) {
    const g = grupos.get(clave(h.fecha, h.categoria));
    if (g) g.h.push(h.segundos);
  }
  for (const g of grupos.values()) {
    const exigencia = (p: SesionProgramada) => (p.segundos ?? 0) * 0.5;
    const ps = [...g.p].sort((a, b) => exigencia(a) - exigencia(b));
    const hs = [...g.h].sort((a, b) => a - b);
    let i = 0;
    for (const segundos of hs) {
      const p = ps[i];
      if (!p) break;
      if (segundos >= exigencia(p)) {
        cumplidas.add(p.id);
        i += 1;
      }
    }
  }
  return cumplidas;
}

// ------------------------------------------------------------------------
// Validación de lo que se escribe con set_plan_publico.

export const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export function esFecha(valor: unknown): valor is string {
  return typeof valor === "string" && FECHA.test(valor) && !Number.isNaN(Date.parse(`${valor}T00:00:00Z`));
}

/**
 * El planificado se congela el lunes. Antes del lunes se cambia libremente; el
 * propio lunes solo se puede escribir si la semana aún no tenía plan (se cargó
 * tarde); desde el martes, no se toca.
 */
export function motivoCongelado(lunes: string, hoy: string, existe: boolean): string | null {
  if (hoy < lunes) return null;
  if (hoy === lunes && !existe) return null;
  return hoy === lunes
    ? `la semana del ${lunes} ya tiene plan y se congeló hoy (lunes)`
    : `la semana del ${lunes} está congelada desde su lunes`;
}

export function esLunes(fecha: string): boolean {
  return weekdayMonday0(fecha) === 0;
}

export function esFinDeSemana(fecha: string): boolean {
  return weekdayMonday0(fecha) >= 5;
}

/** Errores del juego completo de temporadas; vacío si es válido. */
export function erroresTemporadas(temporadas: Temporada[], diaD: string): string[] {
  const errores: string[] = [];
  const orden = [...temporadas].sort((a, b) => a.numero - b.numero);
  if (orden.map((t) => t.numero).join(",") !== "0,1,2,3,4") {
    errores.push("tiene que haber exactamente cinco temporadas, de la 0 a la 4");
    return errores;
  }
  if (!esFecha(diaD)) errores.push(`el día D no es una fecha: ${diaD}`);
  else if (!esFinDeSemana(diaD)) errores.push(`el día D (${diaD}) tiene que caer en sábado o domingo`);
  orden.forEach((t, i) => {
    const nombre = t.nombre.trim();
    if (!nombre || nombre.length > 30) errores.push(`T${t.numero}: el nombre tiene que tener 1-30 caracteres`);
    if (!esFecha(t.desde) || !esFecha(t.hasta)) {
      errores.push(`T${t.numero}: fechas YYYY-MM-DD`);
      return;
    }
    if (t.desde > t.hasta) errores.push(`T${t.numero}: empieza (${t.desde}) después de acabar (${t.hasta})`);
    const siguiente = orden[i + 1];
    if (siguiente && esFecha(siguiente.desde) && siguiente.desde !== addDays(t.hasta, 1)) {
      errores.push(
        `T${siguiente.numero} tiene que empezar el día después de que acabe T${t.numero} ` +
          `(${addDays(t.hasta, 1)}), no el ${siguiente.desde}`,
      );
    }
  });
  const t4 = orden[4]!;
  if (esFecha(diaD) && t4.hasta !== diaD) {
    errores.push(`T4 tiene que acabar el día D (${diaD}), no el ${t4.hasta}`);
  }
  return errores;
}
