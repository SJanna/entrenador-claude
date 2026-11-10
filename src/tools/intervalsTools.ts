/**
 * Implementación de las herramientas MCP que hablan con intervals.icu.
 * Cada método devuelve texto plano compacto (nunca JSON crudo) y, ante cualquier
 * fallo previsible, un mensaje que empieza por "Error:". Port fiel de tools.py.
 */

import type { AppConfig } from "../env";
import { addDays, weekdayMonday0 } from "../dates";
import * as fmt from "../intervals/format";
import { IntervalsClient, IntervalsError, type JsonRecord } from "../intervals/client";
import {
  WorkoutSpecError,
  avisoDeDuracion,
  avisoDePasos,
  contarEnviados,
  contarInterpretados,
  normalizeSport,
  renderWorkoutText,
} from "../intervals/workouts";
import * as rec from "../intervals/records";
import {
  UMBRAL_DESNIVEL_M,
  desnivelAcumulado,
  indexarSeries,
  longitudSeries,
  media,
  pasoAutomatico,
  primerValor,
  serieTiempo,
  tramos,
  ultimoValor,
  type Serie,
  type Series,
} from "../intervals/streams";
import {
  DiarioStore,
  descripcionEscala,
  formatearValor,
  normalizarClave,
  parsearDefiniciones,
  validarValor,
  type ValorDiario,
} from "../diario/store";
import { UMBRALES } from "../streaks/compute";
import { formatRachas } from "../streaks/format";
import { leerRachas } from "../streaks/servicio";

const MAX_ACTIVITY_ROWS = 200;
const MAX_SEARCH_ROWS = 200;
/** Tope de un barrido largo (récords y búsquedas): años de historial de una vez. */
const MAX_SWEEP_ACTIVITIES = 5000;
/** Antes de esta fecha no hay nada que barrer en la cuenta. */
const HISTORY_START = "2000-01-01";
const MAX_INTERVAL_ROWS = 60;
const MAX_STREAM_ROWS = 200;
const OBJETIVO_STREAM_ROWS = 120;
/** Lo que se pide a /streams: solo lo que se pinta, para no traer medio mega. */
const STREAM_TYPES = [
  "time", "distance", "altitude", "heartrate", "velocity_smooth", "cadence", "watts", "temp",
];
const MAX_EVENT_ROWS = 300;
const MAX_FULL_NOTES = 40;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Claves candidatas para métricas que Garmin sincroniza pero que la API no
// documenta con un nombre fijo. El override por entorno gana siempre.
const BODY_BATTERY_KEYS = [
  "bodyBattery", "body_battery", "bodyBatteryHigh", "bodyBatteryMax",
  "bodyBatteryChargedValue", "BodyBattery", "Body_Battery",
];
const READINESS_KEYS = ["readiness", "trainingReadiness", "readinessScore", "TrainingReadiness"];
const SLEEP_STAGE_KEYS: Record<string, string[]> = {
  deep: ["deepSleepSecs", "sleepDeepSecs", "deep_sleep_secs", "deepSleep"],
  light: ["lightSleepSecs", "sleepLightSecs", "light_sleep_secs", "lightSleep"],
  rem: ["remSleepSecs", "sleepRemSecs", "rem_sleep_secs", "remSleep"],
  awake: ["awakeSecs", "sleepAwakeSecs", "awake_secs", "wakeSecs"],
};

function clamp(value: unknown, low: number, high: number, name: string): number {
  const number = typeof value === "number" ? Math.trunc(value) : parseInt(String(value), 10);
  if (!Number.isFinite(number) || Number.isNaN(number)) {
    throw new Error(`'${name}' debe ser un número entero (recibido ${JSON.stringify(value)}).`);
  }
  return Math.max(low, Math.min(high, number));
}

function toFloat(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(num) ? num : null;
}

/** Quita las columnas sin ningún dato: no gastamos contexto en columnas de "—". */
function dropEmptyColumns(
  headers: string[],
  rows: string[][],
  align: string[],
  keep: number[] = [0],
): [string[], string[][], string[]] {
  const used = headers.map(
    (_, index) =>
      keep.includes(index) || rows.some((row) => (row[index] ?? fmt.DASH) !== fmt.DASH),
  );
  const newHeaders = headers.filter((_, i) => used[i]);
  const newAlign = align.filter((_, i) => used[i]);
  const newRows = rows.map((row) => row.filter((_, i) => used[i]));
  return [newHeaders, newRows, newAlign];
}


const ACTIVITY_UNITS =
  "Unidades: tiempo en movimiento h:mm:ss · distancia km · desnivel + m · " +
  "ritmo min/km (min/100m nadando, km/h en bici) · GAP ritmo ajustado por pendiente";

/** Tabla de actividades. La comparten get_activities y search_activities. */
function activityTable(activities: JsonRecord[]): string {
  const rows: string[][] = activities.map((item) => {
    const sport = String(item.type ?? fmt.DASH);
    const hrAvg = fmt.firstPresent(item, ["average_heartrate"]);
    const hrMax = fmt.firstPresent(item, ["max_heartrate", "icu_max_hr"]);
    return [
      String(item.id ?? fmt.DASH),
      fmt.dateShort(item.start_date_local),
      sport,
      fmt.duration(fmt.firstPresent(item, ["moving_time", "elapsed_time"])),
      fmt.km(fmt.firstPresent(item, ["distance", "icu_distance"])),
      fmt.elevation(fmt.firstPresent(item, ["total_elevation_gain"])),
      hrAvg || hrMax ? `${fmt.num(hrAvg)}/${fmt.num(hrMax)}` : fmt.DASH,
      fmt.pace(fmt.firstPresent(item, ["average_speed", "pace"]), sport),
      fmt.pace(fmt.firstPresent(item, ["gap"]), sport),
      fmt.num(fmt.firstPresent(item, ["icu_training_load"])),
      fmt.num(fmt.firstPresent(item, ["icu_rpe", "perceived_exertion"])),
      fmt.clip(item.name, 38),
    ];
  });

  let headers = [
    "id", "fecha", "deporte", "tiempo", "dist", "desnivel",
    "FCmed/máx", "ritmo", "GAP", "carga", "RPE", "nombre",
  ];
  let align = ["l", "l", "l", "r", "r", "r", "r", "r", "r", "r", "r", "l"];
  let outRows = rows;
  [headers, outRows, align] = dropEmptyColumns(headers, outRows, align, [0, 1, 2, 11]);
  return fmt.table(headers, outRows, align);
}

/** Totales por deporte, con el mismo texto en las dos herramientas. */
function activityTotals(activities: JsonRecord[]): string[] {
  const totals: Record<string, { n: number; time: number; dist: number; load: number }> = {};
  for (const item of activities) {
    const sport = String(item.type ?? fmt.DASH);
    const bucket = (totals[sport] ??= { n: 0, time: 0, dist: 0, load: 0 });
    bucket.n += 1;
    bucket.time += toFloat(fmt.firstPresent(item, ["moving_time", "elapsed_time"])) ?? 0;
    bucket.dist += toFloat(fmt.firstPresent(item, ["distance", "icu_distance"])) ?? 0;
    bucket.load += toFloat(fmt.firstPresent(item, ["icu_training_load"])) ?? 0;
  }
  const lines = ["Totales por deporte:"];
  for (const [sport, data] of Object.entries(totals).sort((a, b) => b[1].time - a[1].time)) {
    lines.push(
      `  ${sport}: ${data.n} sesiones · ${fmt.duration(data.time, { forceHours: true })} · ` +
        `${fmt.km(data.dist)} · carga ${fmt.num(data.load)}`,
    );
  }
  return lines;
}

/**
 * Criterios de orden de search_activities. Todos ordenan de mayor a menor, así
 * que todos dejan primero lo "más": más reciente, más largo, más rápido, más
 * carga. Una actividad sin el dato puntúa 0 y cae al final en vez de encabezar.
 */
const SORT_KEYS: Record<string, (item: JsonRecord) => number | string> = {
  fecha: (item) => String(item.start_date_local ?? ""),
  distancia: (item) => numField(item, ["distance", "icu_distance"]),
  ritmo: (item) => numField(item, ["average_speed", "pace"]),
  carga: (item) => numField(item, ["icu_training_load"]),
};

/** Primer campo numérico de la lista, o 0 si no hay ninguno legible. */
function numField(item: JsonRecord, keys: string[]): number {
  return toFloat(fmt.firstPresent(item, keys)) ?? 0;
}

export interface FiltrosBusqueda {
  sport: string | null;
  minKm: number | null;
  maxKm: number | null;
  minMinutes: number | null;
  maxMinutes: number | null;
  minElevation: number | null;
  needle: string;
  minAvgHr: number | null;
}

/** Filtros de search_activities. Un campo ausente nunca cuela un filtro. */
function cumpleFiltros(item: JsonRecord, f: FiltrosBusqueda): boolean {
  if (f.sport && String(item.type ?? "").toLowerCase() !== f.sport) return false;
  if (f.needle && !String(item.name ?? "").toLowerCase().includes(f.needle)) return false;

  const distance = numField(item, ["distance", "icu_distance"]);
  if (f.minKm !== null && distance < f.minKm * 1000) return false;
  if (f.maxKm !== null && distance > f.maxKm * 1000) return false;

  const seconds = numField(item, ["moving_time", "elapsed_time"]);
  if (f.minMinutes !== null && seconds < f.minMinutes * 60) return false;
  if (f.maxMinutes !== null && seconds > f.maxMinutes * 60) return false;

  if (f.minElevation !== null && numField(item, ["total_elevation_gain"]) < f.minElevation) {
    return false;
  }
  if (f.minAvgHr !== null && numField(item, ["average_heartrate"]) < f.minAvgHr) return false;
  return true;
}

/** Sección degradada cuando la curva no llega: se dice, no se rellena. */
function errorDeCurva(section: string, payload: unknown, endpoint: string): string[] | null {
  if (payload instanceof Error) {
    return [
      section,
      `No disponible: falló la consulta a ${endpoint} (${payload.message}). ` +
        "El resto de la respuesta sigue siendo válido; reinténtalo para esta parte.",
    ];
  }
  const record = payload as JsonRecord | null;
  if (!record || typeof record !== "object" || !Array.isArray(record.curves) || !record.curves.length) {
    return [
      section,
      `Sin datos: ${endpoint} no ha devuelto ninguna curva en este rango. ` +
        "Puede que no haya actividades del deporte pedido con ese dato registrado.",
    ];
  }
  return null;
}

/** Campos subjetivos de intervals.icu, en su escala de 1 a 4. */
const CAMPOS_ESCALA: Array<[string, string]> = [
  ["fatiga", "fatigue"],
  ["estres", "stress"],
  ["animo", "mood"],
  ["motivacion", "motivation"],
  ["dolor_muscular", "soreness"],
  ["lesion", "injury"],
  ["calidad_sueno", "sleepQuality"],
];

