/**
 * Actividades de Garmin, y sobre todo las SERIES de fuerza.
 *
 * Este es el dato que justificaba conectar con Garmin directamente. Una sesión
 * de fuerza en intervals.icu es un bloque de minutos y una carga estimada; lo
 * que hace falta para subir una escalera de carga es qué ejercicio, cuántas
 * repeticiones y con cuánto peso, serie a serie. Eso solo vive en Garmin, en un
 * endpoint aparte del de la actividad.
 *
 * Los ejercicios vienen como enums de Garmin (`BENCH_PRESS` / `BARBELL_BENCH_PRESS`).
 * Se muestran legibles PERO sin perder el enum: es lo que hay que escribir para
 * que un entreno de fuerza llegue al reloj con el nombre del ejercicio en vez de
 * con una categoría genérica.
 */

import type { GarminCliente } from "./cliente";

export const MAX_ACTIVIDADES = 50;

export interface Actividad {
  id: number;
  nombre: string;
  fecha: string;
  hora: string;
  deporte: string;
  segundos: number | null;
  distanciaM: number | null;
  fcMedia: number | null;
  fcMax: number | null;
  calorias: number | null;
  desnivelM: number | null;
  efectoAerobico: number | null;
  efectoAnaerobico: number | null;
  /** activityTrainingLoad: la carga de Garmin, base del CTL/ATL del histórico. */
  carga: number | null;
  segundosMov: number | null;
  /** Ritmo ajustado por pendiente (GAP) de Garmin, en m/s. Solo a pie; si no viene, null. */
  gapMs?: number | null;
}

export interface SerieFuerza {
  orden: number;
  /** ACTIVE o REST: Garmin guarda los descansos como series también. */
  tipo: string;
  /** Nombre legible del ejercicio. */
  ejercicio: string;
  /** El enum de Garmin, que es lo que hay que escribir para prescribirlo. */
  categoria: string | null;
  enum: string | null;
  repeticiones: number | null;
  pesoKg: number | null;
  segundos: number | null;
}

/**
 * Una vuelta (lap) de la actividad. Con un entreno cargado en el reloj, cada
 * paso del entreno es al menos una vuelta: calentamiento, cada serie, cada
 * recuperación, la vuelta a la calma. Es lo que hace falta para saber si una
 * serie se cumplió, no la media de la sesión entera.
 */
export interface Vuelta {
  numero: number;
  /** WARMUP, ACTIVE, INTERVAL, RECOVERY, REST, COOLDOWN… tal y como lo da Garmin. */
  intensidad: string | null;
  /** Paso del entreno al que pertenece, contando desde 1. null sin entreno. */
  paso: number | null;
  segundos: number | null;
  distanciaM: number | null;
  /** Velocidad media en m/s. */
  velocidad: number | null;
  /** Ritmo ajustado por pendiente (GAP) en m/s, si Garmin lo da. */
  gap: number | null;
  fcMedia: number | null;
  fcMax: number | null;
  cadencia: number | null;
  potencia: number | null;
  desnivelM: number | null;
}

function numero(valor: unknown): number | null {
  if (valor === null || valor === undefined || typeof valor === "boolean") return null;
  const n = typeof valor === "number" ? valor : Number(valor);
  return Number.isFinite(n) ? n : null;
}

function texto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : "";
}

/**
 * `BARBELL_BENCH_PRESS` → `Barbell bench press`.
 *
 * `UNKNOWN` merece trato aparte: es lo que pone Garmin cuando el reloj no
 * reconoció el movimiento, y escribirlo como «Unknown» lo hace pasar por el
 * nombre de un ejercicio. No lo es: es un hueco.
 */
export function legible(nombre: string): string {
  const limpio = nombre.replaceAll("_", " ").trim().toLowerCase();
  if (!limpio) return "";
  if (limpio === "unknown") return "(sin identificar)";
  return limpio[0]!.toUpperCase() + limpio.slice(1);
}

