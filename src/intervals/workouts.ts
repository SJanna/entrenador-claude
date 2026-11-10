/**
 * Traduce pasos estructurados al formato de texto de entrenos de intervals.icu.
 *
 * intervals.icu no recibe los pasos como JSON: parsea el campo `description` del
 * evento y de ahí construye el workout estructurado que empuja a Garmin. Este
 * módulo genera ese texto con la sintaxis oficial. Port fiel de workouts.py.
 *
 * Trampas que gestiona:
 *  - "m" significa minutos: los metros se escriben "mtr".
 *  - Un ritmo absoluto necesita la palabra "pace" o intervals.icu lo descarta.
 */

const STEP_KEYS = new Set([
  "label", "text", "duration", "distance", "lap_press", "target", "ramp", "kind",
  "power_pct", "watts", "hr_pct", "bpm", "pace_pct", "pace", "zone", "zone_kind",
  "cadence", "rest", "intensity", "free",
]);
const GROUP_KEYS = new Set(["section", "repeat", "steps"]);
const INTENSITIES = new Set(["warmup", "active", "rest", "cooldown"]);
const KINDS = new Set(["power", "hr", "pace"]);

const DURATION_TEXT = /^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/i;
const CLOCK = /^\d+:\d{2}(?::\d{2})?$/;
const DISTANCE_TEXT = /^(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)$/;
const ABSOLUTE_PACE = /^\d+:\d{2}\s*\/\s*(km|mi|100m|100y)$/i;

const SPORT_ALIASES: Record<string, string> = {
  run: "Run", running: "Run", carrera: "Run", correr: "Run", rodaje: "Run",
  trail: "Run", trailrun: "Run", virtualrun: "VirtualRun", cinta: "VirtualRun",
  ride: "Ride", bike: "Ride", cycling: "Ride", ciclismo: "Ride", bici: "Ride",
  bicicleta: "Ride", virtualride: "VirtualRide", rodillo: "VirtualRide",
  swim: "Swim", natacion: "Swim", "natación": "Swim", nadar: "Swim", piscina: "Swim",
  walk: "Walk", caminar: "Walk", andar: "Walk", paseo: "Walk",
  hike: "Hike", senderismo: "Hike", "montaña": "Hike",
  weighttraining: "WeightTraining", fuerza: "WeightTraining", pesas: "WeightTraining",
  gimnasio: "WeightTraining", gym: "WeightTraining",
  rowing: "Rowing", remo: "Rowing", elliptical: "Elliptical", eliptica: "Elliptical",
  yoga: "Yoga", other: "Other", otro: "Other",
};

export class WorkoutSpecError extends Error {}

type Step = Record<string, unknown>;

/** Acepta el nombre en español o inglés; si no se reconoce, se envía tal cual. */
export function normalizeSport(sport: string): string {
  const key = (sport || "").trim().toLowerCase().replaceAll(" ", "").replaceAll("-", "");
  return SPORT_ALIASES[key] ?? (sport || "").trim();
}