function nombreDeActividad(
  byId: Map<string, JsonRecord>,
  activityId: string,
  width = 34,
): string {
  const item = byId.get(activityId);
  return item ? fmt.clip(item.name, width) : fmt.DASH;
}

function recordsCurvaFc(payload: unknown, byId: Map<string, JsonRecord>): string[] {
  const section =
    "b) Mejor FC media sostenida (la de 20 y 60 min es una estimación directa del umbral)";
  const fallo = errorDeCurva(section, payload, "activity-hr-curves");
  if (fallo) return fallo;

  const [axis, best] = rec.mejorFcPorDuracion(payload as JsonRecord);
  const rows = axis.map((seconds, i) => {
    const item = best[i];
    if (!item) return [rec.etiquetaDuracion(seconds), fmt.DASH, fmt.DASH, fmt.DASH, "sin datos"];
    return [
      rec.etiquetaDuracion(seconds),
      fmt.num(item.value),
      item.date,
      item.activityId || fmt.DASH,
      nombreDeActividad(byId, item.activityId),
    ];
  });
  return [
    section,
    fmt.table(["duración", "FCmed", "fecha", "id", "actividad"], rows, ["l", "r", "l", "l", "l"]),
  ];
}

function recordsMarcas(
  payload: unknown,
  gapPayload: unknown,
  byId: Map<string, JsonRecord>,
  sport: string,
): string[] {
  const section = `c) Mejores marcas por distancia · ${sport}`;
  const fallo = errorDeCurva(section, payload, "activity-pace-curves");
  if (fallo) return fallo;

  const [axis, best] = rec.mejorTiempoPorDistancia(payload as JsonRecord);
  const gap = gapPayload as JsonRecord | null;
  const conGap = !!gap && !(gapPayload instanceof Error) && Array.isArray(gap.curves) && !!gap.curves.length;

  const rows = rec.RACE_DISTANCES.map((meters) => {
    const index = rec.indiceDe(axis, meters);
    const item = index !== null ? best[index] : null;
    if (!item) {
      return [rec.etiquetaDistancia(meters), ...Array(6).fill(fmt.DASH), "sin marca en el rango"];
    }
    const source = byId.get(item.activityId) ?? {};
    const gapSeconds = conGap ? rec.tiempoDe(gap, item.activityId, meters) : null;
    return [
      rec.etiquetaDistancia(meters),
      fmt.duration(item.value),
      fmt.paceFromTime(item.value, meters, sport),
      gapSeconds ? fmt.paceFromTime(gapSeconds, meters, sport) : fmt.DASH,
      fmt.elevation(fmt.firstPresent(source, ["total_elevation_gain"])),
      fmt.num(fmt.firstPresent(source, ["average_heartrate"])),
      item.date,
      `${item.activityId} ${nombreDeActividad(byId, item.activityId, 28)}`.trim(),
    ];
  });

  return [
    section,
    fmt.table(
      ["dist", "tiempo", "ritmo", "GAP", "desnivel", "FCmed", "fecha", "actividad"],
      rows,
      ["l", "r", "r", "r", "r", "r", "l", "l"],
    ),
    conGap
      ? "El GAP es el de la MISMA actividad que puso la marca, no el mejor GAP del " +
        "historial: así ritmo y GAP describen el mismo esfuerzo."
      : "GAP no disponible: la consulta con gap=true no ha devuelto curvas, así que la " +
        "columna va vacía. Sin GAP, marcas de terrenos distintos NO son comparables.",
  ];
}

function recordsCurvaRitmo(
  payload: unknown,
  byId: Map<string, JsonRecord>,
  sport: string,
): string[] {
  const section = `d) Curva de ritmo · ${sport}`;
  const fallo = errorDeCurva(section, payload, "activity-pace-curves");
  if (fallo) return fallo;

  const [axis, best] = rec.mejorTiempoPorDistancia(payload as JsonRecord);
  const rows: string[][] = [];
  axis.forEach((meters, i) => {
    if (Number.isNaN(meters)) return;
    const item = best[i];
    rows.push(
      item
        ? [
            rec.etiquetaDistancia(meters),
            fmt.duration(item.value),
            fmt.paceFromTime(item.value, meters, sport),
            item.date,
            `${item.activityId} ${nombreDeActividad(byId, item.activityId, 28)}`.trim(),
          ]
        : [rec.etiquetaDistancia(meters), fmt.DASH, fmt.DASH, fmt.DASH, "sin datos"],
    );
  });
  return [
    section,
    "intervals.icu indexa la curva de ritmo por DISTANCIA, no por duración: cada fila es el " +
      "mejor tiempo del historial para esa distancia, y el ritmo sale de ahí.",
    fmt.table(
      ["dist", "mejor tiempo", "ritmo", "fecha", "actividad"],
      rows,
      ["l", "r", "r", "l", "l"],
    ),
    `Distancias consultadas: ${rec.CURVE_DISTANCES.map(rec.etiquetaDistancia).join(", ")}.`,
  ];
}

export class IntervalsTools {
  readonly client: IntervalsClient;

  constructor(
    readonly config: AppConfig,
    client?: IntervalsClient,
  ) {
    this.client = client ?? new IntervalsClient(config);
  }

  // ------------------------------------------------------------------ fechas

  private today(): string {
    return this.config.today();
  }

  parseDate(value: unknown, field = "date"): string {
    const text = String(value ?? "").trim().toLowerCase();
    if (["hoy", "today"].includes(text)) return this.today();
    if (["mañana", "manana", "tomorrow"].includes(text)) return addDays(this.today(), 1);
    if (["ayer", "yesterday"].includes(text)) return addDays(this.today(), -1);
    if (!DATE_RE.test(text)) {
      throw new Error(
        `'${field}' debe tener formato YYYY-MM-DD (recibido ${JSON.stringify(value)}). ` +
          'También se aceptan "hoy" y "mañana".',
      );
    }
    const [y, m, d] = text.split("-").map(Number);
    const parsed = new Date(Date.UTC(y!, m! - 1, d!));
    if (
      parsed.getUTCFullYear() !== y ||
      parsed.getUTCMonth() !== m! - 1 ||
      parsed.getUTCDate() !== d
    ) {
      throw new Error(
        `'${field}' tiene el formato correcto pero no es un día real: ${JSON.stringify(value)}. ` +
          "Usa una fecha válida en formato YYYY-MM-DD.",
      );
    }
    return text;
  }

  private field(record: JsonRecord, key: string, candidates: string[]): unknown {
    const override = this.config.fieldOverrides[key];
    if (override) {
      const value = fmt.firstPresent(record, [override]);
      if (value !== null) return value;
    }
    return fmt.firstPresent(record, candidates);
  }

  private async guard(fn: () => Promise<string>, name: string): Promise<string> {
    try {
      return await fn();
    } catch (exc) {
      if (
        exc instanceof IntervalsError ||
        exc instanceof WorkoutSpecError ||
        exc instanceof Error
      ) {
        if (exc instanceof IntervalsError || exc instanceof WorkoutSpecError) {
          return `Error: ${exc.message}`;
        }
        // Errores de validación propios también son "Error: …"; el resto se reporta con contexto.
        if (exc.name === "Error") return `Error: ${exc.message}`;
        console.error(`Fallo inesperado en ${name}`, exc);
        return `Error inesperado en ${name}: ${exc.name}: ${exc.message}. Revisa los logs del Worker.`;
      }
      return `Error inesperado en ${name}: ${String(exc)}`;
    }
  }

  // --------------------------------------------------------------- bienestar