export function normalizarActividad(bruto: unknown): Actividad | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const a = bruto as Record<string, unknown>;
  const id = numero(a.activityId);
  if (id === null) return null;
  const inicio = texto(a.startTimeLocal) || texto(a.startTimeGMT);
  return {
    id,
    nombre: texto(a.activityName) || "(sin nombre)",
    fecha: inicio.slice(0, 10),
    hora: inicio.slice(11, 16),
    deporte:
      texto((a.activityType as Record<string, unknown> | undefined)?.typeKey) ||
      texto(a.activityType) ||
      "—",
    segundos: numero(a.duration),
    distanciaM: numero(a.distance),
    fcMedia: numero(a.averageHR),
    fcMax: numero(a.maxHR),
    calorias: numero(a.calories),
    desnivelM: numero(a.elevationGain),
    efectoAerobico: numero(a.aerobicTrainingEffect),
    efectoAnaerobico: numero(a.anaerobicTrainingEffect),
    carga: numero(a.activityTrainingLoad),
    segundosMov: numero(a.movingDuration),
    gapMs: positivo(a.avgGradeAdjustedSpeed),
  };
}

function positivo(valor: unknown): number | null {
  const n = numero(valor);
  return n !== null && n > 0 ? n : null;
}

/**
 * Temperatura del CLIMA durante una actividad (no la del sensor del reloj, que
 * la muñeca calienta), en °C. Garmin la da en °F en `temp`. null si la
 * actividad no tiene clima (cinta, sin GPS) o si el dato es imposible.
 */
export async function leerClima(cliente: GarminCliente, id: number): Promise<number | null> {
  const datos = await json(cliente, `/activity-service/activity/${id}/weather`);
  return climaDe(datos);
}

export function climaDe(datos: unknown): number | null {
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) return null;
  const f = numero((datos as Record<string, unknown>).temp);
  if (f === null) return null;
  const c = Math.round(((f - 32) * 5) / 9 * 10) / 10;
  return c >= -30 && c <= 55 ? c : null;
}

export function normalizarSeries(bruto: unknown): SerieFuerza[] {
  const raiz = bruto && typeof bruto === "object" ? (bruto as Record<string, unknown>) : {};
  const lista = Array.isArray(raiz.exerciseSets)
    ? raiz.exerciseSets
    : Array.isArray(bruto)
      ? bruto
      : [];

  const series: SerieFuerza[] = [];
  lista.forEach((crudo, indice) => {
    if (!crudo || typeof crudo !== "object") return;
    const set = crudo as Record<string, unknown>;
    // Garmin puede dar varios candidatos con su probabilidad; el primero es el
    // que la app enseña.
    const ejercicios = Array.isArray(set.exercises) ? set.exercises : [];
    const primero = (ejercicios[0] ?? {}) as Record<string, unknown>;
    const categoria = texto(primero.category) || null;
    const nombreEnum = texto(primero.name) || null;
    const gramos = numero(set.weight);
    series.push({
      orden: indice + 1,
      tipo: (texto(set.setType) || "?").toUpperCase(),
      ejercicio: legible(nombreEnum ?? categoria ?? "") || "—",
      categoria,
      enum: nombreEnum,
      repeticiones: numero(set.repetitionCount),
      // Garmin guarda el peso en gramos aunque la unidad diga kilogramos.
      pesoKg: gramos === null ? null : Math.round((gramos / 1000) * 100) / 100,
      segundos: numero(set.duration),
    });
  });
  return series;
}

