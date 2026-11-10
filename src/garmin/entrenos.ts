/**
 * Traduce los pasos de un entreno al JSON que acepta Garmin Connect.
 *
 * Por qué existe, habiendo ya `create_workout`: hoy el entreno se escribe en
 * intervals.icu, que lo parsea de un texto y lo reenvía a Garmin. Dos
 * traducciones seguidas, y los pasos llegan al reloj deformados. Esto escribe
 * directamente en Garmin, con la MISMA sintaxis de pasos que ya usa la
 * herramienta de intervals: lo único que cambia es el destino.
 *
 * Los porcentajes (`power_pct`, `hr_pct`, `pace_pct`) sí se convierten, pero
 * solo con los umbrales leídos de Garmin, nunca con uno supuesto: si falta el
 * umbral que hace falta, el paso no se escribe. Un umbral equivocado no da
 * error, escribe un número plausible y falso en el reloj, que es la peor forma
 * de fallar. Cada conversión se anota y viaja hasta la respuesta para poder
 * contrastarla.
 *
 * Qué significa cada porcentaje, con la misma convención que intervals.icu:
 * `power_pct` es % del FTP, `hr_pct` % de la FC de umbral (LTHR) y `pace_pct`
 * % de la VELOCIDAD de umbral —110 % es más rápido, no más lento—.
 *
 * Estructura y claves adaptadas de python-garminconnect (MIT). Ver docs/garmin.md.
 */

import { normalizeSport } from "../intervals/workouts";
import type { Umbrales } from "./umbrales";

export class EntrenoError extends Error {}

/** Deporte de intervals (ya normalizado) → deporte de Garmin. */
const DEPORTES: Record<string, { sportTypeId: number; sportTypeKey: string }> = {
  Run: { sportTypeId: 1, sportTypeKey: "running" },
  VirtualRun: { sportTypeId: 1, sportTypeKey: "running" },
  Ride: { sportTypeId: 2, sportTypeKey: "cycling" },
  VirtualRide: { sportTypeId: 2, sportTypeKey: "cycling" },
  Swim: { sportTypeId: 4, sportTypeKey: "swimming" },
  Walk: { sportTypeId: 17, sportTypeKey: "walking" },
  Hike: { sportTypeId: 18, sportTypeKey: "hiking" },
  WeightTraining: { sportTypeId: 5, sportTypeKey: "strength_training" },
  Rowing: { sportTypeId: 6, sportTypeKey: "cardio_training" },
  Elliptical: { sportTypeId: 6, sportTypeKey: "cardio_training" },
  Yoga: { sportTypeId: 7, sportTypeKey: "yoga" },
  Other: { sportTypeId: 3, sportTypeKey: "other" },
};

/** La clave con la que Garmin nombra un deporte, si lo conoce. */
export function claveDeporteGarmin(deporte: string): string | undefined {
  return DEPORTES[normalizeSport(deporte || "")]?.sportTypeKey;
}

/** `intensity` de la sintaxis → tipo de paso de Garmin. */
const TIPOS_PASO: Record<string, { stepTypeId: number; stepTypeKey: string; displayOrder: number }> =
  {
    warmup: { stepTypeId: 1, stepTypeKey: "warmup", displayOrder: 1 },
    cooldown: { stepTypeId: 2, stepTypeKey: "cooldown", displayOrder: 2 },
    active: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
    rest: { stepTypeId: 5, stepTypeKey: "rest", displayOrder: 5 },
  };
const PASO_POR_DEFECTO = TIPOS_PASO.active!;

const FIN_TIEMPO = { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true };
const FIN_DISTANCIA = {
  conditionTypeId: 3,
  conditionTypeKey: "distance",
  displayOrder: 3,
  displayable: true,
};
const FIN_BOTON = {
  conditionTypeId: 1,
  conditionTypeKey: "lap.button",
  displayOrder: 1,
  displayable: true,
};
const FIN_REPETICIONES = {
  conditionTypeId: 10,
  conditionTypeKey: "reps",
  displayOrder: 10,
  displayable: true,
};
/**
 * El peso de un paso va en KILOGRAMOS, tal cual.
 *
 * El `factor: 1000` de esta unidad es su equivalencia en gramos, no una
 * instrucción para multiplicar. Mandar gramos —como decía la documentación que
 * seguimos al principio— escribe una barra mil veces más pesada: el 16/09/2026
 * se pidieron 8 kg y el reloj enseñó «8,000.0 kg». Ocho toneladas, sin que nada
 * fallara.
 */
const UNIDAD_PESO = { unitId: 8, unitKey: "kilogram", factor: 1000.0 };

const FIN_ITERACIONES = {
  conditionTypeId: 7,
  conditionTypeKey: "iterations",
  displayOrder: 7,
  displayable: false,
};