  getWellness(db: D1Database, days: unknown = 14): Promise<string> {
    return this.guard(async () => {
      const clamped = clamp(days ?? 14, 1, 120, "days");
      const newest = this.today();
      const oldest = addDays(newest, -(clamped - 1));
      const diario = new DiarioStore(db);
      const [records, campos, diarioPorDia] = await Promise.all([
        this.client.wellness(oldest, newest),
        diario.campos(),
        diario.leer(oldest, newest),
      ]);

      if (!records.length) {
        return `Sin datos de bienestar entre ${oldest} y ${newest} para el atleta ${this.config.athleteId}.`;
      }

      const rows: string[][] = [];
      const emptyDays: string[] = [];
      const sleepValues: number[] = [];
      const hrvValues: number[] = [];
      const rhrValues: number[] = [];
      let lastForm: [unknown, unknown, unknown] | null = null;

      const sorted = [...records].sort((a, b) =>
        String(b.id ?? "").localeCompare(String(a.id ?? "")),
      );

      for (const record of sorted) {
        const day = fmt.dateShort(fmt.firstPresent(record, ["id", "date"]));
        const sleepSecs = fmt.firstPresent(record, ["sleepSecs"]);
        const hrv = fmt.firstPresent(record, ["hrv", "hrvSDNN"]);
        const rhr = fmt.firstPresent(record, ["restingHR"]);
        const weight = fmt.firstPresent(record, ["weight"]);
        const sleepScore = fmt.firstPresent(record, ["sleepScore"]);
        const steps = fmt.firstPresent(record, ["steps"]);
        const bodyBattery = this.field(record, "body_battery", BODY_BATTERY_KEYS);
        const readiness = this.field(record, "readiness", READINESS_KEYS);

        const stages: Record<string, unknown> = {};
        for (const [name, keys] of Object.entries(SLEEP_STAGE_KEYS)) {
          stages[name] = this.field(record, `sleep_${name}`, keys);
        }
        let phases = fmt.DASH;
        if (Object.values(stages).some((v) => v !== null && v !== undefined)) {
          phases = ["deep", "light", "rem"].map((name) => fmt.hoursMinutes(stages[name])).join("/");
        }

        const ctl = fmt.firstPresent(record, ["ctl"]);
        const atl = fmt.firstPresent(record, ["atl"]);
        let tsb = fmt.firstPresent(record, ["tsb"]);
        const ctlNum = toFloat(ctl);
        const atlNum = toFloat(atl);
        if (tsb === null && ctlNum !== null && atlNum !== null) {
          tsb = ctlNum - atlNum;
        }
        if (ctl !== null && lastForm === null) {
          lastForm = [ctl, atl, tsb];
        }

        // Un día sin nada de Garmin pero con dolor apuntado NO es un día vacío:
        // es justo el día que hay que poder mirar.
        const delDiario = diarioPorDia.get(day);
        const daily = [sleepSecs, hrv, rhr, weight, sleepScore, bodyBattery, readiness, steps];
        if (daily.every((v) => v === null || v === undefined) && ctl === null && !delDiario) {
          emptyDays.push(day);
          continue;
        }

        for (const [value, bucket] of [
          [sleepSecs, sleepValues],
          [hrv, hrvValues],
          [rhr, rhrValues],
        ] as Array<[unknown, number[]]>) {
          const num = toFloat(value);
          if (num !== null) bucket.push(num);
        }

        rows.push([
          day,
          fmt.hoursMinutes(sleepSecs),
          phases,
          fmt.num(sleepScore),
          fmt.num(hrv),
          fmt.num(rhr),
          fmt.num(bodyBattery),
          fmt.num(readiness),
          fmt.num(weight, 1),
          fmt.num(steps),
          fmt.num(ctl),
          fmt.num(atl),
          fmt.num(tsb),
          ...campos.map((campo) => formatearValor(campo, delDiario?.get(campo.campo))),
        ]);
      }

      if (!rows.length) {
        return `Sin datos de bienestar entre ${oldest} y ${newest} (los ${clamped} días vacíos).`;
      }

      let headers = [
        "fecha", "sueño", "prof/lig/REM", "punt", "HRV", "FCrep",
        "BB", "Prep", "peso", "pasos", "CTL", "ATL", "TSB",
        ...campos.map((campo) => campo.etiqueta),
      ];
      let align = [
        "l", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r",
        ...campos.map((campo) => (campo.tipo === "texto" ? "l" : "r")),
      ];
      let outRows = rows;
      [headers, outRows, align] = dropEmptyColumns(headers, outRows, align);

      const out = [
        `Bienestar · atleta ${this.config.athleteId} · ${oldest} → ${newest} ` +
          `(${clamped} días, más reciente primero)`,
        "Unidades: sueño h:mm · HRV ms · FC ppm · peso kg · BB Body Battery · " +
          "Prep Training Readiness · TSB = CTL − ATL",
        "",
        fmt.table(headers, outRows, align),
      ];

      // Las columnas del diario son del atleta, no de intervals.icu: sin decir
      // qué mide cada una y en qué escala, un 3 no significa nada.
      if (campos.length) {
        const enTabla = campos.filter((campo) => headers.includes(campo.etiqueta));
        const sinApuntar = campos.filter((campo) => !headers.includes(campo.etiqueta));
        out.push("", "Diario de la app (no viene de intervals.icu ni de Garmin):");
        if (enTabla.length) {
          out.push(
            "  " +
              enTabla
                .map(
                  (campo) =>
                    `${campo.etiqueta} ${descripcionEscala(campo)}` +
                    (campo.descripcion ? ` — ${campo.descripcion}` : ""),
                )
                .join(" · "),
          );
        }
        if (sinApuntar.length) {
          out.push(
            `  Declarados pero SIN ningún registro en este rango: ` +
              `${sinApuntar.map((c) => c.etiqueta).join(", ")}. Un hueco aquí es que no se ` +
              "apuntó, no que no pasara nada.",
          );
        }
      }

      const resumen: string[] = [];
      if (sleepValues.length) {
        resumen.push(`sueño ${fmt.hoursMinutes(sleepValues.reduce((a, b) => a + b, 0) / sleepValues.length)}`);
      }
      if (hrvValues.length) {
        resumen.push(`HRV ${fmt.num(hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length)}`);
      }
      if (rhrValues.length) {
        resumen.push(`FCrep ${fmt.num(rhrValues.reduce((a, b) => a + b, 0) / rhrValues.length)}`);
      }
      if (resumen.length) {
        out.push("", "Medias del periodo: " + resumen.join(" · "));
      }
      if (lastForm) {
        const [ctl, atl, tsb] = lastForm;
        out.push(`Forma actual: CTL ${fmt.num(ctl)} · ATL ${fmt.num(atl)} · TSB ${fmt.num(tsb)}`);
      }
      if (emptyDays.length) {
        out.push(`Días sin registro (${emptyDays.length}): ${emptyDays.join(", ")}`);
      }
      return out.join("\n");
    }, "get_wellness");
  }

  // ------------------------------------------------------- escribir bienestar

  setWellness(
    db: D1Database,
    args: {
      date?: unknown;
      fatiga?: unknown;
      estres?: unknown;
      animo?: unknown;
      motivacion?: unknown;
      dolor_muscular?: unknown;
      lesion?: unknown;
      calidad_sueno?: unknown;
      comentarios?: unknown;
      campos?: unknown;
      definir?: unknown;
    },
  ): Promise<string> {
    return this.guard(async () => {
      const day = args.date != null ? this.parseDate(args.date, "date") : this.today();
      const payload: JsonRecord = {};
      const fueraDeEscala: string[] = [];

      for (const [nombre, clave] of CAMPOS_ESCALA) {
        const valor = (args as Record<string, unknown>)[nombre];
        if (valor === null || valor === undefined) continue;
        const num = toFloat(valor);
        if (num === null || !Number.isInteger(num)) {
          throw new Error(`'${nombre}' debe ser un número entero (recibido ${JSON.stringify(valor)}).`);
        }
        if (num < 1 || num > 4) fueraDeEscala.push(`${nombre}=${num}`);
        payload[clave] = num;
      }

      if (args.comentarios !== null && args.comentarios !== undefined) {
        payload.comments = String(args.comentarios);
      }

      // ------------------------------- diario propio (D1, no intervals.icu)
      const diario = new DiarioStore(db);
      const ahora = new Date().toISOString();
      const definidos: string[] = [];
      if (args.definir !== null && args.definir !== undefined) {
        for (const campo of parsearDefiniciones(args.definir)) {
          await diario.definir(campo, ahora);
          definidos.push(`${campo.campo} (${descripcionEscala(campo)})`);
        }
      }

      const declarados = new Map((await diario.campos()).map((c) => [c.campo, c]));
      const valores: ValorDiario[] = [];
      if (args.campos !== null && args.campos !== undefined) {
        if (typeof args.campos !== "object" || Array.isArray(args.campos)) {
          throw new Error(
            "'campos' debe ser un objeto {clave: valor} del diario de la app, " +
              'p. ej. {"dolor_lesion": 3}.',
          );
        }
        for (const [bruta, valor] of Object.entries(args.campos as JsonRecord)) {
          const clave = normalizarClave(bruta);
          const campo = declarados.get(clave);
          if (!campo) {
            throw new Error(
              `'${bruta}' no está declarado en el diario, así que NO se ha escrito nada ` +
                "(ni de este campo ni de los demás de la llamada). " +
                (declarados.size
                  ? `Campos declarados: ${[...declarados.keys()].join(", ")}. `
                  : "Todavía no hay ningún campo declarado. ") +
                "Créalo en la misma llamada con 'definir', p. ej. " +
                '{"campo": "dolor_lesion", "tipo": "numero", "minimo": 0, "maximo": 10, ' +
                '"descripcion": "0 nada, 10 insoportable"}.',
            );
          }
          valores.push(validarValor(campo, valor));
        }
      }

      if (!Object.keys(payload).length && !valores.length && !definidos.length) {
        throw new Error(
          "Nada que escribir. Pasa al menos un campo: fatiga, estres, animo, motivacion, " +
            "dolor_muscular, lesion, calidad_sueno, comentarios, 'campos' o 'definir'.",
        );
      }

      const out: string[] = [];

      // ------------------------------------------------- lo que va a intervals
      if (Object.keys(payload).length) {
        const antes = (await this.client.wellness(day, day))[0] ?? {};
        const despues = await this.client.updateWellness(day, payload);
        const final = Object.keys(despues).length
          ? despues
          : ((await this.client.wellness(day, day))[0] ?? {});

        // intervals.icu descarta EN SILENCIO lo que no reconoce: la única forma
        // de saber qué ha entrado es releer y comparar, así que se relee siempre.
        const filas: string[][] = [];
        const ignorados: string[] = [];
        for (const [clave, enviado] of Object.entries(payload)) {
          const guardado = final[clave];
          filas.push([
            clave,
            antes[clave] === null || antes[clave] === undefined ? fmt.DASH : String(antes[clave]),
            guardado === null || guardado === undefined ? fmt.DASH : String(guardado),
          ]);
          if (String(guardado ?? "") !== String(enviado ?? "")) ignorados.push(clave);
        }
        out.push(
          `En intervals.icu · bienestar del ${day} (atleta ${this.config.athleteId}):`,
          "",
          fmt.table(["campo", "antes", "ahora"], filas, ["l", "r", "r"]),
        );
        if (fueraDeEscala.length) {
          out.push(
            `Aviso: ${fueraDeEscala.join(", ")}. Los campos subjetivos de intervals.icu usan ` +
              "una escala de 1 a 4; se ha enviado el valor tal cual, pero mira la columna " +
              "'ahora' para ver qué ha guardado de verdad.",
          );
        }
        if (ignorados.length) {
          out.push(
            `AVISO: intervals.icu NO ha guardado ${ignorados.join(", ")} con el valor enviado. ` +
              "No des por registrado lo que no aparece en la columna 'ahora'.",
          );
        }
      }

      // ------------------------------------------------------ lo que va al diario
      if (definidos.length) {
        out.push(
          out.length ? "" : "",
          `Campos del diario declarados: ${definidos.join(" · ")}.`,
        );
      }
      if (valores.length) {
        const antes = (await diario.leer(day, day)).get(day) ?? new Map();
        await diario.escribir(day, valores, ahora);
        const despues = (await diario.leer(day, day)).get(day) ?? new Map();
        out.push(
          out.length ? "" : "",
          `En el diario de la app · ${day}:`,
          "",
          fmt.table(
            ["campo", "antes", "ahora"],
            valores.map((v) => {
              const campo = declarados.get(v.campo);
              return [
                campo?.etiqueta || v.campo,
                formatearValor(campo, antes.get(v.campo)),
                formatearValor(campo, despues.get(v.campo)),
              ];
            }),
            ["l", "r", "r"],
          ),
          "Guardado en la base de datos de la app, no en intervals.icu: sale en get_wellness " +
            "junto al sueño, la HRV y la carga, que es donde se puede leer contra el " +
            "entrenamiento.",
        );
      }
      return out.join("\n");
    }, "set_wellness");
  }

  // ------------------------------------------------------------ actividades

  getActivities(days: unknown = 30): Promise<string> {
    return this.guard(async () => {
      const clamped = clamp(days ?? 30, 1, 365, "days");
      const newest = this.today();
      const oldest = addDays(newest, -(clamped - 1));
      // Pedimos una de más para saber si el rango se ha quedado corto.
      let activities = await this.client.activities(oldest, newest, MAX_ACTIVITY_ROWS + 1);

      if (!activities.length) {
        return `Sin actividades entre ${oldest} y ${newest}.`;
      }

      activities.sort((a, b) =>
        String(b.start_date_local ?? "").localeCompare(String(a.start_date_local ?? "")),
      );
      const truncated = activities.length > MAX_ACTIVITY_ROWS;
      activities = activities.slice(0, MAX_ACTIVITY_ROWS);

      const out = [
        `Actividades · ${oldest} → ${newest} (${activities.length} en ${clamped} días, más reciente primero)`,
        ACTIVITY_UNITS,
        "",
        activityTable(activities),
        "",
        ...activityTotals(activities),
      ];
      if (truncated) {
        out.push(`(Recortado a ${MAX_ACTIVITY_ROWS} actividades; reduce 'days' para ver el resto.)`);
      }
      out.push("Usa get_activity(id) para el detalle con zonas e intervalos.");
      return out.join("\n");
    }, "get_activities");
  }