/** Las vueltas de `/activity-service/activity/{id}/splits` (lapDTOs). */
export function normalizarVueltas(bruto: unknown): Vuelta[] {
  const raiz = bruto && typeof bruto === "object" && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : {};
  const lista = Array.isArray(raiz.lapDTOs) ? raiz.lapDTOs : Array.isArray(bruto) ? bruto : [];
  const vueltas: Vuelta[] = [];
  lista.forEach((crudo) => {
    if (!crudo || typeof crudo !== "object") return;
    const v = crudo as Record<string, unknown>;
    const paso = numero(v.wktStepIndex);
    vueltas.push({
      numero: vueltas.length + 1,
      intensidad: texto(v.intensityType).toUpperCase() || null,
      // El reloj numera los pasos desde 0; garmin_get_workout, desde 1.
      paso: paso === null || paso < 0 ? null : paso + 1,
      segundos: positivo(v.duration ?? v.elapsedDuration),
      distanciaM: positivo(v.distance),
      velocidad: positivo(v.averageSpeed ?? v.averageMovingSpeed),
      gap: positivo(v.avgGradeAdjustedSpeed),
      fcMedia: positivo(v.averageHR),
      fcMax: positivo(v.maxHR),
      cadencia: positivo(v.averageRunCadence ?? v.averageBikeCadence ?? v.averageSwimCadence),
      potencia: positivo(v.averagePower),
      desnivelM: numero(v.elevationGain),
    });
  });
  return vueltas;
}

async function json(cliente: GarminCliente, ruta: string): Promise<unknown> {
  const respuesta = await cliente.api(ruta);
  if (respuesta.status === 204 || respuesta.status === 404) {
    await respuesta.body?.cancel();
    return null;
  }
  const cuerpo = await respuesta.text();
  if (!respuesta.ok) {
    throw new Error(`Garmin respondió ${respuesta.status} a ${ruta}`);
  }
  return cuerpo.trim() ? JSON.parse(cuerpo) : null;
}

export async function listarActividades(
  cliente: GarminCliente,
  opciones: { limite: number; desde?: string; hasta?: string; deporte?: string; inicio?: number },
): Promise<Actividad[]> {
  const query = new URLSearchParams({
    start: String(opciones.inicio ?? 0),
    limit: String(opciones.limite),
  });
  if (opciones.desde) query.set("startDate", opciones.desde);
  if (opciones.hasta) query.set("endDate", opciones.hasta);
  if (opciones.deporte) query.set("activityType", opciones.deporte);
  const datos = await json(
    cliente,
    `/activitylist-service/activities/search/activities?${query}`,
  );
  return (Array.isArray(datos) ? datos : [])
    .map(normalizarActividad)
    .filter((a): a is Actividad => a !== null);
}

export async function leerActividad(
  cliente: GarminCliente,
  id: number,
): Promise<{
  actividad: Actividad | null;
  series: SerieFuerza[];
  avisoSeries: string | null;
  vueltas: Vuelta[];
  avisoVueltas: string | null;
}> {
  const detalle = await json(cliente, `/activity-service/activity/${id}`);
  const actividad = normalizarActividad({
    activityId: id,
    ...(detalle && typeof detalle === "object" && !Array.isArray(detalle)
      ? {
          ...(detalle as Record<string, unknown>),
          // El detalle mete lo bueno en summaryDTO; la lista lo trae plano.
          ...((detalle as Record<string, unknown>).summaryDTO as Record<string, unknown>),
          activityName: (detalle as Record<string, unknown>).activityName,
          activityType: (detalle as Record<string, unknown>).activityTypeDTO
            ? ((detalle as Record<string, unknown>).activityTypeDTO as Record<string, unknown>)
            : (detalle as Record<string, unknown>).activityType,
        }
      : {}),
  });

  let series: SerieFuerza[] = [];
  let avisoSeries: string | null = null;
  try {
    series = normalizarSeries(await json(cliente, `/activity-service/activity/${id}/exerciseSets`));
  } catch (exc) {
    avisoSeries = exc instanceof Error ? exc.message : String(exc);
  }
  let vueltas: Vuelta[] = [];
  let avisoVueltas: string | null = null;
  try {
    vueltas = normalizarVueltas(await json(cliente, `/activity-service/activity/${id}/splits`));
  } catch (exc) {
    avisoVueltas = exc instanceof Error ? exc.message : String(exc);
  }
  return { actividad, series, avisoSeries, vueltas, avisoVueltas };
}

// ------------------------------------------------------------------ formato