const SIN_OBJETIVO = { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 };
const OBJ_POTENCIA = { workoutTargetTypeId: 2, workoutTargetTypeKey: "power.zone", displayOrder: 2 };
const OBJ_CADENCIA = { workoutTargetTypeId: 3, workoutTargetTypeKey: "cadence", displayOrder: 3 };
const OBJ_PULSO = { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone", displayOrder: 4 };
const OBJ_RITMO = { workoutTargetTypeId: 6, workoutTargetTypeKey: "pace.zone", displayOrder: 6 };

const RELOJ = /^\d+:\d{2}(?::\d{2})?$/;
const TEXTO_DURACION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i;
const TEXTO_DISTANCIA = /^(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)$/;
const RITMO_ABSOLUTO = /^(\d+):(\d{2})\s*\/\s*(km|mi|100m|100y)$/i;

const METROS: Record<string, number> = {
  m: 1, mtr: 1, meter: 1, meters: 1, metro: 1, metros: 1,
  km: 1000, k: 1000, kilometro: 1000, kilometros: 1000, "kilómetro": 1000, "kilómetros": 1000,
  mi: 1609.344, mile: 1609.344, miles: 1609.344, milla: 1609.344, millas: 1609.344,
  yrd: 0.9144, yd: 0.9144, yard: 0.9144, yards: 0.9144, yarda: 0.9144, yardas: 0.9144,
};

/** Números = segundos. Textos = "10m", "1h30m", "45s", "5:00". */
export function segundos(valor: unknown, paso: number): number {
  if (typeof valor === "boolean" || valor === null || valor === undefined) {
    throw new EntrenoError(`Paso ${paso}: duración no válida (${JSON.stringify(valor)}).`);
  }
  const texto = String(valor).trim().replaceAll(" ", "");
  if (/^\d+$/.test(texto)) {
    const total = Number(texto);
    if (total <= 0) throw new EntrenoError(`Paso ${paso}: la duración debe ser mayor que cero.`);
    return total;
  }
  if (RELOJ.test(texto)) {
    const partes = texto.split(":").map(Number);
    const total =
      partes.length === 3
        ? partes[0]! * 3600 + partes[1]! * 60 + partes[2]!
        : partes[0]! * 60 + partes[1]!;
    if (total <= 0) throw new EntrenoError(`Paso ${paso}: la duración debe ser mayor que cero.`);
    return total;
  }
  const trozos = TEXTO_DURACION.exec(texto);
  if (trozos && texto) {
    const total =
      Number(trozos[1] ?? 0) * 3600 + Number(trozos[2] ?? 0) * 60 + Number(trozos[3] ?? 0);
    if (total > 0) return total;
  }
  throw new EntrenoError(
    `Paso ${paso}: duración ${JSON.stringify(valor)} no reconocida. Usa "10m", "1h30m", ` +
      `"5m30s", "45s", "5:00" o un número de segundos.`,
  );
}

/** Números = metros. Ojo: "400m" aquí son 400 METROS, no 400 minutos. */
export function metros(valor: unknown, paso: number): number {
  if (typeof valor === "boolean" || valor === null || valor === undefined) {
    throw new EntrenoError(`Paso ${paso}: distancia no válida (${JSON.stringify(valor)}).`);
  }
  if (typeof valor === "number") {
    if (!Number.isFinite(valor) || valor <= 0) {
      throw new EntrenoError(`Paso ${paso}: la distancia debe ser mayor que cero.`);
    }
    return valor;
  }
  const trozos = TEXTO_DISTANCIA.exec(String(valor).trim());
  if (!trozos) {
    throw new EntrenoError(
      `Paso ${paso}: distancia ${JSON.stringify(valor)} no reconocida. Usa "400mtr", "5km", ` +
        `"3mi", "100yrd" o un número en metros.`,
    );
  }
  const factor = METROS[trozos[2]!.toLowerCase()];
  if (!factor) {
    throw new EntrenoError(
      `Paso ${paso}: unidad de distancia '${trozos[2]}' desconocida. Usa mtr, km, mi o yrd.`,
    );
  }
  const cantidad = parseFloat(trozos[1]!.replace(",", "."));
  if (!(cantidad > 0)) throw new EntrenoError(`Paso ${paso}: la distancia debe ser mayor que cero.`);
  return Math.round(cantidad * factor * 100) / 100;
}

/** "5:00/km" → metros por segundo, que es lo que entiende Garmin. */
export function metrosPorSegundo(ritmo: string, paso: number): number {
  const trozos = RITMO_ABSOLUTO.exec(ritmo.trim());
  if (!trozos) {
    throw new EntrenoError(
      `Paso ${paso}: ritmo ${JSON.stringify(ritmo)} no reconocido. Usa "5:00/km", "8:00/mi", ` +
        `"1:45/100m" o "1:40/100y".`,
    );
  }
  const seg = Number(trozos[1]) * 60 + Number(trozos[2]);
  const unidad = trozos[3]!.toLowerCase();
  const distancia = unidad === "km" ? 1000 : unidad === "mi" ? 1609.344 : unidad === "100m" ? 100 : 91.44;
  if (seg <= 0) throw new EntrenoError(`Paso ${paso}: el ritmo debe ser mayor que cero.`);
  return Math.round((distancia / seg) * 10000) / 10000;
}

/**
 * Un número o un rango → par ordenado. Acepta [88, 94], 90, "90" y "90-155".
 * Antes se usaba parseFloat, que lee "90-155" como 90 y se calla el resto: el
 * entreno se guardaba con un techo de 90 ppm sin ningún aviso (pendiente #79).
 * Ahora un texto o es un número entero y limpio, o es un rango "a-b", o es un
 * error; nunca medio número.
 */
function rango(valor: unknown, paso: number, campo: string): [number, number] {
  let lista: unknown[];
  if (Array.isArray(valor)) {
    lista = valor;
  } else if (typeof valor === "string" && /^\s*[\d.]+\s*[-–]\s*[\d.]+\s*$/.test(valor)) {
    lista = valor.split(/[-–]/);
  } else {
    lista = [valor, valor];
  }
  if (lista.length !== 2) {
    throw new EntrenoError(`Paso ${paso}: '${campo}' debe ser un número o un rango [min, max].`);
  }
  const numeros = lista.map((v) => {
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (String(v).trim() === "" || !Number.isFinite(n) || n <= 0) {
      throw new EntrenoError(
        `Paso ${paso}: '${campo}' con valor no válido (${JSON.stringify(v)}). ` +
          `Escribe un número (150) o un rango [140, 155].`,
      );
    }
    return n;
  });
  return [Math.min(numeros[0]!, numeros[1]!), Math.max(numeros[0]!, numeros[1]!)];
}

/**
 * Ritmo suelto o rango de ritmos → par de velocidades (m/s) ordenado. Acepta
 * "5:00/km", ["5:05/km", "4:55/km"] y "4:55-5:05/km". Un ritmo suelto es un
 * rango de ±2 % para que el reloj no pite sin parar.
 */
function rangoRitmo(valor: unknown, paso: number): [number, number] {
  const limpiar = (v: unknown) => String(v).replace(/\s*pace\s*$/i, "").trim();
  let partes: string[];
  if (Array.isArray(valor)) {
    if (valor.length !== 2) {
      throw new EntrenoError(`Paso ${paso}: 'pace' como rango lleva dos ritmos ["5:05/km", "4:55/km"].`);
    }
    partes = valor.map(limpiar);
  } else {
    const texto = limpiar(valor);
    const doble = /^(\d+:\d{2})\s*[-–]\s*(\d+:\d{2})(\/.+)$/.exec(texto);
    partes = doble ? [doble[1]! + doble[3]!, doble[2]! + doble[3]!] : [texto];
  }
  if (partes.length === 1) {
    const v = metrosPorSegundo(partes[0]!, paso);
    return [Math.round(v * 0.98 * 10000) / 10000, Math.round(v * 1.02 * 10000) / 10000];
  }
  const a = metrosPorSegundo(partes[0]!, paso);
  const b = metrosPorSegundo(partes[1]!, paso);
  return [Math.min(a, b), Math.max(a, b)];
}

/** Lo que no tiene traducción a Garmin, por mucho umbral que tengamos. */
const SIN_TRADUCCION = ["target", "zone_kind", "kind"];

interface Objetivo {
  targetType: Record<string, unknown>;
  targetValueOne?: number;
  targetValueTwo?: number;
  zoneNumber?: number;
}

/** Qué umbral hace falta para cada porcentaje, y cómo se llama en cristiano. */
const DEL_PORCENTAJE = {
  power_pct: { umbral: "ftp", etiqueta: "FTP", unidad: "W" },
  hr_pct: { umbral: "lthr", etiqueta: "FC de umbral (LTHR)", unidad: "ppm" },
  pace_pct: { umbral: "velocidadUmbral", etiqueta: "velocidad de umbral", unidad: "m/s" },
} as const;

function faltaUmbral(campo: keyof typeof DEL_PORCENTAJE, paso: number): never {
  const { etiqueta } = DEL_PORCENTAJE[campo];
  throw new EntrenoError(
    `Paso ${paso}: '${campo}' necesita tu ${etiqueta}, y Garmin no lo tiene guardado. ` +
      `Míralo con garmin_thresholds. Mientras tanto, escribe el objetivo absoluto ` +
      `('watts', 'bpm' o 'pace'), que no depende de ningún umbral.`,
  );
}

/**
 * Garmin admite UN objetivo por paso, con valores absolutos o un número de
 * zona. Los porcentajes se convierten aquí, y solo con umbrales de Garmin.
 */
function objetivo(
  step: Record<string, unknown>,
  paso: number,
  umbrales: Umbrales | undefined,
  conversiones: string[],
): Objetivo {
  const raro = SIN_TRADUCCION.find((k) => step[k] !== undefined && step[k] !== null);
  if (raro) {
    throw new EntrenoError(
      `Paso ${paso}: '${raro}' es sintaxis de intervals.icu y Garmin no la entiende. Usa ` +
        `'watts', 'bpm', 'pace', 'zone' o sus versiones en porcentaje.`,
    );
  }
  if (step.ramp !== undefined && step.ramp !== null) {
    throw new EntrenoError(
      `Paso ${paso}: Garmin no tiene rampas dentro de un paso. Parte la rampa en varios ` +
        `pasos con su objetivo cada uno, o usa create_workout (intervals.icu), que sí las tiene.`,
    );
  }

  if (step.power_pct !== undefined && step.power_pct !== null) {
    const ftp = umbrales?.ftp;
    if (!ftp) faltaUmbral("power_pct", paso);
    const [bajo, alto] = rango(step.power_pct, paso, "power_pct");
    const uno = Math.round((ftp.valor * bajo) / 100);
    const dos = Math.round((ftp.valor * alto) / 100);
    conversiones.push(
      `paso ${paso}: ${bajo === alto ? `${bajo}` : `${bajo}-${alto}`} % de FTP ${ftp.valor} W ` +
        `→ ${uno === dos ? `${uno}` : `${uno}-${dos}`} W`,
    );
    return { targetType: OBJ_POTENCIA, targetValueOne: uno, targetValueTwo: dos };
  }

  if (step.hr_pct !== undefined && step.hr_pct !== null) {
    const lthr = umbrales?.lthr;
    if (!lthr) faltaUmbral("hr_pct", paso);
    const [bajo, alto] = rango(step.hr_pct, paso, "hr_pct");
    const uno = Math.round((lthr.valor * bajo) / 100);
    const dos = Math.round((lthr.valor * alto) / 100);
    conversiones.push(
      `paso ${paso}: ${bajo === alto ? `${bajo}` : `${bajo}-${alto}`} % de LTHR ${lthr.valor} ppm ` +
        `→ ${uno === dos ? `${uno}` : `${uno}-${dos}`} ppm`,
    );
    return { targetType: OBJ_PULSO, targetValueOne: uno, targetValueTwo: dos };
  }

  if (step.pace_pct !== undefined && step.pace_pct !== null) {
    const umbral = umbrales?.velocidadUmbral;
    if (!umbral) faltaUmbral("pace_pct", paso);
    const [bajo, alto] = rango(step.pace_pct, paso, "pace_pct");
    const uno = Math.round(((umbral.valor * bajo) / 100) * 10000) / 10000;
    const dos = Math.round(((umbral.valor * alto) / 100) * 10000) / 10000;
    conversiones.push(
      `paso ${paso}: ${bajo === alto ? `${bajo}` : `${bajo}-${alto}`} % de la velocidad de ` +
        `umbral ${umbral.valor.toFixed(3)} m/s → ${ritmoLegible(uno)}` +
        `${uno === dos ? "" : `–${ritmoLegible(dos)}`} (más % es más rápido)`,
    );
    return { targetType: OBJ_RITMO, targetValueOne: uno, targetValueTwo: dos };
  }

  if (step.watts !== undefined && step.watts !== null) {
    const [bajo, alto] = rango(step.watts, paso, "watts");
    return { targetType: OBJ_POTENCIA, targetValueOne: bajo, targetValueTwo: alto };
  }
  if (step.bpm !== undefined && step.bpm !== null) {
    const [bajo, alto] = rango(step.bpm, paso, "bpm");
    return { targetType: OBJ_PULSO, targetValueOne: bajo, targetValueTwo: alto };
  }
  if (step.pace !== undefined && step.pace !== null) {
    // Garmin guarda el objetivo de ritmo como VELOCIDAD (m/s).
    const [uno, dos] = rangoRitmo(step.pace, paso);
    return { targetType: OBJ_RITMO, targetValueOne: uno, targetValueTwo: dos };
  }
  if (step.zone !== undefined && step.zone !== null) {
    const texto = String(step.zone).trim().toUpperCase();
    if (!/^Z[1-5]$/.test(texto)) {
      throw new EntrenoError(
        `Paso ${paso}: Garmin solo tiene zonas Z1…Z5 (recibido ${JSON.stringify(step.zone)}).`,
      );
    }
    return { targetType: OBJ_PULSO, zoneNumber: Number(texto[1]) };
  }
  if (step.cadence !== undefined && step.cadence !== null) {
    const [bajo, alto] = rango(step.cadence, paso, "cadence");
    return { targetType: OBJ_CADENCIA, targetValueOne: bajo, targetValueTwo: alto };
  }
  return { targetType: SIN_OBJETIVO };
}

/** m/s → "4:30/km", para que la conversión se pueda leer de un vistazo. */
function ritmoLegible(metrosPorSegundo: number): string {
  if (!(metrosPorSegundo > 0)) return "—";
  const segundosPorKm = 1000 / metrosPorSegundo;
  const min = Math.floor(segundosPorKm / 60);
  const seg = Math.round(segundosPorKm % 60);
  return `${min}:${String(seg).padStart(2, "0")}/km`;
}

interface Contador {
  orden: number;
  segundos: number;
  umbrales: Umbrales | undefined;
  /** Cada porcentaje traducido, tal y como se contará en la respuesta. */
  conversiones: string[];
}

function pasoEjecutable(
  bruto: unknown,
  contador: Contador,
): Record<string, unknown> {
  const paso = contador.orden;
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) {
    throw new EntrenoError(`Paso ${paso}: cada paso es un objeto, no ${JSON.stringify(bruto)}.`);
  }
  const step = bruto as Record<string, unknown>;

  const tieneDuracion = step.duration !== undefined && step.duration !== null;
  const tieneDistancia = step.distance !== undefined && step.distance !== null;
  if (tieneDuracion && tieneDistancia) {
    throw new EntrenoError(`Paso ${paso}: usa 'duration' o 'distance', no las dos.`);
  }

  // Un paso de fuerza: repeticiones, ejercicio del catálogo de Garmin y peso.
  // Sin `category`, el reloj enseña un nombre genérico por mucho que la
  // etiqueta sea buena: ese nombre sale del catálogo, no del texto.
  const fuerza = ejercicioDe(step, paso);

  let fin: Record<string, unknown>;
  let valorFin: number | undefined;
  if (fuerza?.repeticiones !== undefined) {
    fin = FIN_REPETICIONES;
    valorFin = fuerza.repeticiones;
  } else if (step.lap_press) {
    fin = FIN_BOTON;
  } else if (tieneDuracion) {
    fin = FIN_TIEMPO;
    valorFin = segundos(step.duration, paso);
    contador.segundos += valorFin;
  } else if (tieneDistancia) {
    fin = FIN_DISTANCIA;
    valorFin = metros(step.distance, paso);
  } else {
    throw new EntrenoError(
      `Paso ${paso}: falta la duración. Añade 'duration', 'distance' o "lap_press": true.`,
    );
  }

  const intensidad = String(step.intensity ?? "").trim().toLowerCase();
  if (intensidad && !TIPOS_PASO[intensidad]) {
    throw new EntrenoError(
      `Paso ${paso}: 'intensity' debe ser warmup, active, rest o cooldown (recibido ` +
        `${JSON.stringify(step.intensity)}).`,
    );
  }

  const etiqueta = String(step.label ?? step.text ?? "").split(/\s+/).join(" ").trim();
  const obj = objetivo(step, paso, contador.umbrales, contador.conversiones);
  // La cadencia cabe como objetivo solo si no hay otro: Garmin admite uno por
  // paso. Si hay los dos, la cadencia se escribe en el nombre del paso, que es
  // lo que se lee en el reloj, en vez de perderse sin avisar.
  const cadenciaAparte =
    step.cadence !== undefined &&
    step.cadence !== null &&
    obj.targetType !== OBJ_CADENCIA
      ? `${rango(step.cadence, paso, "cadence").join("-").replace(/^(\d+)-\1$/, "$1")} rpm`
      : "";
  const descripcion = [etiqueta, cadenciaAparte].filter(Boolean).join(" · ");

  contador.orden += 1;
  return {
    type: "ExecutableStepDTO",
    stepOrder: paso,
    stepType: TIPOS_PASO[intensidad] ?? PASO_POR_DEFECTO,
    endCondition: fin,
    ...(valorFin === undefined ? {} : { endConditionValue: valorFin }),
    ...obj,
    ...(fuerza?.campos ?? {}),
    ...(descripcion ? { description: descripcion } : {}),
  };
}