/** Pasos + texto libre → descripción lista para POST /events. */
export function renderWorkoutText(
  steps: unknown[] | null | undefined,
  extraDescription?: string | null,
): string {
  const blocks: string[] = [];
  let header: string | null = null;
  let lines: string[] = [];

  const flush = (): void => {
    if (lines.length) {
      blocks.push([...(header ? [header] : []), ...lines].join("\n"));
    }
    header = null;
    lines = [];
  };

  (steps || []).forEach((raw, i) => {
    const index = i + 1;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new WorkoutSpecError(
        `El paso ${index} no es un objeto. Cada paso es un diccionario, por ` +
          `ejemplo {"duration": "10m", "power_pct": 60}.`,
      );
    }
    const step = raw as Step;
    const unknown = Object.keys(step).filter((k) => !STEP_KEYS.has(k) && !GROUP_KEYS.has(k));
    if (unknown.length) {
      throw new WorkoutSpecError(
        `El paso ${index} tiene claves desconocidas: ${unknown.sort().join(", ")}. ` +
          `Claves válidas: ${[...STEP_KEYS, ...GROUP_KEYS].sort().join(", ")}.`,
      );
    }

    const nested = step.steps;
    const repeat = step.repeat;
    const section = step.section;

    if (nested) {
      if (!Array.isArray(nested)) {
        throw new WorkoutSpecError(`'steps' del paso ${index} debe ser una lista.`);
      }
      flush();
      const name = section ? String(section).trim() : repeat ? "Serie" : "Bloque";
      const title = repeat ? `${name} ${repeatCount(repeat, index)}x` : name;
      blocks.push([title, ...nested.map((s) => renderStep(s, index))].join("\n"));
      return;
    }

    if (repeat) {
      throw new WorkoutSpecError(
        `El paso ${index} indica 'repeat' pero no trae 'steps'. Las repeticiones ` +
          `necesitan los pasos que se repiten: {"section": "Series", "repeat": 5, "steps": [...]}`,
      );
    }

    const hasStepKeys = Object.keys(step).some((k) => STEP_KEYS.has(k));
    if (section && !hasStepKeys) {
      flush();
      header = String(section).trim();
      return;
    }

    if (section) {
      flush();
      header = String(section).trim();
    }

    lines.push(renderStep(step, index));
  });

  flush();

  let text = blocks.join("\n\n");
  const extra = (extraDescription || "").trim();
  // Sin pasos, la descripción ES el entreno en sintaxis de intervals: ahí los
  // guiones y las duraciones son lo que se quiere. Solo se vigila la prosa que
  // acompaña a unos pasos estructurados.
  if ((steps || []).length) validarDescripcion(extra);
  if (extra) {
    text = text ? `${text}\n\n${extra}` : extra;
  }
  return text;
}

/**
 * VERIFICAR LO ESCRITO.
 *
 * intervals.icu no escribe lo que se le manda: lo INTERPRETA. Lee el texto,
 * decide que es un paso y que no, y lo que no entiende lo tira sin decirlo. Tres
 * veces ha pasado ya, y las tres el sistema respondio OK:
 *
 *  - R030: pasos descartados (un `lap press` que no llego al reloj).
 *  - R034: pasos FABRICADOS desde la descripcion, que no se habian enviado.
 *  - R042: la duracion disparada de 2h10 a 18h50 por unos tokens en un label,
 *    con el numero de pasos correcto.
 *
 * El contrato dice que nada se da por escrito sin confirmacion de la herramienta
 * (R009) y aqui la herramienta confirmaba. Asi que se cuenta lo enviado y se
 * compara con lo interpretado. Lo importante es NO DAR FALSAS ALARMAS: no
 * sabemos si intervals devuelve las series desplegadas o anidadas, ni si un
 * `rest` se convierte en un paso aparte, asi que se acepta cualquier lectura
 * dentro de una horquilla y solo se avisa de lo que no cabe en ninguna.
 */

/** Lo enviado, contado igual que se cuenta lo interpretado. */
export interface Enviado {
  /** Pasos escritos: una serie 5x cuenta sus pasos UNA vez. */
  hojas: number;
  /** Pasos que ejecuta el reloj, con las repeticiones desplegadas. */
  desplegados: number;
  /** Cuantos de los desplegados llevan 'rest', que intervals puede separar. */
  conRest: number;
  /** Segundos sumados, con los rest dentro; null si algun paso no va por tiempo. */
  segundos: number | null;
}

/** Lo que intervals.icu dice haber entendido. */
export interface Interpretado {
  hojas: number;
  desplegados: number;
}

/** Una duracion de la sintaxis en segundos, o null si no es una duracion. */
export function segundosDeDuracion(valor: unknown): number | null {
  if (valor === null || valor === undefined || typeof valor === "boolean") return null;
  if (typeof valor === "number") {
    return Number.isFinite(valor) && valor > 0 ? Math.round(valor) : null;
  }
  const texto = String(valor).trim().replaceAll(" ", "");
  if (!texto) return null;
  if (/^\d+$/.test(texto)) return Number(texto);
  if (CLOCK.test(texto)) {
    const partes = texto.split(":").map(Number);
    return partes.length === 3
      ? partes[0]! * 3600 + partes[1]! * 60 + partes[2]!
      : partes[0]! * 60 + partes[1]!;
  }
  const trozos = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(texto);
  if (!trozos || !(trozos[1] || trozos[2] || trozos[3])) return null;
  return Number(trozos[1] ?? 0) * 3600 + Number(trozos[2] ?? 0) * 60 + Number(trozos[3] ?? 0);
}