  // ------------------------------------------------------ buscar actividades

  searchActivities(args: {
    sport?: unknown;
    oldest?: unknown;
    newest?: unknown;
    days?: unknown;
    min_km?: unknown;
    max_km?: unknown;
    min_minutes?: unknown;
    max_minutes?: unknown;
    min_elevation?: unknown;
    name_contains?: unknown;
    min_avg_hr?: unknown;
    sort?: unknown;
    limit?: unknown;
  }): Promise<string> {
    return this.guard(async () => {
      const today = this.today();
      const span = clamp(args.days ?? 365, 1, 3650, "days");
      let first: string;
      let last: string;
      if (args.oldest != null || args.newest != null) {
        last = args.newest != null ? this.parseDate(args.newest, "newest") : today;
        // Con solo 'newest', se miran los 'days' anteriores a esa fecha: es
        // menos sorprendente que barrer el historial entero hasta ahí.
        first =
          args.oldest != null
            ? this.parseDate(args.oldest, "oldest")
            : addDays(last, -(span - 1));
        if (last < first) {
          throw new Error(`'newest' (${last}) es anterior a 'oldest' (${first}): invierte el rango.`);
        }
      } else {
        first = addDays(today, -(span - 1));
        last = today;
      }

      const order = String(args.sort ?? "fecha").trim().toLowerCase();
      const clave = SORT_KEYS[order];
      if (!clave) {
        throw new Error(
          `'sort' no reconocido (${JSON.stringify(args.sort)}). Valores admitidos: ` +
            `${Object.keys(SORT_KEYS).sort().join(", ")}.`,
        );
      }
      const filasPedidas = clamp(args.limit ?? 50, 1, MAX_SEARCH_ROWS, "limit");

      const deporte = args.sport != null ? normalizeSport(String(args.sport)) : null;
      const filtros: FiltrosBusqueda = {
        sport: deporte ? deporte.toLowerCase() : null,
        minKm: toFloat(args.min_km),
        maxKm: toFloat(args.max_km),
        minMinutes: toFloat(args.min_minutes),
        maxMinutes: toFloat(args.max_minutes),
        minElevation: toFloat(args.min_elevation),
        needle: String(args.name_contains ?? "").split(/\s+/).join(" ").trim().toLowerCase(),
        minAvgHr: toFloat(args.min_avg_hr),
      };

      const found = await this.client.activities(first, last, MAX_SWEEP_ACTIVITIES);

      const descripcion: string[] = [];
      if (deporte) descripcion.push(`deporte ${deporte}`);
      for (const [label, value, unit] of [
        ["distancia ≥", filtros.minKm, " km"],
        ["distancia ≤", filtros.maxKm, " km"],
        ["duración ≥", filtros.minMinutes, " min"],
        ["duración ≤", filtros.maxMinutes, " min"],
        ["desnivel ≥", filtros.minElevation, " m"],
        ["FC media ≥", filtros.minAvgHr, " ppm"],
      ] as Array<[string, number | null, string]>) {
        if (value !== null) descripcion.push(`${label} ${value}${unit}`);
      }
      if (filtros.needle) descripcion.push(`nombre contiene "${args.name_contains}"`);

      const matches = found.filter((item) => cumpleFiltros(item, filtros));
      matches.sort((a, b) => {
        const va = clave(a);
        const vb = clave(b);
        if (typeof va === "string" || typeof vb === "string") {
          return String(vb).localeCompare(String(va));
        }
        return vb - va;
      });
      const shown = matches.slice(0, filasPedidas);

      const head =
        `Búsqueda de actividades · ${first} → ${last} · ${matches.length} coinciden ` +
        `de ${found.length} en el rango · orden por ${order}`;
      const lineaFiltros = `Filtros: ${descripcion.length ? descripcion.join(" · ") : "(ninguno)"}`;
      if (!shown.length) {
        return [
          head,
          lineaFiltros,
          "",
          "Ninguna actividad cumple todos los filtros. Prueba a ampliar el rango de fechas " +
            "o a soltar el filtro más restrictivo.",
        ].join("\n");
      }

      const out = [
        head,
        lineaFiltros,
        ACTIVITY_UNITS,
        "",
        activityTable(shown),
        "",
        ...activityTotals(shown),
      ];
      if (matches.length > shown.length) {
        out.push(
          `AVISO: hay ${matches.length} coincidencias y solo se muestran ${shown.length}. ` +
            `Sube 'limit' (máximo ${MAX_SEARCH_ROWS}) o afina los filtros para verlas todas.`,
        );
      }
      if (found.length >= MAX_SWEEP_ACTIVITIES) {
        out.push(
          `AVISO: el rango ha devuelto el tope de ${MAX_SWEEP_ACTIVITIES} actividades; ` +
            "puede haber más sin mirar. Acorta el rango de fechas.",
        );
      }
      out.push("Usa get_activity(id) para el detalle con zonas e intervalos.");
      return out.join("\n");
    }, "search_activities");
  }

  // ---------------------------------------------------------------- récords

  getRecords(days: unknown = null, sport: unknown = "Run"): Promise<string> {
    return this.guard(async () => {
      const today = this.today();
      let first: string;
      let window: string;
      if (days === null || days === undefined) {
        first = HISTORY_START;
        window = "histórico completo";
      } else {
        const span = clamp(days, 1, 36500, "days");
        first = addDays(today, -(span - 1));
        window = `últimos ${span} días`;
      }
      const sportName = normalizeSport(String(sport ?? "Run")) || "Run";

      const fallo = (exc: unknown): Error =>
        exc instanceof Error ? exc : new Error(String(exc));
      const [activities, hrCurves, paceCurves, gapCurves] = await Promise.all([
        this.client.activities(first, today, MAX_SWEEP_ACTIVITIES, rec.ACTIVITY_FIELDS),
        this.client.activityHrCurves(first, today, rec.HR_DURATIONS, sportName).catch(fallo),
        this.client
          .activityPaceCurves(first, today, rec.CURVE_DISTANCES, { sport: sportName })
          .catch(fallo),
        this.client
          .activityPaceCurves(first, today, rec.CURVE_DISTANCES, { gap: true, sport: sportName })
          .catch(fallo),
      ]);

      const byId = new Map<string, JsonRecord>(
        activities.map((item) => [String(item.id ?? ""), item]),
      );

      const out = [
        `Récords y máximos · atleta ${this.config.athleteId} · ${window} ` +
          `(${first} → ${today}) · ${activities.length} actividades barridas`,
        "Unidades: FC ppm · tiempo h:mm:ss · ritmo min/km · desnivel + m. " +
          "Todo valor va con la fecha y el id de la actividad que lo produjo.",
      ];
      if (activities.length >= MAX_SWEEP_ACTIVITIES) {
        out.push(
          `AVISO: se ha alcanzado el tope de ${MAX_SWEEP_ACTIVITIES} actividades; ` +
            "puede quedar historial sin barrer. Acota con 'days'.",
        );
      }

      out.push("", ...this.recordsFcMaxima(activities, today, first));
      out.push("", ...recordsCurvaFc(hrCurves, byId));
      out.push("", ...recordsMarcas(paceCurves, gapCurves, byId, sportName));
      out.push("", ...recordsCurvaRitmo(paceCurves, byId, sportName));
      return out.join("\n");
    }, "get_records");
  }

  private recordsFcMaxima(activities: JsonRecord[], today: string, first: string): string[] {
    const ranked = rec.maximosDeFc(activities);
    if (!ranked.length) {
      return [
        "a) FC máxima registrada",
        "Ninguna actividad del rango trae FC máxima. Sin ese dato no hay máximo que dar " +
          "y no se estima ninguno.",
      ];
    }

    const top = ranked[0]!;
    const out = [
      "a) FC máxima registrada en actividades",
      `Máximo absoluto del rango: ${fmt.num(top._max_hr)} ppm · ` +
        `${fmt.dateShort(top.start_date_local)} · ${top.id} · ${fmt.clip(top.name, 46)}`,
      "",
      "Los 10 valores más altos (un máximo aislado puede ser un artefacto del sensor; " +
        "diez dan una lectura fiable):",
    ];
    out.push(
      fmt.table(
        ["fecha", "FCmáx", "FCmed", "id", "deporte", "nombre"],
        ranked.slice(0, 10).map((item) => [
          fmt.dateShort(item.start_date_local),
          fmt.num(item._max_hr),
          fmt.num(fmt.firstPresent(item, ["average_heartrate"])),
          String(item.id ?? fmt.DASH),
          String(item.type ?? fmt.DASH),
          fmt.clip(item.name, 38),
        ]),
        ["l", "r", "r", "l", "l", "l"],
      ),
    );

    out.push("", "Máximo por ventana (cada una acaba hoy):");
    const filas: string[][] = [];
    const parciales: number[] = [];
    for (const span of rec.WINDOWS) {
      const limite = addDays(today, -(span - 1));
      // Si la ventana se remonta más atrás que el rango pedido, lo que sale NO
      // es el máximo de esos días: solo el del trozo que se ha leído.
      if (limite < first) parciales.push(span);
      const dentro = ranked.filter((item) => fmt.dateShort(item.start_date_local) >= limite);
      const mejor = dentro[0];
      filas.push(
        mejor
          ? [
              `${span} días`,
              fmt.num(mejor._max_hr),
              fmt.dateShort(mejor.start_date_local),
              String(mejor.id ?? fmt.DASH),
              fmt.clip(mejor.name, 34),
            ]
          : [`${span} días`, fmt.DASH, fmt.DASH, fmt.DASH, "sin datos"],
      );
    }
    out.push(
      fmt.table(["ventana", "FCmáx", "fecha", "id", "nombre"], filas, ["l", "r", "l", "l", "l"]),
    );
    if (parciales.length) {
      out.push(
        "AVISO: las ventanas de " +
          parciales.map((span) => `${span} días`).join(", ") +
          ` son más largas que el rango consultado (desde ${first}), así que esas filas NO ` +
          "son el máximo de esa ventana. Llama a get_records() sin 'days' para barrer el " +
          "histórico completo.",
      );
    }
    return out;
  }

  // ------------------------------------------------------ detalle actividad

  private activityIdOf(activityId: unknown): string {
    const raw = String(activityId ?? "").trim();
    if (!raw) {
      throw new Error(
        "Falta 'activity_id' (el que aparece en get_activities, p. ej. i123456789).",
      );
    }
    return /^\d+$/.test(raw) ? `i${raw}` : raw;
  }