/**
 * La parte de fuerza de un paso: el ejercicio del catálogo de Garmin, las
 * repeticiones y el peso. Devuelve null si el paso no es de fuerza.
 */
function ejercicioDe(
  step: Record<string, unknown>,
  paso: number,
): { campos: Record<string, unknown>; repeticiones?: number } | null {
  const categoria = String(step.category ?? "").trim().toUpperCase();
  const ejercicio = String(step.exercise ?? "").trim().toUpperCase();
  const tieneReps = step.reps !== undefined && step.reps !== null;
  const tienePeso = step.weight_kg !== undefined && step.weight_kg !== null;
  if (!categoria && !ejercicio && !tieneReps && !tienePeso) return null;

  if (ejercicio && !categoria) {
    throw new EntrenoError(
      `Paso ${paso}: 'exercise' necesita también 'category'. Los dos son enums del catálogo ` +
        `de Garmin y salen de garmin_activity, en la columna «enum de Garmin» de una sesión ` +
        `de fuerza que ya hayas hecho.`,
    );
  }

  const campos: Record<string, unknown> = {};
  if (categoria) campos.category = categoria;
  if (ejercicio) campos.exerciseName = ejercicio;

  let repeticiones: number | undefined;
  if (tieneReps) {
    const valor = Number(step.reps);
    if (!Number.isSafeInteger(valor) || valor < 1) {
      throw new EntrenoError(
        `Paso ${paso}: 'reps' debe ser un número entero de repeticiones (recibido ` +
          `${JSON.stringify(step.reps)}).`,
      );
    }
    repeticiones = valor;
  }

  if (tienePeso) {
    const kilos = Number(step.weight_kg);
    if (!Number.isFinite(kilos) || kilos <= 0) {
      throw new EntrenoError(
        `Paso ${paso}: 'weight_kg' debe ser un peso en kilos mayor que cero (recibido ` +
          `${JSON.stringify(step.weight_kg)}).`,
      );
    }
    campos.weightValue = Math.round(kilos * 100) / 100;
    campos.weightUnit = UNIDAD_PESO;
  }

  return { campos, ...(repeticiones === undefined ? {} : { repeticiones }) };
}