/** Cuenta los pasos que se envian, con y sin desplegar las series. */
export function contarEnviados(steps: unknown[] | null | undefined): Enviado {
  let hojas = 0;
  let desplegados = 0;
  let conRest = 0;
  let segundos: number | null = 0;

  const contarHoja = (bruto: unknown, veces: number): void => {
    if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return;
    const paso = bruto as Step;
    hojas += 1;
    desplegados += veces;
    const tieneRest = paso.rest !== null && paso.rest !== undefined;
    if (tieneRest) conRest += veces;
    if (segundos === null) return;
    const dura = segundosDeDuracion(paso.duration);
    if (dura === null) {
      // Un paso por distancia no aporta segundos: la suma deja de servir entera.
      segundos = null;
      return;
    }
    segundos += (dura + (tieneRest ? (segundosDeDuracion(paso.rest) ?? 0) : 0)) * veces;
  };

  for (const bruto of steps || []) {
    if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) continue;
    const paso = bruto as Step;
    if (Array.isArray(paso.steps)) {
      const n = Math.floor(Number(paso.repeat));
      const veces = Number.isFinite(n) && n >= 1 ? n : 1;
      for (const hijo of paso.steps) contarHoja(hijo, veces);
      continue;
    }
    const soloSeccion = paso.section && !Object.keys(paso).some((k) => STEP_KEYS.has(k));
    if (soloSeccion) continue;
    contarHoja(paso, 1);
  }
  return { hojas, desplegados, conRest, segundos };
}

/** Cuenta los pasos del workout_doc, o null si la respuesta no trae ninguno. */
export function contarInterpretados(doc: unknown): Interpretado | null {
  const raiz =
    doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>).steps
      : null;
  if (!Array.isArray(raiz)) return null;
  let hojas = 0;
  let desplegados = 0;
  const recorrer = (lista: unknown[], veces: number, hondura: number): void => {
    if (hondura > 6) return;
    for (const bruto of lista) {
      if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) continue;
      const nodo = bruto as Record<string, unknown>;
      if (Array.isArray(nodo.steps)) {
        const n = Math.floor(Number(nodo.reps ?? nodo.repeat ?? nodo.repeats ?? nodo.count));
        recorrer(nodo.steps, veces * (Number.isFinite(n) && n >= 1 ? n : 1), hondura + 1);
        continue;
      }
      hojas += 1;
      desplegados += veces;
    }
  };
  recorrer(raiz, 1, 0);
  return { hojas, desplegados };
}