  getActivity(activityId: unknown): Promise<string> {
    return this.guard(async () => {
      const raw = this.activityIdOf(activityId);

      const detailPromise = this.client.activity(raw);
      const intervalsPromise = this.client.activityIntervals(raw).catch((exc) => {
        if (exc instanceof IntervalsError) return [] as JsonRecord[];
        throw exc;
      });
      // La API no publica descenso por vuelta (solo total_elevation_gain), así
      // que se deriva de la serie de altitud. Va en paralelo con lo demás: si
      // falla o la actividad no tiene altitud, el detalle sale igual sin ella.
      const altitudPromise = this.client
        .activityStreams(raw, ["altitude"])
        .then((crudas) => indexarSeries(crudas).get("altitude"))
        .catch(() => undefined);
      const detail = await detailPromise;
      const intervals = await intervalsPromise;

      if (!Object.keys(detail).length) {
        return `Error: la actividad ${raw} no devolvió datos.`;
      }

      const sport = String(detail.type ?? fmt.DASH);
      const moving = fmt.firstPresent(detail, ["moving_time"]);
      const elapsed = fmt.firstPresent(detail, ["elapsed_time"]);
      const distance = fmt.firstPresent(detail, ["distance", "icu_distance"]);
      const speed = fmt.firstPresent(detail, ["average_speed", "pace"]);

      const out = [
        `${detail.id ?? raw} · ${detail.name ?? "Sin nombre"} · ${sport} · ` +
          String(detail.start_date_local ?? "").slice(0, 16).replace("T", " "),
        `Tiempo ${fmt.duration(moving)} en movimiento / ${fmt.duration(elapsed)} total · ` +
          `${fmt.km(distance, 2)} · desnivel ` +
          fmt.elevation(fmt.firstPresent(detail, ["total_elevation_gain"])),
      ];

      out.push(
        `FC ${fmt.num(fmt.firstPresent(detail, ["average_heartrate"]))} media / ` +
          `${fmt.num(fmt.firstPresent(detail, ["max_heartrate"]))} máx` +
          ` (LTHR ${fmt.num(fmt.firstPresent(detail, ["lthr"]))})` +
          ` · ritmo ${fmt.pace(speed, sport)}` +
          ` · GAP ${fmt.pace(fmt.firstPresent(detail, ["gap"]), sport)}` +
          ` · cadencia ${fmt.num(fmt.firstPresent(detail, ["average_cadence"]))}`,
      );

      const watts = fmt.firstPresent(detail, ["icu_average_watts", "average_watts"]);
      const npWatts = fmt.firstPresent(detail, ["icu_weighted_avg_watts"]);
      out.push(
        `Potencia ${fmt.num(watts, 0, " W")} media / ${fmt.num(npWatts, 0, " W")} ` +
          `normalizada (FTP ${fmt.num(fmt.firstPresent(detail, ["icu_ftp"]))})` +
          ` · carga ${fmt.num(fmt.firstPresent(detail, ["icu_training_load"]))}` +
          ` · intensidad ${fmt.num(fmt.firstPresent(detail, ["icu_intensity"]), 2)}` +
          ` · RPE ${fmt.num(fmt.firstPresent(detail, ["icu_rpe", "perceived_exertion"]))}` +
          ` · kcal ${fmt.num(fmt.firstPresent(detail, ["calories"]))}`,
      );

      // §6 evalúa las tiradas largas por desacople (<5%): el dato lo calcula
      // intervals.icu, aquí solo se expone sin interpretarlo.
      const decoupling = fmt.firstPresent(detail, ["decoupling"]);
      const efficiency = fmt.firstPresent(detail, ["icu_efficiency_factor"]);
      if (decoupling !== null || efficiency !== null) {
        out.push(
          `Desacople aeróbico ${fmt.num(decoupling, 1, " %")} · ` +
            `factor de eficiencia ${fmt.num(efficiency, 2)}`,
        );
      }

      // §5 prohíbe interpretar pulsaciones altas sin mirar antes la temperatura.
      const clima: string[] = [];
      const weatherTemp = fmt.firstPresent(detail, ["average_weather_temp"]);
      const feelsLike = fmt.firstPresent(detail, ["average_feels_like"]);
      const minTemp = fmt.firstPresent(detail, ["min_weather_temp"]);
      const maxTemp = fmt.firstPresent(detail, ["max_weather_temp"]);
      const deviceTemp = fmt.firstPresent(detail, ["average_temp"]);
      if (weatherTemp !== null) clima.push(`${fmt.num(weatherTemp, 1, " °C")} de media`);
      if (feelsLike !== null) clima.push(`sensación ${fmt.num(feelsLike, 1, " °C")}`);
      if (minTemp !== null || maxTemp !== null) {
        clima.push(`rango ${fmt.num(minTemp, 1)}–${fmt.num(maxTemp, 1)} °C`);
      }
      if (deviceTemp !== null) {
        clima.push(`sensor del reloj ${fmt.num(deviceTemp, 1, " °C")}`);
      }
      if (clima.length) out.push("Clima: " + clima.join(" · "));

      for (const [label, key] of [
        ["Zonas de potencia", "icu_zone_times"],
        ["Zonas de FC", "icu_hr_zone_times"],
        ["Zonas de ritmo", "pace_zone_times"],
        ["Zonas de GAP", "gap_zone_times"],
      ] as Array<[string, string]>) {
        const line = fmt.zonesLine(label, detail[key]);
        if (line) out.push(line);
      }

      const description = fmt.clip(detail.description, 400);
      if (description) out.push(`Notas: ${description}`);

      if (intervals.length) {
        const altitud = await altitudPromise;
        const shown = intervals.slice(0, MAX_INTERVAL_ROWS);
        let bajadasDerivadas = false;
        const rows: string[][] = shown.map((item, i) => {
          const label = item.label ?? item.type ?? `#${i + 1}`;
          const inicio = toFloat(fmt.firstPresent(item, ["start_index"]));
          const fin = toFloat(fmt.firstPresent(item, ["end_index"]));
          // OJO: 'average_gradient' viene como FRACCIÓN (0.054 = 5.4 %), no como
          // porcentaje. Sin el ×100 una rampa del 5,4 % se imprimía como "0.1".
          const gradiente = toFloat(fmt.firstPresent(item, ["average_gradient"]));
          let bajada = fmt.DASH;
          if (altitud && inicio !== null && fin !== null) {
            const { bajada: metros } = desnivelAcumulado(altitud, Math.round(inicio), Math.round(fin));
            if (metros > 0) {
              bajada = `−${Math.round(metros)}m`;
              bajadasDerivadas = true;
            }
          }
          return [
            String(i + 1),
            fmt.clip(label, 14),
            fmt.duration(fmt.firstPresent(item, ["moving_time", "elapsed_time", "duration"])),
            fmt.km(fmt.firstPresent(item, ["distance"]), 2),
            fmt.elevation(fmt.firstPresent(item, ["total_elevation_gain"])),
            bajada,
            fmt.num(gradiente === null ? null : gradiente * 100, 1),
            `${fmt.num(fmt.firstPresent(item, ["average_heartrate"]))}/` +
              `${fmt.num(fmt.firstPresent(item, ["max_heartrate"]))}`,
            fmt.pace(fmt.firstPresent(item, ["average_speed"]), sport),
            fmt.pace(fmt.firstPresent(item, ["gap"]), sport),
            fmt.num(fmt.firstPresent(item, ["average_watts"])),
            fmt.num(fmt.firstPresent(item, ["decoupling"]), 1),
          ];
        });
        let headers = [
          "#", "tipo", "tiempo", "dist", "subida", "bajada", "pend%",
          "FCmed/máx", "ritmo", "GAP", "W", "desac%",
        ];
        let align = ["r", "l", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r"];
        let outRows = rows;
        [headers, outRows, align] = dropEmptyColumns(headers, outRows, align, [0, 1, 2]);
        out.push("", `Intervalos (${intervals.length}):`);
        const leyenda: string[] = [];
        if (headers.includes("subida")) leyenda.push("subida ascenso acumulado + m");
        if (headers.includes("pend%")) leyenda.push("pend% pendiente media");
        if (headers.includes("desac%")) leyenda.push("desac% desacople del intervalo");
        if (leyenda.length) out.push(leyenda.join(" · "));
        out.push(fmt.table(headers, outRows, align));
        if (bajadasDerivadas) {
          // Subida y bajada no salen del mismo sitio: hay que decirlo, y darle a
          // quien lea la tabla con qué medir la diferencia.
          const total = desnivelAcumulado(altitud);
          out.push(
            `La 'bajada' NO la publica la API: se deriva de la serie de altitud con umbral ` +
              `de ${UMBRAL_DESNIVEL_M} m, mientras que la 'subida' es la de intervals.icu. ` +
              `Con el método de la bajada, la subida de toda la actividad daría ` +
              `+${Math.round(total.subida)} m frente a los ` +
              `+${fmt.num(fmt.firstPresent(detail, ["total_elevation_gain"]))} m oficiales: ` +
              "esa es la diferencia entre los dos métodos.",
          );
        }
        if (intervals.length > MAX_INTERVAL_ROWS) {
          out.push(`(Mostrados los primeros ${MAX_INTERVAL_ROWS}.)`);
        }
      } else {
        out.push("", "Sin intervalos analizados en esta actividad.");
      }

      return out.join("\n");
    }, "get_activity");
  }

  // ------------------------------------------------------- series de la actividad

  /**
   * La serie punto a punto, remuestreada. Dos avisos de diseño:
   * intervals.icu NO tiene parámetro de resolución (sirve la serie entera), así
   * que el remuestreo lo hace el Worker; y cada fila es un TRAMO agregado (ritmo
   * = distancia/tiempo del tramo, FC = media del tramo), no una muestra suelta.
   */
  getActivityStreams(
    activityId: unknown,
    cadaSegundos: unknown = null,
    cadaMetros: unknown = null,
    vuelta: unknown = null,
  ): Promise<string> {
    return this.guard(async () => {
      const raw = this.activityIdOf(activityId);
      const pideTiempo = cadaSegundos !== null && cadaSegundos !== undefined;
      const pideDistancia = cadaMetros !== null && cadaMetros !== undefined;
      if (pideTiempo && pideDistancia) {
        throw new Error(
          "Pasa 'cada_segundos' o 'cada_metros', no los dos: la serie se remuestrea por " +
            "tiempo o por distancia, no por las dos cosas a la vez.",
        );
      }
      const pasoPedido = pideTiempo ? clamp(cadaSegundos, 1, 3600, "cada_segundos") : null;
      const pasoMetros = pideDistancia ? clamp(cadaMetros, 5, 10_000, "cada_metros") : null;
      const numVuelta =
        vuelta === null || vuelta === undefined ? null : clamp(vuelta, 1, 500, "vuelta");

      const detalle = await this.client.activity(raw);
      const sport = String(detalle.type ?? fmt.DASH);
      const series: Series = indexarSeries(await this.client.activityStreams(raw, STREAM_TYPES));
      const longitud = longitudSeries(series);
      if (!longitud) {
        return (
          `La actividad ${raw} no tiene series punto a punto. Pasa con las sesiones ` +
          "metidas a mano o subidas sin datos de sensor; el resumen sigue estando en " +
          "get_activity."
        );
      }

      const tiempo = serieTiempo(series, longitud);
      const distancia = series.get("distance");
      const altitud = series.get("altitude");

      // ------------------------------------------------- recorte a una vuelta
      let desde = 0;
      let hasta = longitud - 1;
      let recorte = "actividad completa";
      if (numVuelta !== null) {
        const intervalos = await this.client.activityIntervals(raw);
        const item = intervalos[numVuelta - 1];
        if (!item) {
          throw new Error(
            `La actividad ${raw} no tiene la vuelta ${numVuelta}: solo hay ${intervalos.length}. ` +
              "Los números son los de la columna '#' de get_activity.",
          );
        }
        const inicio = toFloat(fmt.firstPresent(item, ["start_index"]));
        const fin = toFloat(fmt.firstPresent(item, ["end_index"]));
        if (inicio === null || fin === null) {
          throw new Error(
            `La vuelta ${numVuelta} no trae start_index/end_index, así que no se puede ` +
              "recortar sobre la serie. Pide la actividad entera y localiza el tramo por tiempo.",
          );
        }
        desde = Math.max(0, Math.round(inicio));
        hasta = Math.min(longitud - 1, Math.round(fin));
        if (hasta <= desde) {
          throw new Error(
            `La vuelta ${numVuelta} ocupa menos de una muestra de la serie: nada que remuestrear.`,
          );
        }
        const etiqueta = fmt.clip(item.label ?? item.type ?? `#${numVuelta}`, 30);
        recorte = `vuelta ${numVuelta}${etiqueta ? ` · ${etiqueta}` : ""}`;
      }

      // ------------------------------------------------------- resolución
      const t0 = primerValor(tiempo, desde, hasta) ?? 0;
      const t1 = ultimoValor(tiempo, desde, hasta) ?? 0;
      const segundosTramo = Math.max(0, t1 - t0);
      let guia: Serie | undefined;
      let paso: number;
      let comoSeRemuestrea: string;
      if (pasoMetros !== null) {
        if (!distancia) {
          throw new Error(
            "La actividad no tiene serie de distancia (cinta o rodillo sin sensor), " +
              "así que no se puede remuestrear cada X metros: usa 'cada_segundos'.",
          );
        }
        guia = distancia;
        paso = pasoMetros;
        comoSeRemuestrea = `cada ${pasoMetros} m`;
      } else {
        guia = tiempo;
        paso = pasoPedido ?? pasoAutomatico(segundosTramo, OBJETIVO_STREAM_ROWS);
        comoSeRemuestrea =
          `cada ${paso} s` + (pasoPedido === null ? " (automático para no pasar de ~120 filas)" : "");
      }

      const todos = tramos(guia, paso, desde, hasta);
      if (!todos.length) {
        return (
          `El tramo pedido de ${raw} (${recorte}) no da ni un tramo de ${comoSeRemuestrea}: ` +
          "es más corto que la resolución. Pide una resolución más fina."
        );
      }
      const recortada = todos.length > MAX_STREAM_ROWS;
      const usados = recortada ? todos.slice(0, MAX_STREAM_ROWS) : todos;

      // ------------------------------------------------------------ filas
      const rows: string[][] = usados.map((tramo) => {
        const altInicio = primerValor(altitud, tramo.desde, tramo.hasta);
        const altFin = ultimoValor(altitud, tramo.desde, tramo.hasta);
        const distInicio = primerValor(distancia, tramo.desde, tramo.hasta);
        const distFin = ultimoValor(distancia, tramo.desde, tramo.hasta);
        const segundos =
          (ultimoValor(tiempo, tramo.desde, tramo.hasta) ?? 0) -
          (primerValor(tiempo, tramo.desde, tramo.hasta) ?? 0);
        const metros = distInicio !== null && distFin !== null ? distFin - distInicio : null;

        // El ritmo del tramo sale de distancia/tiempo; la serie de velocidad
        // instantánea solo se usa cuando no hay distancia (cinta sin sensor).
        const velocidad =
          metros !== null && segundos > 0
            ? metros / segundos
            : media(series.get("velocity_smooth"), tramo.desde, tramo.hasta);
        const pendiente =
          altInicio !== null && altFin !== null && metros !== null && metros > 0
            ? ((altFin - altInicio) / metros) * 100
            : null;

        return [
          fmt.duration(ultimoValor(tiempo, tramo.desde, tramo.hasta)),
          fmt.km(distFin, 2),
          fmt.num(altFin),
          fmt.num(pendiente, 1),
          fmt.num(media(series.get("heartrate"), tramo.desde, tramo.hasta)),
          fmt.pace(velocidad, sport),
          fmt.num(media(series.get("cadence"), tramo.desde, tramo.hasta)),
          fmt.num(media(series.get("watts"), tramo.desde, tramo.hasta)),
          fmt.num(media(series.get("temp"), tramo.desde, tramo.hasta), 1),
        ];
      });

      let headers = ["t", "km", "alt", "pend%", "FC", "ritmo", "cad", "W", "°C"];
      let align = ["r", "r", "r", "r", "r", "r", "r", "r", "r"];
      let outRows = rows;
      [headers, outRows, align] = dropEmptyColumns(headers, outRows, align, [0]);

      const desnivel = desnivelAcumulado(altitud, desde, hasta);
      const out = [
        `Series · ${detalle.id ?? raw} · ${detalle.name ?? "Sin nombre"} · ${sport} · ` +
          String(detalle.start_date_local ?? "").slice(0, 10),
        `${recorte} · ${longitud} muestras originales · remuestreadas ${comoSeRemuestrea} ` +
          `→ ${outRows.length} tramos`,
        "Cada fila es un TRAMO, no un punto: 't', 'km' y 'alt' son el final del tramo; " +
          "'pend%', 'ritmo' y las medias (FC, cad, W, °C) son de todo el tramo. " +
          "Unidades: alt m · ritmo min/km (km/h en bici) · °C sensor del reloj",
        "",
        fmt.table(headers, outRows, align),
      ];

      if (altitud) {
        out.push(
          "",
          `Desnivel del tramo, acumulado sobre la serie completa (umbral ${UMBRAL_DESNIVEL_M} m, ` +
            `no el método de intervals.icu): +${Math.round(desnivel.subida)} m / ` +
            `−${Math.round(desnivel.bajada)} m.`,
        );
      }
      if (recortada) {
        out.push(
          "",
          `AVISO: salían ${todos.length} tramos y solo se muestran los ${MAX_STREAM_ROWS} ` +
            "primeros. El resto NO está en esta tabla: sube 'cada_segundos'/'cada_metros' " +
            "o recorta con 'vuelta' antes de dar por leído el perfil entero.",
        );
      }
      return out.join("\n");
    }, "get_activity_streams");
  }

  // ------------------------------------------------------- resumen semanal

  getWeeklySummary(weeks: unknown = 8): Promise<string> {
    return this.guard(async () => {
      const clamped = clamp(weeks ?? 8, 1, 52, "weeks");
      const today = this.today();
      const currentMonday = addDays(today, -weekdayMonday0(today));
      const oldest = addDays(currentMonday, -7 * (clamped - 1));
      const activities = await this.client.activities(oldest, today, 1000);

      if (!activities.length) {
        return `Sin actividades entre ${oldest} y ${today} (${clamped} semanas).`;
      }

      type Bucket = { n: number; time: number; dist: number; elev: number; load: number };
      const buckets = new Map<string, Bucket>(); // clave "semana|deporte"

      for (const item of activities) {
        const dayText = fmt.dateShort(item.start_date_local);
        if (!DATE_RE.test(dayText)) continue;
        const week = addDays(dayText, -weekdayMonday0(dayText));
        const sport = String(item.type ?? fmt.DASH);
        const key = `${week}|${sport}`;
        const bucket = buckets.get(key) ?? { n: 0, time: 0, dist: 0, elev: 0, load: 0 };
        bucket.n += 1;
        bucket.time += toFloat(fmt.firstPresent(item, ["moving_time", "elapsed_time"])) ?? 0;
        bucket.dist += toFloat(fmt.firstPresent(item, ["distance", "icu_distance"])) ?? 0;
        bucket.elev += toFloat(fmt.firstPresent(item, ["total_elevation_gain"])) ?? 0;
        bucket.load += toFloat(fmt.firstPresent(item, ["icu_training_load"])) ?? 0;
        buckets.set(key, bucket);
      }

      const weeksSet = [...new Set([...buckets.keys()].map((k) => k.split("|")[0]!))].sort(
        (a, b) => b.localeCompare(a),
      );

      const weekRow = (week: string, sport: string, data: Bucket): string[] => [
        week,
        sport,
        String(data.n),
        fmt.duration(data.time, { forceHours: true }),
        fmt.km(data.dist),
        fmt.elevation(data.elev),
        fmt.num(data.load),
      ];

      const rows: string[][] = [];
      for (const week of weeksSet) {
        const weekSports: Array<[string, Bucket]> = [];
        for (const [key, data] of buckets) {
          const [w, sport] = [key.split("|")[0]!, key.split("|").slice(1).join("|")];
          if (w === week) weekSports.push([sport, data]);
        }
        const total: Bucket = { n: 0, time: 0, dist: 0, elev: 0, load: 0 };
        for (const [sport, data] of weekSports.sort((a, b) => b[1].time - a[1].time)) {
          rows.push(weekRow(week, sport, data));
          total.n += data.n;
          total.time += data.time;
          total.dist += data.dist;
          total.elev += data.elev;
          total.load += data.load;
        }
        rows.push(weekRow(week, "TOTAL", total));
      }

      return [
        `Resumen semanal · ${clamped} semanas (${oldest} → ${today}, más reciente primero)`,
        "Semanas de lunes a domingo. Unidades: tiempo h:mm:ss · distancia km · " +
          "desnivel + m · carga (training load de intervals.icu)",
        "",
        fmt.table(
          ["semana", "deporte", "ses.", "tiempo", "dist", "desnivel", "carga"],
          rows,
          ["l", "l", "r", "r", "r", "r", "r"],
        ),
      ].join("\n");
    }, "get_weekly_summary");
  }

  // ----------------------------------------------------------------- rachas

  getStreaks(
    db: D1Database,
    days: unknown = 120,
    minMinutos: unknown = null,
    enSegundoPlano?: (promesa: Promise<unknown>) => void,
  ): Promise<string> {
    return this.guard(async () => {
      const dias = clamp(days ?? 120, 14, 365, "days");
      const minutos = clamp(
        minMinutos ?? Math.round(UMBRALES.minSegundos / 60),
        1,
        120,
        "min_minutos",
      );
      // Histórico de D1 + los últimos días en vivo: misma lectura que el panel.
      const { resultado } = await leerRachas(db, this.client, this.config, {
        dias,
        umbrales: { minSegundos: minutos * 60 },
        enSegundoPlano,
      });
      return formatRachas(resultado);
    }, "get_streaks");
  }

  // ---------------------------------------------------------------- eventos

  listEvents(
    daysBack: unknown = 7,
    daysAhead: unknown = 21,
    oldest?: unknown,
    newest?: unknown,
    fullNotes: unknown = false,
  ): Promise<string> {
    return this.guard(async () => {
      const today = this.today();
      const explicit = (oldest ?? null) !== null || (newest ?? null) !== null;
      let first: string;
      let last: string;
      if (explicit) {
        first = oldest ? this.parseDate(oldest, "oldest") : today;
        last = newest ? this.parseDate(newest, "newest") : first;
        if (last < first) {
          throw new Error(`'newest' (${last}) es anterior a 'oldest' (${first}): invierte el rango.`);
        }
      } else {
        first = addDays(today, -clamp(daysBack ?? 7, 0, 180, "days_back"));
        last = addDays(today, clamp(daysAhead ?? 21, 0, 365, "days_ahead"));
      }

      let events = await this.client.events(first, last);

      if (!events.length) {
        return `Calendario vacío entre ${first} y ${last}.`;
      }

      events.sort((a, b) =>
        String(a.start_date_local ?? "").localeCompare(String(b.start_date_local ?? "")),
      );
      const total = events.length;
      const truncated = total > MAX_EVENT_ROWS;
      if (truncated) events = events.slice(0, MAX_EVENT_ROWS);

      const expandable = events.filter((e) => String(e.description ?? "").trim());
      const rows: string[][] = [];
      for (const event of events) {
        const category = String(event.category ?? fmt.DASH);
        const detailParts: string[] = [];
        const moving = fmt.firstPresent(event, ["moving_time", "time_target"]);
        if (moving) detailParts.push(fmt.duration(moving));
        const distance = fmt.firstPresent(event, ["distance", "distance_target"]);
        if (distance) detailParts.push(fmt.km(distance));
        const load = fmt.firstPresent(event, ["icu_training_load", "load_target"]);
        if (load) detailParts.push(`carga ${fmt.num(load)}`);
        const doc = event.workout_doc;
        const steps =
          doc && typeof doc === "object" && !Array.isArray(doc)
            ? (doc as JsonRecord).steps
            : null;
        if (Array.isArray(steps) && steps.length) detailParts.push(`${steps.length} pasos`);
        if (category === "NOTE" || !detailParts.length) {
          const text = fmt.clip(event.description, 60);
          if (text) detailParts.push(text);
        }

        rows.push([
          fmt.dateShort(event.start_date_local),
          category,
          String(event.id ?? fmt.DASH),
          String(event.type ?? fmt.DASH),
          fmt.clip(event.name, 34),
          detailParts.join(" · ") || fmt.DASH,
        ]);
      }

      let headers = ["fecha", "categoría", "id", "deporte", "título", "detalle"];
      let align = ["l", "l", "l", "l", "l", "l"];
      let outRows = rows;
      [headers, outRows, align] = dropEmptyColumns(headers, outRows, align, [0, 1, 2, 4, 5]);

      const out = [
        `Calendario · ${first} → ${last} · hoy es ${today} · ${outRows.length} eventos`,
        "Categorías: WORKOUT entreno planificado · NOTE nota · RACE_A/B/C carreras · " +
          "HOLIDAY/SICK/INJURED días especiales",
        "",
        fmt.table(headers, outRows, align),
      ];
      if (truncated) {
        out.push(
          "",
          `AVISO: hay ${total} eventos en el rango y solo se muestran los ` +
            `${MAX_EVENT_ROWS} primeros por fecha. Los demás NO están en esta tabla: ` +
            "parte el rango en trozos más cortos antes de dar nada por leído.",
        );
      }

      if (fullNotes && expandable.length) {
        const shown = expandable.slice(0, MAX_FULL_NOTES);
        out.push("", `Contenido completo (${shown.length} de ${expandable.length}):`);
        for (const event of shown) {
          out.push(
            "",
            `── ${fmt.dateShort(event.start_date_local)} · ` +
              `id ${event.id ?? fmt.DASH} · ${event.name ?? "sin título"}`,
            String(event.description ?? "").trim(),
          );
        }
        if (expandable.length > MAX_FULL_NOTES) {
          out.push(
            "",
            `AVISO: ${expandable.length - MAX_FULL_NOTES} descripciones más NO se han ` +
              "expandido. Reduce el rango o pide las que falten con get_event(id).",
          );
        }
      } else if (
        expandable.length &&
        expandable.some((e) => String(e.description ?? "").length > 60)
      ) {
        out.push(
          "",
          "AVISO: la columna 'detalle' está recortada a 60 caracteres y sin saltos de " +
            "línea. Hay descripciones más largas en este rango. Para leerlas enteras usa " +
            "full_notes=true, o get_event(id) para una sola. No des por leído lo que " +
            "aparece truncado.",
        );
      }
      return out.join("\n");
    }, "list_events");
  }

  // -------------------------------------------------------- crear entrenos

  createWorkout(
    date: unknown,
    sport: unknown,
    name: unknown,
    description: unknown = "",
    steps: unknown = null,
  ): Promise<string> {
    return this.guard(async () => {
      const day = this.parseDate(date, "date");
      const sportName = normalizeSport(String(sport ?? ""));
      if (!sportName) {
        throw new Error("Falta 'sport' (Run, Ride, Swim, VirtualRide, Walk, Hike…).");
      }
      const title = String(name ?? "").split(/\s+/).join(" ").trim();
      if (!title) {
        throw new Error("Falta 'name': el entreno necesita un título para el calendario.");
      }

      const text = renderWorkoutText(
        (steps as unknown[] | null) ?? null,
        String(description ?? ""),
      );
      if (!text.trim()) {
        throw new Error(
          "El entreno está vacío: pasa 'steps' (lista de pasos) o una 'description' " +
            "escrita ya en la sintaxis de intervals.icu.",
        );
      }

      const payload: JsonRecord = {
        start_date_local: `${day}T00:00:00`,
        category: "WORKOUT",
        type: sportName,
        name: title,
        description: text,
      };
      const created = await this.client.createEvent(payload);

      const enviado = contarEnviados((steps as unknown[] | null) ?? null);
      const visto = contarInterpretados(created.workout_doc);
      const out = [
        `Entreno creado: ${created.id ?? "?"} · ${day} · ${sportName} · ${title}`,
        "",
        "Texto enviado a intervals.icu:",
        text,
      ];
      const details: string[] = [];
      if (created.moving_time) {
        details.push(`duración estimada ${fmt.duration(created.moving_time)}`);
      }
      if (created.icu_training_load) {
        details.push(`carga prevista ${fmt.num(created.icu_training_load)}`);
      }
      if (visto?.hojas) {
        details.push(
          visto.hojas === visto.desplegados
            ? `${visto.hojas} pasos interpretados`
            : `${visto.hojas} pasos interpretados (${visto.desplegados} desplegados)`,
        );
      }
      if (details.length) {
        out.push("", "intervals.icu ha calculado: " + details.join(" · ") + ".");
      }

      // intervals.icu no escribe lo que se le manda: lo interpreta, y lo que no
      // entiende lo tira sin decirlo. Se compara antes de dar nada por escrito.
      if (steps && !visto?.hojas) {
        out.push(
          "",
          "Aviso: intervals.icu no ha interpretado el texto como entreno estructurado " +
            "(workout_doc sin pasos). Se verá como texto en el calendario y no llegará " +
            "al reloj con los intervalos. Revisa unidades: 'm' son minutos y los metros " +
            "se escriben 'mtr'.",
        );
      } else {
        for (const aviso of [avisoDePasos(enviado, visto), avisoDeDuracion(enviado, created.moving_time)]) {
          if (aviso) out.push("", aviso);
        }
      }
      if (day < this.today()) {
        out.push("", `Aviso: ${day} ya ha pasado, Garmin no sincroniza entrenos en el pasado.`);
      } else {
        out.push(
          "",
          "Si tienes activada la sincronización con Garmin en intervals.icu " +
            "(Settings → Garmin Connect → push planned workouts), aparecerá en el reloj " +
            "en unos minutos.",
        );
      }
      return out.join("\n");
    }, "create_workout");
  }

  createNote(date: unknown, text: unknown): Promise<string> {
    return this.guard(async () => {
      const day = this.parseDate(date, "date");
      const body = String(text ?? "").trim();
      if (!body) {
        throw new Error("Falta 'text': la nota no puede estar vacía.");
      }

      const title = fmt.clip(body.split("\n")[0], 60) || "Nota";
      const payload: JsonRecord = {
        start_date_local: `${day}T00:00:00`,
        category: "NOTE",
        name: title,
        description: body,
      };
      const created = await this.client.createEvent(payload);
      return `Nota creada: ${created.id ?? "?"} · ${day} · ${title}`;
    }, "create_note");
  }

  // ------------------------------------------------- leer, modificar, borrar

  private eventIdOf(value: unknown): string {
    let raw = String(value ?? "").trim();
    if (raw.toLowerCase().startsWith("i") && /^\d+$/.test(raw.slice(1))) {
      raw = raw.slice(1);
    }
    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `'event_id' debe ser el número que devuelve list_events en la columna 'id' ` +
          `(recibido ${JSON.stringify(value)}).`,
      );
    }
    return raw;
  }

  private static describe(event: JsonRecord): string {
    return (
      `${fmt.dateShort(event.start_date_local)} · ` +
      `${event.category ?? fmt.DASH} · ${event.name ?? "sin título"}`
    );
  }

  getEvent(eventId: unknown): Promise<string> {
    return this.guard(async () => {
      const eid = this.eventIdOf(eventId);
      const event = await this.client.event(eid);
      if (!Object.keys(event).length) {
        return `Error: el evento ${eid} no devolvió datos.`;
      }

      const out = [
        `Evento ${event.id ?? eid} · ${fmt.dateShort(event.start_date_local)} · ` +
          `${event.category ?? fmt.DASH}` +
          (event.type ? ` · ${event.type}` : ""),
        `Título: ${event.name ?? "sin título"}`,
      ];

      const details: string[] = [];
      const moving = fmt.firstPresent(event, ["moving_time", "time_target"]);
      if (moving) details.push(`duración ${fmt.duration(moving)}`);
      const distance = fmt.firstPresent(event, ["distance", "distance_target"]);
      if (distance) details.push(fmt.km(distance));
      const load = fmt.firstPresent(event, ["icu_training_load", "load_target"]);
      if (load) details.push(`carga ${fmt.num(load)}`);
      const doc = event.workout_doc;
      const steps =
        doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as JsonRecord).steps : null;
      if (Array.isArray(steps) && steps.length) details.push(`${steps.length} pasos interpretados`);
      if (details.length) out.push(details.join(" · "));

      const body = String(event.description ?? "").trim();
      out.push("");
      if (body) {
        out.push(`Contenido completo (${body.length} caracteres, sin recortar):`, body);
      } else {
        out.push("Sin descripción.");
      }
      return out.join("\n");
    }, "get_event");
  }

  updateEvent(
    eventId: unknown,
    text?: unknown,
    name?: unknown,
    date?: unknown,
  ): Promise<string> {
    return this.guard(async () => {
      const eid = this.eventIdOf(eventId);
      const noText = text === null || text === undefined;
      const noName = name === null || name === undefined;
      const noDate = date === null || date === undefined;
      if (noText && noName && noDate) {
        throw new Error(
          "Nada que actualizar: pasa 'text' (reescribe el contenido), 'name' (el título) " +
            "o 'date' (mover de día).",
        );
      }

      const before = await this.client.event(eid); // 404 aquí = el evento no existe
      const payload: JsonRecord = {};

      if (!noText) {
        const body = String(text).trim();
        if (!body) {
          throw new Error(
            "'text' está vacío. Para eliminar el evento usa delete_event; " +
              "para dejarlo como está, no pases 'text'.",
          );
        }
        payload.description = body;
        if (noName) {
          payload.name = fmt.clip(body.split("\n")[0], 60) || "Nota";
        }
      }

      if (!noName) {
        const title = String(name).split(/\s+/).join(" ").trim();
        if (!title) {
          throw new Error("'name' está vacío: pasa un título o no pases el campo.");
        }
        payload.name = title;
      }

      if (!noDate) {
        const day = this.parseDate(date, "date");
        payload.start_date_local = `${day}T00:00:00`;
      }

      const updated = await this.client.updateEvent(eid, payload);

      const changes: string[] = [];
      if ("description" in payload) {
        changes.push(`contenido reescrito (${String(payload.description).length} caracteres)`);
      }
      if ("name" in payload) {
        changes.push(`título → «${payload.name}»`);
      }
      if ("start_date_local" in payload) {
        changes.push(
          `fecha ${fmt.dateShort(before.start_date_local)} → ` +
            String(payload.start_date_local).slice(0, 10),
        );
      }

      const after = Object.keys(updated).length ? updated : { ...before, ...payload };
      const out = [
        `Evento ${eid} actualizado: ${IntervalsTools.describe(after)}`,
        `Antes: ${IntervalsTools.describe(before)}`,
        "Cambios: " + changes.join(" · ") + ".",
      ];

      // Reescribir el contenido es reescribir el entreno, y intervals.icu lo
      // INTERPRETA: hay que mirar con qué se ha quedado. Sin esto, una duración
      // disparada de 2h10 a 18h50 no se ve por ningún lado (R042).
      if ("description" in payload) {
        const relido = await this.client.event(eid);
        const visto = contarInterpretados(relido.workout_doc);
        const lineas = String(payload.description).split("\n").filter((l) => l.trim().startsWith("-"));
        const leido: string[] = [];
        const moving = fmt.firstPresent(relido, ["moving_time", "time_target"]);
        if (moving) leido.push(`duración ${fmt.duration(moving)}`);
        if (relido.icu_training_load) leido.push(`carga ${fmt.num(relido.icu_training_load)}`);
        if (visto?.hojas) {
          leido.push(
            visto.hojas === visto.desplegados
              ? `${visto.hojas} pasos`
              : `${visto.hojas} pasos (${visto.desplegados} desplegados)`,
          );
        }
        if (leido.length) {
          out.push("", "Releído del servidor · intervals.icu ha interpretado: " + leido.join(" · ") + ".");
        }
        if (lineas.length && !visto?.hojas) {
          out.push(
            "",
            `AVISO · NO HAY ENTRENO: se enviaron ${lineas.length} líneas de paso y intervals.icu ` +
              "no ha interpretado ninguna (workout_doc sin pasos). Se verá como texto en el " +
              "calendario y no llegará al reloj. Revisa unidades: 'm' son minutos, los metros " +
              "se escriben 'mtr'.",
          );
        }
      }
      return out.join("\n");
    }, "update_event");
  }

  deleteEvent(eventId: unknown, confirm: unknown = false): Promise<string> {
    return this.guard(async () => {
      const eid = this.eventIdOf(eventId);
      const before = await this.client.event(eid); // 404 aquí = el evento no existe

      if (!confirm) {
        return [
          `NO se ha borrado nada. El evento ${eid} es: ${IntervalsTools.describe(before)}`,
          "",
          "El borrado es irreversible y intervals.icu no tiene papelera. " +
            "Comprueba que es exactamente este evento y repite la llamada con confirm=true.",
        ].join("\n");
      }

      await this.client.deleteEvent(eid);
      return `Evento borrado (irreversible): ${eid} · ${IntervalsTools.describe(before)}`;
    }, "delete_event");
  }

  // ------------------------------------------------- ajustes del atleta

  getAthleteSettings(): Promise<string> {
    return this.guard(async () => {
      const profile = await this.client.athleteProfile();
      let sportSettings: JsonRecord[] = [];
      let sportSettingsError: string | null = null;
      try {
        sportSettings = await this.client.sportSettings();
      } catch (exc) {
        sportSettingsError = exc instanceof Error ? exc.message : String(exc);
      }

      const out: string[] = [
        `Ajustes del atleta ${this.config.athleteId}` +
          (profile.name ? ` · ${profile.name}` : ""),
      ];

      const profileBits: string[] = [];
      const weight = fmt.firstPresent(profile, ["weight", "icu_weight"]);
      if (weight) profileBits.push(`peso ${fmt.num(weight, 1)} kg`);
      if (profile.timezone) profileBits.push(`TZ ${profile.timezone}`);
      if (profile.sex) profileBits.push(String(profile.sex));
      if (profileBits.length) out.push(profileBits.join(" · "));

      if (sportSettings.length) {
        for (const setting of sportSettings) {
          const types = Array.isArray(setting.types) ? setting.types.join(", ") : "?";
          out.push("", `── ${types} (id ${setting.id ?? "?"})`);
          const bits: string[] = [];
          const lthr = fmt.firstPresent(setting, ["lthr"]);
          if (lthr) bits.push(`LTHR ${fmt.num(lthr)} ppm`);
          const maxHr = fmt.firstPresent(setting, ["max_hr"]);
          if (maxHr) bits.push(`FCmáx ${fmt.num(maxHr)} ppm`);
          const ftp = fmt.firstPresent(setting, ["ftp", "indoor_ftp"]);
          if (ftp) bits.push(`FTP ${fmt.num(ftp)} W`);
          const thresholdPace = fmt.firstPresent(setting, ["threshold_pace"]);
          const tpNum = toFloat(thresholdPace);
          if (tpNum) {
            const sport = types.toLowerCase().includes("swim") ? "Swim" : "Run";
            bits.push(`ritmo umbral ${fmt.pace(tpNum, sport)}`);
          }
          if (bits.length) out.push(bits.join(" · "));

          for (const [label, key] of [
            ["Zonas FC (ppm)", "hr_zones"],
            ["Zonas de ritmo (m/s)", "pace_zones"],
            ["Zonas de potencia", "power_zones"],
          ] as Array<[string, string]>) {
            const zones = setting[key];
            if (Array.isArray(zones) && zones.length) {
              const names = Array.isArray(setting[`${key.split("_")[0]}_zone_names`])
                ? (setting[`${key.split("_")[0]}_zone_names`] as unknown[])
                : null;
              out.push(
                `${label}: ` +
                  zones
                    .map((z, i) => `${names?.[i] ?? `Z${i + 1}`} ≤${z}`)
                    .join(" · "),
              );
            }
          }
        }
      } else {
        out.push(
          "",
          sportSettingsError
            ? `No se pudieron leer los ajustes por deporte: ${sportSettingsError}`
            : "Sin ajustes por deporte devueltos por la API.",
        );
      }

      out.push(
        "",
        "Para cambiar valores usa update_athlete_settings con confirm=true. " +
          "Las zonas y umbrales son la base de toda prescripción: cámbialos solo con evidencia.",
      );
      return out.join("\n");
    }, "get_athlete_settings");
  }

  updateAthleteSettings(
    sport: unknown,
    fields: unknown,
    confirm: unknown = false,
  ): Promise<string> {
    return this.guard(async () => {
      const sportName = String(sport ?? "").trim();
      if (!sportName) {
        throw new Error("Falta 'sport': el deporte cuyos ajustes quieres tocar (p. ej. Run).");
      }
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        throw new Error(
          "Falta 'fields': objeto con los campos a cambiar, p. ej. " +
            '{"lthr": 193, "max_hr": 206}.',
        );
      }
      const patch = fields as JsonRecord;
      if (!Object.keys(patch).length) {
        throw new Error("'fields' está vacío: no hay nada que cambiar.");
      }

      const settings = await this.client.sportSettings();
      const normalized = normalizeSport(sportName).toLowerCase();
      const match = settings.find((s) => {
        const types = Array.isArray(s.types) ? s.types.map((t) => String(t).toLowerCase()) : [];
        return types.includes(normalized) || types.includes(sportName.toLowerCase());
      });
      if (!match) {
        const available = settings
          .map((s) => (Array.isArray(s.types) ? s.types.join("/") : "?"))
          .join(", ");
        throw new Error(
          `No hay ajustes para el deporte '${sportName}'. Perfiles disponibles: ${available || "ninguno"}.`,
        );
      }

      const changes = Object.entries(patch)
        .map(([key, value]) => `${key}: ${JSON.stringify(match[key] ?? null)} → ${JSON.stringify(value)}`)
        .join("\n");

      if (!confirm) {
        return [
          `NO se ha cambiado nada. Ajustes de ${Array.isArray(match.types) ? match.types.join("/") : sportName} (id ${match.id}):`,
          changes,
          "",
          "Los umbrales y zonas gobiernan todas las prescripciones. Verifica los valores " +
            "y repite la llamada con confirm=true para aplicarlos.",
        ].join("\n");
      }

      const payload = { ...match, ...patch };
      await this.client.updateSportSettings(String(match.id), payload);
      return [
        `Ajustes actualizados para ${Array.isArray(match.types) ? match.types.join("/") : sportName} (id ${match.id}):`,
        changes,
      ].join("\n");
    }, "update_athlete_settings");
  }
}