function grupo(bruto: Record<string, unknown>, contador: Contador): Record<string, unknown> {
  const paso = contador.orden;
  const repeticiones = Number(bruto.repeat);
  if (!Number.isSafeInteger(repeticiones) || repeticiones < 1) {
    throw new EntrenoError(
      `Paso ${paso}: 'repeat' debe ser un número entero de repeticiones (recibido ` +
        `${JSON.stringify(bruto.repeat)}).`,
    );
  }
  const dentro = bruto.steps;
  if (!Array.isArray(dentro) || dentro.length === 0) {
    throw new EntrenoError(`Paso ${paso}: 'repeat' necesita los 'steps' que se repiten.`);
  }
  contador.orden += 1;
  const antes = contador.segundos;
  const hijos = dentro.map((hijo) => traducirPaso(hijo, contador));
  // Lo que dura el bloque se repite tantas veces como diga el grupo.
  contador.segundos = antes + (contador.segundos - antes) * repeticiones;
  return {
    type: "RepeatGroupDTO",
    stepOrder: paso,
    stepType: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
    numberOfIterations: repeticiones,
    smartRepeat: false,
    endCondition: FIN_ITERACIONES,
    endConditionValue: repeticiones,
    workoutSteps: hijos,
  };
}

function traducirPaso(bruto: unknown, contador: Contador): Record<string, unknown> {
  if (bruto && typeof bruto === "object" && !Array.isArray(bruto)) {
    const step = bruto as Record<string, unknown>;
    if (step.repeat !== undefined && step.repeat !== null) return grupo(step, contador);
    if (Array.isArray(step.steps)) {
      // Un bloque sin repeticiones: en Garmin no hay «secciones», así que sus
      // pasos se aplanan. El nombre de la sección se pierde, y da igual: lo que
      // se lee en el reloj es el nombre de cada paso.
      throw new EntrenoError(
        `Paso ${contador.orden}: un bloque con 'steps' pero sin 'repeat' no existe en Garmin. ` +
          `Saca sus pasos al nivel de arriba, o añade "repeat": n.`,
      );
    }
  }
  return pasoEjecutable(bruto, contador);
}