function duracion(segundos: number | null): string {
  if (segundos === null || segundos <= 0) return "—";
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = Math.round(segundos % 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : m ? `${m}:${String(s).padStart(2, "0")}` : `${s} s`;
}

function num(valor: number | null, decimales = 0): string {
  return valor === null ? "—" : valor.toFixed(decimales);
}

export function formatearActividades(actividades: Actividad[]): string {
  if (!actividades.length) return "No hay actividades de Garmin en ese periodo.";
  return [
    `${actividades.length} actividades de Garmin (las más recientes primero):`,
    "        id  fecha       hora   deporte              duración   dist km  FCmed  nombre",
    ...actividades.map((a) =>
      [
        String(a.id).padStart(10),
        a.fecha,
        a.hora.padStart(5),
        a.deporte.padEnd(20).slice(0, 20),
        duracion(a.segundos).padStart(9),
        (a.distanciaM === null ? "—" : (a.distanciaM / 1000).toFixed(2)).padStart(8),
        num(a.fcMedia).padStart(6),
        a.nombre,
      ].join(" "),
    ),
    "",
    "Para las series de una sesión de fuerza: garmin_activity con su id.",
  ].join("\n");
}

const INTENSIDAD: Record<string, string> = {
  WARMUP: "calentam.",
  ACTIVE: "trabajo",
  INTERVAL: "trabajo",
  RECOVERY: "recuper.",
  REST: "descanso",
  COOLDOWN: "v. calma",
};

export const MAX_VUELTAS = 200;

/** Ritmo o velocidad, según el deporte: min/km a pie, km/h en bici, /100 m nadando. */
function marcha(mps: number | null, deporte: string): string {
  if (mps === null) return "—";
  if (/swim/i.test(deporte)) {
    const s = Math.round(100 / mps);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  if (/cycl|bik|ride/i.test(deporte)) return (mps * 3.6).toFixed(1);
  const s = Math.round(1000 / mps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function unidadMarcha(deporte: string): string {
  if (/swim/i.test(deporte)) return "/100m";
  if (/cycl|bik|ride/i.test(deporte)) return "km/h";
  return "/km";
}

export function formatearVueltas(vueltas: Vuelta[], deporte: string): string[] {
  const conPaso = vueltas.some((v) => v.paso !== null);
  const conGap = vueltas.some((v) => v.gap !== null);
  const conPot = vueltas.some((v) => v.potencia !== null);
  const u = unidadMarcha(deporte);
  const cab = [
    "  #",
    conPaso ? "paso" : "",
    "tipo     ",
    "  tiempo",
    "dist km",
    `${u}`.padStart(6),
    conGap ? "   GAP" : "",
    "FCmed/máx",
    " cad",
    conPot ? "   W" : "",
    "  D+",
  ].filter(Boolean);
  const mostradas = vueltas.slice(0, MAX_VUELTAS);
  const lineas = [
    `${vueltas.length} vuelta${vueltas.length === 1 ? "" : "s"}` +
      (conPaso ? " (con un entreno cargado, cada paso es al menos una vuelta):" : ":"),
    cab.join(" "),
    ...mostradas.map((v) =>
      [
        String(v.numero).padStart(3),
        conPaso ? String(v.paso ?? "—").padStart(4) : "",
        (v.intensidad ? INTENSIDAD[v.intensidad] ?? v.intensidad.toLowerCase() : "—").padEnd(9).slice(0, 9),
        duracion(v.segundos).padStart(8),
        (v.distanciaM === null ? "—" : (v.distanciaM / 1000).toFixed(2)).padStart(7),
        marcha(v.velocidad, deporte).padStart(6),
        conGap ? marcha(v.gap, deporte).padStart(6) : "",
        `${num(v.fcMedia)}/${num(v.fcMax)}`.padStart(9),
        num(v.cadencia).padStart(4),
        conPot ? num(v.potencia).padStart(4) : "",
        (v.desnivelM === null ? "—" : `${Math.round(v.desnivelM)}`).padStart(4),
      ]
        .filter((c) => c !== "")
        .join(" "),
    ),
  ];
  if (vueltas.length > MAX_VUELTAS) {
    lineas.push(`… y ${vueltas.length - MAX_VUELTAS} vueltas más que no se enseñan.`);
  }
  if (conPaso) {
    lineas.push(
      "«paso» es el número de paso del entreno, como lo enumera garmin_get_workout: así se " +
        "compara cada serie con lo prescrito.",
    );
  }
  return lineas;
}

export function formatearActividad(
  actividad: Actividad | null,
  series: SerieFuerza[],
  avisoSeries: string | null,
  vueltas: Vuelta[] = [],
  avisoVueltas: string | null = null,
): string {
  if (!actividad) return "Garmin no devolvió esa actividad.";
  const lineas = [
    `«${actividad.nombre}» · ${actividad.deporte} · ${actividad.fecha} ${actividad.hora} · id ${actividad.id}`,
    [
      `duración ${duracion(actividad.segundos)}`,
      actividad.distanciaM !== null ? `${(actividad.distanciaM / 1000).toFixed(2)} km` : "",
      actividad.fcMedia !== null ? `FC ${num(actividad.fcMedia)}/${num(actividad.fcMax)}` : "",
      actividad.desnivelM !== null ? `${num(actividad.desnivelM)} m D+` : "",
      actividad.calorias !== null ? `${num(actividad.calorias)} kcal` : "",
      actividad.efectoAerobico !== null
        ? `efecto ${num(actividad.efectoAerobico, 1)}/${num(actividad.efectoAnaerobico, 1)}`
        : "",
    ]
      .filter(Boolean)
      .join(" · "),
  ];

  const trabajo = series.filter((s) => s.tipo !== "REST");
  if (trabajo.length) {
    lineas.push(
      "",
      `${trabajo.length} series de trabajo (los descansos van aparte):`,
      "  #  ejercicio                      reps    peso   tiempo  enum de Garmin",
      ...trabajo.map((s) =>
        [
          String(s.orden).padStart(3),
          s.ejercicio.padEnd(30).slice(0, 30),
          num(s.repeticiones).padStart(4),
          (s.pesoKg === null ? "—" : `${s.pesoKg} kg`).padStart(8),
          duracion(s.segundos).padStart(8),
          `${s.categoria ?? "—"}${s.enum ? ` / ${s.enum}` : ""}`,
        ].join(" "),
      ),
    );
    const volumen = trabajo.reduce(
      (total, s) => total + (s.repeticiones ?? 0) * (s.pesoKg ?? 0),
      0,
    );
    if (volumen > 0) {
      lineas.push(
        "",
        `Volumen total: ${Math.round(volumen)} kg levantados (suma de reps × peso).`,
      );
    }
    const sinIdentificar = trabajo.filter((s) => (s.enum ?? s.categoria ?? "UNKNOWN") === "UNKNOWN");
    if (sinIdentificar.length) {
      lineas.push(
        "",
        `${sinIdentificar.length} de las ${trabajo.length} series salen «(sin identificar)»: ` +
          "el reloj contó las repeticiones pero no reconoció el movimiento. Las repeticiones y " +
          "los tiempos son reales; el ejercicio no lo sabe nadie.",
      );
    }
    lineas.push(
      "",
      "El «enum de Garmin» es lo que hay que pasar como 'category' y 'exercise' en " +
        "garmin_create_workout para que el reloj enseñe el nombre del ejercicio.",
    );
  } else if (vueltas.length) {
    lineas.push("", ...formatearVueltas(vueltas, actividad.deporte));
  } else if (avisoSeries && /strength/i.test(actividad.deporte)) {
    lineas.push("", `No se pudieron leer las series: ${avisoSeries}`);
  } else if (avisoVueltas) {
    lineas.push("", `No se pudieron leer las vueltas: ${avisoVueltas}`);
  } else if (avisoSeries) {
    lineas.push("", `No se pudieron leer las series: ${avisoSeries}`);
  } else {
    lineas.push("", "Esta actividad no tiene series de fuerza ni vueltas registradas.");
  }
  return lineas.join("\n");
}