function reloj(segundos: number): string {
  const h = Math.floor(segundos / 3600);
  const m = Math.round((segundos % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m} min`;
}

/** El aviso si los pasos interpretados no caben en ninguna lectura de lo enviado. */
export function avisoDePasos(enviado: Enviado, visto: Interpretado | null): string | null {
  if (!visto || !enviado.hojas) return null;
  const suelo = enviado.hojas;
  const techo = enviado.desplegados + enviado.conRest;
  const cabe = (n: number): boolean => n >= suelo && n <= techo;
  if (cabe(visto.hojas) || cabe(visto.desplegados)) return null;

  const enviados =
    enviado.hojas === enviado.desplegados
      ? `${enviado.hojas}`
      : `${enviado.hojas} (${enviado.desplegados} con las series desplegadas)`;
  const leidos =
    visto.hojas === visto.desplegados ? `${visto.hojas}` : `${visto.hojas} (${visto.desplegados} desplegados)`;
  return visto.desplegados < suelo
    ? `AVISO · FALTAN PASOS: se enviaron ${enviados} e intervals.icu ha interpretado ${leidos}. ` +
        `Lo que no entiende lo DESCARTA sin decirlo (R030), y el entreno llega al reloj incompleto. ` +
        `Lee el entreno antes de darlo por escrito.`
    : `AVISO · SOBRAN PASOS: se enviaron ${enviados} e intervals.icu ha interpretado ${leidos}. ` +
        `intervals.icu tambien lee la descripcion y fabrica pasos desde ahi (R034). ` +
        `Lee el entreno antes de darlo por escrito.`;
}

/** El aviso si la duracion calculada no se parece a la suma de lo enviado. */
export function avisoDeDuracion(enviado: Enviado, movingTime: unknown): string | null {
  if (enviado.segundos === null || enviado.segundos <= 0) return null;
  const visto = Number(movingTime);
  if (!Number.isFinite(visto) || visto <= 0) return null;
  const margen = Math.max(60, enviado.segundos * 0.1);
  if (Math.abs(visto - enviado.segundos) <= margen) return null;
  return (
    `AVISO · DURACION QUE NO CUADRA: los pasos suman ${reloj(enviado.segundos)} e intervals.icu ` +
    `ha calculado ${reloj(visto)}. Es el bug de los labels (R042): un token dentro del nombre de ` +
    `un paso se lee como duracion. Revisa los labels antes de darlo por escrito.`
  );
}

/**
 * Lecciones que antes vivían como reglas del contrato (R034) y ahora las hace
 * cumplir el servidor: intervals.icu lee el texto entero, también la etiqueta y
 * la descripción, y lo que parece sintaxis lo convierte en pasos o duración.
 *  - 27/08: «H10» en una etiqueta disparó la duración de 2h10 a 18h50.
 *  - 17/08: una línea «- 15m …» en la descripción se convirtió en un paso real.
 * Un atleta nuevo no debería tener que redescubrirlo.
 */
const LETRA_PEGADA_A_NUMERO = /[A-Za-zÀ-ÿ]\d|\d[A-Za-zÀ-ÿ]/;
const TOKEN_DURACION = /(^|[^\w:])\d+(?:[.,]\d+)?[smh](?![\wÀ-ÿ])/i;

export function validarEtiqueta(etiqueta: string, index: number): void {
  const palabra = etiqueta.split(" ").find((p) => LETRA_PEGADA_A_NUMERO.test(p));
  if (palabra) {
    throw new WorkoutSpecError(
      `Paso ${index}: la etiqueta "${etiqueta}" lleva "${palabra}", una letra pegada a un ` +
        `número. intervals.icu lo puede leer como duración o zona y el entreno cambia sin ` +
        `avisar. Escríbelo en palabras ("banda de pecho", "zona dos", "seis por veinte").`,
    );
  }
}

export function validarDescripcion(descripcion: string): void {
  descripcion.split("\n").forEach((linea, i) => {
    const limpia = linea.trim();
    if (/^[-*•]/.test(limpia)) {
      throw new WorkoutSpecError(
        `Descripción, línea ${i + 1}: empieza por guion o viñeta. intervals.icu convierte esas ` +
          `líneas en pasos del entreno. Escríbela como frase o como "1)".`,
      );
    }
    const token = TOKEN_DURACION.exec(limpia);
    if (token) {
      throw new WorkoutSpecError(
        `Descripción, línea ${i + 1}: "${token[0].trim()}" es sintaxis de duración de ` +
          `intervals.icu (s, m = MINUTOS, h). Escríbelo separado y en palabras: ` +
          `"10 minutos", "400 metros".`,
      );
    }
  });
}

export function renderStep(step: unknown, index: number): string {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new WorkoutSpecError(`El paso ${index} contiene un elemento que no es un objeto.`);
  }
  const record = step as Step;
  const unknown = Object.keys(record).filter((k) => !STEP_KEYS.has(k));
  if (unknown.length) {
    throw new WorkoutSpecError(
      `Paso ${index}: claves no válidas dentro de un paso: ${unknown.sort().join(", ")}.`,
    );
  }

  const parts: string[] = [];

  const label = record.label ?? record.text;
  if (label) {
    const cleaned = String(label).split(/\s+/).join(" ").trim();
    validarEtiqueta(cleaned, index);
    if (cleaned) parts.push(cleaned);
  }

  const hasDuration = record.duration !== null && record.duration !== undefined;
  const hasDistance = record.distance !== null && record.distance !== undefined;
  if (hasDuration && hasDistance) {
    throw new WorkoutSpecError(`Paso ${index}: usa 'duration' o 'distance', no las dos a la vez.`);
  }

  if (record.lap_press) {
    // Se escribia «lap press», intervals.icu descartaba la linea y la herramienta
    // respondia OK: el entreno llegaba al reloj sin ese paso (pendiente 32, R030).
    throw new WorkoutSpecError(
      `Paso ${index}: 'lap_press' no llega al reloj por esta via. intervals.icu descarta ` +
        `el paso y el entreno se crea sin el, sin avisar (R030). Si el paso tiene que acabar ` +
        `con el boton de vuelta, escribe el entreno con garmin_create_workout, que si lo ` +
        `soporta; si no, dale una duracion generosa.`,
    );
  }
  if (hasDuration) {
    parts.push(renderDuration(record.duration, index));
  } else if (hasDistance) {
    parts.push(renderDistance(record.distance, index));
  } else {
    throw new WorkoutSpecError(
      `Paso ${index}: falta la duración. Añade 'duration' (p. ej. "10m" o 600 segundos), ` +
        `'distance' (p. ej. "400mtr") o "lap_press": true.`,
    );
  }

  const target = renderTarget(record, index);
  if (target) parts.push(target);

  if (record.cadence !== null && record.cadence !== undefined) {
    parts.push(`${rangeText(record.cadence, index, "cadence")}rpm`);
  }

  if (record.intensity !== null && record.intensity !== undefined) {
    const value = String(record.intensity).trim().toLowerCase();
    if (!INTENSITIES.has(value)) {
      throw new WorkoutSpecError(
        `Paso ${index}: 'intensity' debe ser uno de ${[...INTENSITIES].sort().join(", ")}.`,
      );
    }
    parts.push(`intensity=${value}`);
  }

  if (record.rest !== null && record.rest !== undefined) {
    parts.push(`${renderDuration(record.rest, index)} rest`);
  }

  return "- " + parts.join(" ");
}

function renderTarget(step: Step, index: number): string | null {
  const target = step.target;
  if (target !== null && target !== undefined) {
    const text = String(target).split(/\s+/).join(" ").trim();
    if (ABSOLUTE_PACE.test(text)) {
      // El parser exige la palabra 'pace' en ritmos absolutos; sin ella el
      // objetivo se descarta en silencio y el paso queda sin carga.
      return `${text} pace`;
    }
    return text;
  }

  const ramp = step.ramp;
  if (ramp !== null && ramp !== undefined) {
    if (!Array.isArray(ramp) || ramp.length !== 2) {
      throw new WorkoutSpecError(`Paso ${index}: 'ramp' debe ser [inicio, fin], por ejemplo [50, 75].`);
    }
    const low = toNumber(ramp[0], index, "ramp");
    const high = toNumber(ramp[1], index, "ramp");
    return `ramp ${trim(low)}-${trim(high)}%${kindSuffix(step.kind, index)}`;
  }

  if (step.power_pct !== null && step.power_pct !== undefined) {
    return `${rangeText(step.power_pct, index, "power_pct")}%`;
  }
  if (step.watts !== null && step.watts !== undefined) {
    return `${rangeText(step.watts, index, "watts")}w`;
  }
  if (step.hr_pct !== null && step.hr_pct !== undefined) {
    return `${rangeText(step.hr_pct, index, "hr_pct")}% HR`;
  }
  if (step.bpm !== null && step.bpm !== undefined) {
    return `${rangeText(step.bpm, index, "bpm")}bpm`;
  }
  if (step.pace_pct !== null && step.pace_pct !== undefined) {
    return `${rangeText(step.pace_pct, index, "pace_pct")}% pace`;
  }

  const pace = step.pace;
  if (pace !== null && pace !== undefined) {
    const text = String(pace).split(/\s+/).join(" ").trim();
    const withoutPace = text.toLowerCase().endsWith(" pace")
      ? text.slice(0, -5).trim()
      : text.toLowerCase().endsWith("pace")
        ? text.slice(0, -4).trim()
        : text;
    if (!ABSOLUTE_PACE.test(withoutPace)) {
      throw new WorkoutSpecError(
        `Paso ${index}: 'pace' debe ser un ritmo absoluto como "5:00/km", "8:00/mi", ` +
          `"1:45/100m" o "1:40/100y". Para porcentajes del umbral usa 'pace_pct'.`,
      );
    }
    return text.toLowerCase().endsWith("pace") ? text : `${text} pace`;
  }

  const zone = step.zone;
  if (zone !== null && zone !== undefined) {
    const text = String(zone).trim().toUpperCase();
    if (!/^Z\d$/.test(text)) {
      throw new WorkoutSpecError(`Paso ${index}: 'zone' debe ser Z1…Z7 (recibido ${JSON.stringify(zone)}).`);
    }
    return `${text}${kindSuffix(step.zone_kind, index)}`;
  }

  if (step.free) return "free";
  return null;
}

/** Números = segundos; cadenas = sintaxis de intervals.icu (10m, 1h30m, 5:00). */
export function renderDuration(value: unknown, index: number): string {
  if (typeof value === "boolean") {
    throw new WorkoutSpecError(`Paso ${index}: duración no válida (${JSON.stringify(value)}).`);
  }

  const isNumeric = typeof value === "number" || /^\d+$/.test(String(value).trim());
  if (isNumeric) {
    const seconds = Math.round(Number(value));
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new WorkoutSpecError(`Paso ${index}: la duración debe ser mayor que cero.`);
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    let text = "";
    if (hours) text += `${hours}h`;
    if (minutes) text += `${minutes}m`;
    if (secs) text += `${secs}s`;
    return text;
  }

  const text = String(value).trim().replaceAll(" ", "");
  if (text && (CLOCK.test(text) || DURATION_TEXT.test(text))) {
    return text;
  }
  throw new WorkoutSpecError(
    `Paso ${index}: duración ${JSON.stringify(value)} no reconocida. Usa "10m", "1h30m", ` +
      `"5m30s", "45s", "5:00" o un número de segundos.`,
  );
}

/** Números = metros. Ojo: en intervals.icu "400m" son 400 minutos, no metros. */
export function renderDistance(value: unknown, index: number): string {
  if (typeof value === "boolean") {
    throw new WorkoutSpecError(`Paso ${index}: distancia no válida (${JSON.stringify(value)}).`);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new WorkoutSpecError(`Paso ${index}: la distancia debe ser mayor que cero.`);
    }
    return `${trim(value)}mtr`;
  }

  const match = DISTANCE_TEXT.exec(String(value).trim());
  if (!match) {
    throw new WorkoutSpecError(
      `Paso ${index}: distancia ${JSON.stringify(value)} no reconocida. Usa "400mtr", "5km", ` +
        `"3mi", "100yrd" o un número en metros.`,
    );
  }
  const amount = match[1]!.replace(",", ".");
  const unit = match[2]!.toLowerCase();
  const number = trim(parseFloat(amount));
  if (["m", "mtr", "meter", "meters", "metro", "metros"].includes(unit)) return `${number}mtr`;
  if (["km", "k", "kilometro", "kilometros", "kilómetro", "kilómetros"].includes(unit)) return `${number}km`;
  if (["mi", "mile", "miles", "milla", "millas"].includes(unit)) return `${number}mi`;
  if (["yrd", "yd", "yard", "yards", "yarda", "yardas"].includes(unit)) return `${number}yrd`;
  throw new WorkoutSpecError(
    `Paso ${index}: unidad de distancia '${unit}' desconocida. Usa mtr, km, mi o yrd.`,
  );
}

function kindSuffix(kind: unknown, index: number): string {
  if (kind === null || kind === undefined) return "";
  const value = String(kind).trim().toLowerCase();
  if (!KINDS.has(value)) {
    throw new WorkoutSpecError(
      `Paso ${index}: el tipo de objetivo debe ser uno de ${[...KINDS].sort().join(", ")}.`,
    );
  }
  return { power: "", hr: " HR", pace: " pace" }[value as "power" | "hr" | "pace"];
}

function rangeText(value: unknown, index: number, field: string): string {
  if (Array.isArray(value)) {
    if (value.length !== 2) {
      throw new WorkoutSpecError(`Paso ${index}: '${field}' como rango debe ser [min, max].`);
    }
    const low = toNumber(value[0], index, field);
    const high = toNumber(value[1], index, field);
    return `${trim(low)}-${trim(high)}`;
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?-\d+(?:\.\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  return trim(toNumber(value, index, field));
}

function toNumber(value: unknown, index: number, field: string): number {
  if (typeof value === "boolean") {
    throw new WorkoutSpecError(`Paso ${index}: '${field}' debe ser un número.`);
  }
  const num = parseFloat(String(value).trim().replace(",", "."));
  if (!Number.isFinite(num)) {
    throw new WorkoutSpecError(
      `Paso ${index}: '${field}' debe ser un número (recibido ${JSON.stringify(value)}).`,
    );
  }
  return num;
}

function repeatCount(value: unknown, index: number): number {
  const count = parseInt(String(value), 10);
  if (!Number.isFinite(count) || Number.isNaN(count)) {
    throw new WorkoutSpecError(`Paso ${index}: 'repeat' debe ser un entero.`);
  }
  if (count < 1) {
    throw new WorkoutSpecError(`Paso ${index}: 'repeat' debe ser 1 o más.`);
  }
  return count;
}

function trim(value: number): string {
  return String(Number(value.toPrecision(15)));
}