export interface EntradaEntreno {
  nombre: string;
  deporte: string;
  pasos: unknown[];
  descripcion?: string | null;
  /** Leídos de Garmin. Sin ellos, los porcentajes se rechazan. */
  umbrales?: Umbrales;
}

export interface EntrenoConstruido {
  entreno: EntrenoGarmin;
  /** Una línea por porcentaje traducido; vacío si no había ninguno. */
  conversiones: string[];
}

export interface EntrenoGarmin {
  workoutName: string;
  sportType: Record<string, unknown>;
  estimatedDurationInSecs: number;
  workoutSegments: Array<Record<string, unknown>>;
  description?: string;
}

/** Pasos → entreno listo para POST /workout-service/workout. */
export function construirEntreno(entrada: EntradaEntreno): EntrenoConstruido {
  const nombre = (entrada.nombre || "").trim();
  if (!nombre) throw new EntrenoError("El entreno necesita un nombre: es lo que verás en el reloj.");

  const normalizado = normalizeSport(entrada.deporte || "");
  const deporte = DEPORTES[normalizado];
  if (!deporte) {
    throw new EntrenoError(
      `Deporte '${entrada.deporte}' no soportado en Garmin. Usa: ` +
        `${Object.keys(DEPORTES).sort().join(", ")}.`,
    );
  }

  if (!Array.isArray(entrada.pasos) || entrada.pasos.length === 0) {
    throw new EntrenoError("El entreno necesita al menos un paso.");
  }

  const contador: Contador = {
    orden: 1,
    segundos: 0,
    umbrales: entrada.umbrales,
    conversiones: [],
  };
  const pasos = entrada.pasos.map((paso) => traducirPaso(paso, contador));

  const descripcion = (entrada.descripcion || "").trim();
  const entreno: EntrenoGarmin = {
    workoutName: nombre.slice(0, 80),
    sportType: { ...deporte, displayOrder: deporte.sportTypeId },
    estimatedDurationInSecs: Math.round(contador.segundos),
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: { ...deporte, displayOrder: deporte.sportTypeId },
        workoutSteps: pasos,
      },
    ],
    ...(descripcion ? { description: descripcion.slice(0, 1024) } : {}),
  };
  return { entreno, conversiones: contador.conversiones };
}

// ------------------------------------------------- leer lo que ya está escrito

/** Cuántos bloques, cuántos pasos y cuántos se ejecutan de verdad. */
export interface Recuento {
  /** Entradas del primer nivel: lo que se ve plegado. */
  bloques: number;
  /** Pasos escritos, contando los de dentro de las series una sola vez. */
  pasos: number;
  /** Pasos que ejecuta el reloj, con las repeticiones desplegadas. */
  desplegados: number;
}

export function contarPasos(pasos: unknown[]): Recuento {
  let escritos = 0;
  let desplegados = 0;
  const recorrer = (lista: unknown[], veces: number): void => {
    for (const bruto of lista) {
      const paso = (bruto ?? {}) as Record<string, unknown>;
      const hijos = paso.workoutSteps ?? paso.steps;
      if (Array.isArray(hijos)) {
        const repeticiones = Number(paso.numberOfIterations ?? paso.repeat ?? 1) || 1;
        recorrer(hijos, veces * repeticiones);
        continue;
      }
      escritos += 1;
      desplegados += veces;
    }
  };
  recorrer(pasos, 1);
  return { bloques: pasos.length, pasos: escritos, desplegados };
}

const TIPO_LEGIBLE: Record<string, string> = {
  warmup: "calentamiento",
  cooldown: "vuelta a la calma",
  interval: "serie",
  recovery: "recuperación",
  rest: "descanso",
  repeat: "repetir",
  other: "otro",
  main: "principal",
};

function leerFin(paso: Record<string, unknown>): string {
  const clave = String(
    (paso.endCondition as Record<string, unknown> | undefined)?.conditionTypeKey ?? "",
  );
  const valor = Number(paso.endConditionValue);
  if (clave === "time" && Number.isFinite(valor)) {
    const min = Math.floor(valor / 60);
    const seg = Math.round(valor % 60);
    return min ? `${min}:${String(seg).padStart(2, "0")}` : `${seg} s`;
  }
  if (clave === "distance" && Number.isFinite(valor)) {
    return valor >= 1000 ? `${(valor / 1000).toFixed(2)} km` : `${Math.round(valor)} m`;
  }
  if (clave === "lap.button") return "botón de vuelta";
  if (clave === "iterations" && Number.isFinite(valor)) return `×${valor}`;
  if (clave === "reps" && Number.isFinite(valor)) return `${valor} reps`;
  return clave || "—";
}

function leerObjetivo(paso: Record<string, unknown>): string {
  const clave = String(
    (paso.targetType as Record<string, unknown> | undefined)?.workoutTargetTypeKey ?? "",
  );
  const zona = Number(paso.zoneNumber);
  if (Number.isFinite(zona) && zona > 0) return `zona ${zona}`;
  const uno = Number(paso.targetValueOne);
  const dos = Number(paso.targetValueTwo);
  const rango = (sufijo: string, decimales = 0): string =>
    !Number.isFinite(uno)
      ? "—"
      : uno === dos
        ? `${uno.toFixed(decimales)}${sufijo}`
        : `${uno.toFixed(decimales)}–${dos.toFixed(decimales)}${sufijo}`;

  switch (clave) {
    case "power.zone":
      return rango(" W");
    case "heart.rate.zone":
      return rango(" ppm");
    case "cadence":
      return rango(" rpm");
    case "pace.zone":
      // Se guardó como velocidad: se devuelve a ritmo, que es como se prescribe.
      return Number.isFinite(uno)
        ? `${ritmoLegible(dos || uno)}–${ritmoLegible(uno)}`
        : "—";
    case "no.target":
      return "sin objetivo";
    default:
      return clave || "—";
  }
}

/**
 * El entreno tal y como Garmin lo tiene guardado, paso a paso.
 *
 * Sirve para comprobar lo que no se puede comprobar de otra manera: que las
 * etiquetas llegaron enteras y que ningún paso se perdió por el camino. Un paso
 * descartado en silencio no cambia la duración si acababa con el botón de
 * vuelta, así que mirar los minutos no basta: hay que contar los pasos.
 */
export function describirEntreno(bruto: unknown): string {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) {
    throw new EntrenoError("Garmin no devolvió un entreno legible.");
  }
  const entreno = bruto as Record<string, unknown>;
  const segmentos = Array.isArray(entreno.workoutSegments) ? entreno.workoutSegments : [];
  const pasos = segmentos.flatMap((segmento) => {
    const s = (segmento ?? {}) as Record<string, unknown>;
    return Array.isArray(s.workoutSteps) ? s.workoutSteps : [];
  });
  const recuento = contarPasos(pasos);

  const lineas: string[] = [];
  const deporte = String(
    (entreno.sportType as Record<string, unknown> | undefined)?.sportTypeKey ?? "—",
  );
  const estimados = Number(entreno.estimatedDurationInSecs);
  lineas.push(
    `«${String(entreno.workoutName ?? "(sin nombre)")}» · ${deporte} · id ${
      entreno.workoutId ?? "—"
    }`,
    `${recuento.bloques} bloques · ${recuento.pasos} pasos escritos · ` +
      `${recuento.desplegados} pasos en el reloj` +
      (Number.isFinite(estimados) && estimados > 0
        ? ` · ${Math.round(estimados / 60)} min estimados`
        : ""),
    "",
  );

  let orden = 0;
  const pintar = (lista: unknown[], sangria: string): void => {
    for (const crudo of lista) {
      const paso = (crudo ?? {}) as Record<string, unknown>;
      orden += 1;
      const tipo = String(
        (paso.stepType as Record<string, unknown> | undefined)?.stepTypeKey ?? "?",
      );
      const hijos = paso.workoutSteps;
      if (Array.isArray(hijos)) {
        lineas.push(
          `${String(orden).padStart(3)} ${sangria}repetir ${leerFin(paso)}`,
        );
        pintar(hijos, `${sangria}  `);
        continue;
      }
      const etiqueta = String(paso.description ?? "").trim();
      const ejercicio = [paso.category, paso.exerciseName]
        .map((v) => String(v ?? "").trim())
        .filter(Boolean)
        .join(" / ");
      const peso = Number(paso.weightValue);
      lineas.push(
        `${String(orden).padStart(3)} ${sangria}${(TIPO_LEGIBLE[tipo] ?? tipo).padEnd(17)}` +
          `${leerFin(paso).padStart(12)}  ${leerObjetivo(paso).padEnd(20)}` +
          (etiqueta ? ` «${etiqueta}»` : " (sin etiqueta)") +
          (ejercicio ? ` [${ejercicio}]` : "") +
          (Number.isFinite(peso) && peso > 0 ? ` ${peso} kg` : ""),
      );
    }
  };
  pintar(pasos, "");

  const avisos: string[] = [];
  if (lineas.some((l) => l.includes("(sin etiqueta)"))) {
    avisos.push(
      "«(sin etiqueta)»: ese paso llegará al reloj con el nombre genérico de Garmin.",
    );
  }
  const esFuerza = deporte === "strength_training";
  if (esFuerza && !lineas.some((l) => l.includes("["))) {
    avisos.push(
      "Ningún paso lleva ejercicio del catálogo de Garmin (no hay [CATEGORÍA / EJERCICIO]): en " +
        "fuerza, el nombre del paso sale de ahí y no de la etiqueta, y sin él el reloj enseña " +
        "«--». La etiqueta se ve, pero debajo. Para que se lea el ejercicio, pasa 'category' y " +
        "'exercise' al crearlo.",
    );
  }
  if (avisos.length) lineas.push("", ...avisos);
  return lineas.join("\n");
}
