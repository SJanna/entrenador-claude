/**
 * Los umbrales del atleta.
 *
 * Existen para que un `hr_pct: 85` pueda convertirse en pulsaciones sin que
 * nadie se invente el umbral. La regla de la casa sigue siendo la misma:
 * preferimos no escribir el paso a escribirlo con un número plausible y falso.
 *
 * QUIÉN MANDA: Garmin. Es el origen de los datos del atleta —intervals.icu los
 * recibe de ahí, no al revés—, así que es donde antes está lo último. intervals
 * queda de respaldo: sirve cuando Garmin no expone ese umbral, y su valor se
 * sigue leyendo siempre para poder comparar.
 *
 * CUANDO NO COINCIDEN NO SE ELIGE EN SILENCIO. Los dos números se leen, se usa
 * el de Garmin y la diferencia se dice con un ⚠. Esto importa porque intervals
 * NO se limita a copiar a Garmin: un umbral editado a mano ahí después de un
 * test se queda solo ahí. Si intervals dice 193 y Garmin 190, ese 193 lo
 * escribió alguien; el aviso está para que se cuadren los dos en Garmin
 * Connect, que es de donde sale el número que acaba en el reloj.
 *
 * Dos cautelas más, para la parte de Garmin:
 *
 * - **No conocemos la estructura exacta de las respuestas de Garmin**, y no hay
 *   documentación que consultar. Así que no se navega por rutas fijas: se busca
 *   la clave por nombre en todo el árbol y se acepta el primer número que
 *   además sea PLAUSIBLE. Un FTP de 4 vatios o una FC umbral de 12 ppm no son
 *   el dato que buscábamos, sean cuales sean sus claves.
 * - **Se dice siempre de dónde salió cada número.** La herramienta lo escribe en
 *   su respuesta para que se pueda contrastar con Garmin Connect de un vistazo.
 */

import type { GarminCliente } from "./cliente";
import { addDays } from "../dates";

export interface Umbral {
  valor: number;
  /** De dónde sale el valor que se usa, para poder contrastarlo. */
  fuente: string;
  /** Lo que dice la otra fuente, cuando no coincide con el valor elegido. */
  discrepa?: number;
}

/** Los umbrales de un deporte en intervals.icu, que hacen de respaldo. */
export interface UmbralesIntervals {
  lthr?: number;
  fcMax?: number;
  ftp?: number;
  velocidadUmbral?: number;
}

export interface Umbrales {
  /** Frecuencia cardiaca de umbral (LTHR), en ppm. */
  lthr?: Umbral;
  /** Frecuencia cardiaca máxima, en ppm. */
  fcMax?: Umbral;
  /** Functional Threshold Power, en vatios. */
  ftp?: Umbral;
  /** Velocidad de umbral, en metros por segundo. */
  velocidadUmbral?: Umbral;
  /** Las zonas de FC de Garmin, si su respuesta trae algo reconocible. */
  zonas?: ZonasFc;
  /** Los nombres de las claves que trajo la respuesta de zonas, para diagnóstico. */
  clavesZonas?: string[];
  /** Lo que no se pudo leer, con su motivo. */
  fallos: string[];
}

/** Las zonas de frecuencia cardiaca tal como las publica Garmin. */
export interface ZonasFc {
  /** Para qué deporte son, tal como lo nombra Garmin. */
  deporte: string | null;
  /** Suelo de cada zona en ppm, de la 1 en adelante. */
  suelos: number[];
  /** La FC máxima con la que Garmin las calculó, si la dice. */
  maxUsada?: number;
}

/** Rangos de cordura: fuera de aquí, el número no es lo que dice ser. */
const PLAUSIBLE = {
  lthr: [90, 220],
  fcMax: [120, 230],
  ftp: [40, 700],
  // 1 m/s ≈ 16:40/km (caminando); 8 m/s ≈ 2:05/km (récord del mundo).
  velocidadUmbral: [1, 8],
} as const;

/** Un suelo de zona fuera de esto no es una pulsación por minuto. */
const RANGO_ZONA: readonly [number, number] = [40, 230];

const CLAVES: Record<keyof typeof PLAUSIBLE, string[]> = {
  lthr: ["lactateThresholdHeartRate", "lactatethresholdheartrate", "thresholdHeartRate"],
  // `maxHeartRateUsed` es la que Garmin usa para calcular las zonas: la tiene
  // aunque el perfil no traiga ninguna de las otras.
  fcMax: ["maxHeartRate", "maxhr", "userMaxHeartRate", "maxHeartRateUsed"],
  ftp: ["functionalThresholdPower", "ftp", "cyclingFtp"],
  velocidadUmbral: ["lactateThresholdSpeed", "thresholdSpeed", "lactateThresholdSpeedInMetersPerSecond"],
};

/**
 * Busca una clave por nombre en todo el árbol y devuelve el primer número
 * plausible. Recorre en anchura: los valores de arriba —los que Garmin pone en
 * la raíz— pesan más que los de un histórico anidado.
 */
export function buscarNumero(raiz: unknown, claves: string[], rango: readonly [number, number]): number | null {
  const nombres = new Set(claves.map((c) => c.toLowerCase()));
  const cola: unknown[] = [raiz];
  let vueltas = 0;
  while (cola.length && vueltas < 10_000) {
    vueltas += 1;
    const nodo = cola.shift();
    if (!nodo || typeof nodo !== "object") continue;
    if (Array.isArray(nodo)) {
      cola.push(...nodo);
      continue;
    }
    for (const [clave, valor] of Object.entries(nodo as Record<string, unknown>)) {
      if (nombres.has(clave.toLowerCase())) {
        const n = typeof valor === "number" ? valor : Number(valor);
        if (Number.isFinite(n) && n >= rango[0] && n <= rango[1]) return n;
      }
      if (valor && typeof valor === "object") cola.push(valor);
    }
  }
  return null;
}

/**
 * Las zonas de FC que haya en la respuesta de Garmin.
 *
 * Mismo criterio que con los umbrales: no se navega por una ruta fija, se
 * reconocen las claves `zoneNFloor` esté donde estén. Y se exige que el
 * conjunto tenga sentido —al menos tres zonas, en ppm creíbles y de menor a
 * mayor—, porque unas zonas medio leídas se enseñan igual de convincentes que
 * unas buenas.
 */
export function zonasFcDeGarmin(raiz: unknown): ZonasFc[] {
  const encontradas: ZonasFc[] = [];
  const cola: unknown[] = [raiz];
  let vueltas = 0;
  while (cola.length && vueltas < 10_000) {
    vueltas += 1;
    const nodo = cola.shift();
    if (!nodo || typeof nodo !== "object") continue;
    if (Array.isArray(nodo)) {
      cola.push(...nodo);
      continue;
    }
    const campos = nodo as Record<string, unknown>;
    const suelos = new Map<number, number>();
    let maxUsada: number | undefined;
    let deporte: string | null = null;
    for (const [clave, valor] of Object.entries(campos)) {
      const zona = /^zone([1-9])floor$/.exec(clave.toLowerCase());
      if (zona) {
        const n = typeof valor === "number" ? valor : Number(valor);
        if (Number.isFinite(n) && n >= RANGO_ZONA[0] && n <= RANGO_ZONA[1]) {
          suelos.set(Number(zona[1]), n);
        }
      }
      if (clave.toLowerCase() === "maxheartrateused") {
        const n = typeof valor === "number" ? valor : Number(valor);
        if (Number.isFinite(n) && n >= PLAUSIBLE.fcMax[0] && n <= PLAUSIBLE.fcMax[1]) maxUsada = n;
      }
      if (clave.toLowerCase() === "sport" && typeof valor === "string" && valor.trim()) {
        deporte = valor.trim();
      }
      if (valor && typeof valor === "object") cola.push(valor);
    }
    const ordenadas = [...suelos.entries()].sort((a, b) => a[0] - b[0]);
    const valores = ordenadas.map(([, v]) => v);
    const consecutivas = ordenadas.every(([n], i) => n === i + 1);
    const crecientes = valores.every((v, i) => i === 0 || v > valores[i - 1]!);
    if (valores.length >= 3 && consecutivas && crecientes) {
      encontradas.push({ deporte, suelos: valores, ...(maxUsada ? { maxUsada } : {}) });
    }
  }
  return encontradas;
}

/**
 * De todas las zonas que trae Garmin, las del deporte que se pidió. Si no están
 * las de ese deporte se usan las genéricas, y se dice a quién pertenecen: unas
 * zonas de ciclismo enseñadas como de carrera son otro número plausible y falso.
 */
export function elegirZonas(zonas: ZonasFc[], deporteGarmin: string | undefined): ZonasFc | undefined {
  if (!zonas.length) return undefined;
  const buscado = deporteGarmin?.trim().toLowerCase();
  if (buscado) {
    const suyas = zonas.find((z) => z.deporte?.trim().toLowerCase() === buscado);
    if (suyas) return suyas;
  }
  return zonas.find((z) => (z.deporte ?? "").trim().toLowerCase() === "default") ?? zonas[0];
}

/** Los nombres de las claves de un objeto, para poder mirar qué trae Garmin. */
export function nombresDeClaves(raiz: unknown, tope = 40): string[] {
  const nombres = new Set<string>();
  const cola: unknown[] = [raiz];
  let vueltas = 0;
  while (cola.length && vueltas < 1_000 && nombres.size < tope) {
    vueltas += 1;
    const nodo = cola.shift();
    if (!nodo || typeof nodo !== "object") continue;
    if (Array.isArray(nodo)) {
      cola.push(...nodo);
      continue;
    }
    for (const [clave, valor] of Object.entries(nodo as Record<string, unknown>)) {
      nombres.add(clave);
      if (valor && typeof valor === "object") cola.push(valor);
    }
  }
  return [...nombres];
}

/** Una lectura que no debe tumbar a las demás: si falla, se apunta y se sigue. */
async function leer(
  cliente: GarminCliente,
  ruta: string,
  nombre: string,
  fallos: string[],
): Promise<unknown> {
  try {
    const respuesta = await cliente.api(ruta);
    if (respuesta.status === 204 || respuesta.status === 404) {
      await respuesta.body?.cancel();
      return null;
    }
    const texto = await respuesta.text();
    if (!respuesta.ok) {
      fallos.push(`${nombre} (${respuesta.status})`);
      return null;
    }
    return texto.trim() ? JSON.parse(texto) : null;
  } catch (exc) {
    fallos.push(`${nombre} (${exc instanceof Error ? exc.message : String(exc)})`);
    return null;
  }
}

/**
 * Saca de los ajustes por deporte de intervals.icu los umbrales del deporte que
 * toca. El LTHR de correr no es el de la bici: coger el del deporte equivocado
 * es otra forma de escribir un número plausible y falso.
 */
export function umbralesDeIntervals(
  ajustes: Array<Record<string, unknown>>,
  deporte: string,
): UmbralesIntervals {
  const buscado = deporte.trim().toLowerCase();
  const encaja = (ajuste: Record<string, unknown>): boolean => {
    const tipos = Array.isArray(ajuste.types) ? ajuste.types : [];
    return tipos.some((t) => String(t).trim().toLowerCase() === buscado);
  };
  const elegido = ajustes.find(encaja);
  if (!elegido) return {};

  const numero = (valor: unknown, rango: readonly [number, number]): number | undefined => {
    const n = typeof valor === "number" ? valor : Number(valor);
    return Number.isFinite(n) && n >= rango[0] && n <= rango[1] ? n : undefined;
  };
  return {
    lthr: numero(elegido.lthr, PLAUSIBLE.lthr),
    fcMax: numero(elegido.max_hr, PLAUSIBLE.fcMax),
    ftp: numero(elegido.ftp ?? elegido.indoor_ftp, PLAUSIBLE.ftp),
    velocidadUmbral: numero(elegido.threshold_pace, PLAUSIBLE.velocidadUmbral),
  };
}

/**
 * Lee los umbrales. Manda Garmin; intervals.icu es respaldo y, cuando difiere,
 * queda anotado para que la herramienta pueda decirlo.
 */
export async function leerUmbrales(
  cliente: GarminCliente,
  hoy: string,
  respaldo: UmbralesIntervals = {},
  deporteGarmin?: string,
): Promise<Umbrales> {
  const fallos: string[] = [];
  const desde = addDays(hoy, -365);
  const stats = (metrica: string, deporte: string) =>
    `/biometric-service/stats/${metrica}/range/${desde}/${hoy}` +
    `?sport=${deporte}&aggregation=daily&aggregationStrategy=LATEST`;

  const [ajustes, zonasFc, lthrStats, ftpStats, velocidadStats] = await Promise.all([
    leer(cliente, "/userprofile-service/userprofile/user-settings", "ajustes del perfil", fallos),
    leer(cliente, "/biometric-service/heartRateZones", "zonas de frecuencia cardiaca", fallos),
    leer(cliente, stats("lactateThresholdHeartRate", "RUNNING"), "FC de umbral", fallos),
    leer(cliente, stats("functionalThresholdPower", "CYCLING"), "FTP", fallos),
    leer(cliente, stats("lactateThresholdSpeed", "RUNNING"), "velocidad de umbral", fallos),
  ]);

  const fuentes: Array<[string, unknown]> = [
    ["ajustes del perfil", ajustes],
    ["zonas de FC", zonasFc],
    ["histórico de FC de umbral", lthrStats],
    ["histórico de FTP", ftpStats],
    ["histórico de velocidad de umbral", velocidadStats],
  ];

  const buscar = (cual: keyof typeof PLAUSIBLE): Umbral | undefined => {
    let deGarmin: { valor: number; fuente: string } | undefined;
    for (const [nombre, datos] of fuentes) {
      if (datos === null) continue;
      const valor = buscarNumero(datos, CLAVES[cual], PLAUSIBLE[cual]);
      if (valor !== null) {
        deGarmin = { valor, fuente: nombre };
        break;
      }
    }

    const deIntervals = respaldo[cual];
    if (deGarmin) {
      // Garmin manda. Si intervals dice otra cosa, se anota para decirlo.
      return {
        valor: deGarmin.valor,
        fuente: `Garmin · ${deGarmin.fuente}`,
        ...(deIntervals !== undefined && deIntervals !== deGarmin.valor
          ? { discrepa: deIntervals }
          : {}),
      };
    }
    // Garmin no lo tiene: se usa el de intervals antes que quedarse sin nada.
    return deIntervals !== undefined
      ? { valor: deIntervals, fuente: "intervals.icu" }
      : undefined;
  };

  const zonas = elegirZonas(zonasFcDeGarmin(zonasFc), deporteGarmin);
  return {
    lthr: buscar("lthr"),
    fcMax: buscar("fcMax"),
    ftp: buscar("ftp"),
    velocidadUmbral: buscar("velocidadUmbral"),
    ...(zonas ? { zonas } : {}),
    clavesZonas: nombresDeClaves(zonasFc),
    fallos,
  };
}

/** Los umbrales en los que Garmin e intervals.icu no coinciden. */
export function discrepantes(umbrales: Umbrales): string[] {
  const nombres: Array<[keyof Umbrales, string]> = [
    ["lthr", "LTHR"],
    ["fcMax", "FC máxima"],
    ["ftp", "FTP"],
    ["velocidadUmbral", "ritmo de umbral"],
  ];
  return nombres
    .filter(([clave]) => (umbrales[clave] as Umbral | undefined)?.discrepa !== undefined)
    .map(([clave, etiqueta]) => {
      const umbral = umbrales[clave] as Umbral;
      return `${etiqueta}: Garmin ${umbral.valor}, intervals ${umbral.discrepa}`;
    });
}

/** Cómo se leen los umbrales en una respuesta, para poder contrastarlos. */
export function formatearUmbrales(umbrales: Umbrales, diagnostico = false): string {
  const ritmo = umbrales.velocidadUmbral
    ? (() => {
        const segundosPorKm = 1000 / umbrales.velocidadUmbral!.valor;
        const min = Math.floor(segundosPorKm / 60);
        const seg = Math.round(segundosPorKm % 60);
        return `${min}:${String(seg).padStart(2, "0")}/km`;
      })()
    : null;

  const fila = (etiqueta: string, umbral: Umbral | undefined, sufijo: string, extra = ""): string => {
    if (!umbral) return `${etiqueta.padEnd(22)}—`;
    const discrepa =
      umbral.discrepa !== undefined ? `  ⚠ intervals dice ${umbral.discrepa}` : "";
    return `${etiqueta.padEnd(22)}${umbral.valor}${sufijo}${extra}  · ${umbral.fuente}${discrepa}`;
  };

  // Solo se nombra a intervals si de verdad ha intervenido: si no, es ruido.
  const conIntervals = [umbrales.lthr, umbrales.fcMax, umbrales.ftp, umbrales.velocidadUmbral].some(
    (u) => u && (u.fuente === "intervals.icu" || u.discrepa !== undefined),
  );
  const lineas = [
    conIntervals
      ? "Umbrales del atleta (manda Garmin; intervals.icu es respaldo):"
      : "Umbrales del atleta (Garmin):",
    fila("FC de umbral (LTHR)", umbrales.lthr, " ppm"),
    fila("FC máxima", umbrales.fcMax, " ppm"),
    fila("FTP", umbrales.ftp, " W"),
    fila(
      "Ritmo de umbral",
      umbrales.velocidadUmbral,
      " m/s",
      ritmo ? ` (${ritmo})` : "",
    ),
  ];
  if (umbrales.zonas) {
    const { deporte, suelos, maxUsada } = umbrales.zonas;
    lineas.push(
      "",
      `Zonas de FC en Garmin${deporte ? ` (${deporte})` : ""}` +
        `${maxUsada ? `, calculadas sobre ${maxUsada} ppm` : ""}:`,
      suelos.map((suelo, i) => `Z${i + 1} ≥${suelo}`).join(" · "),
      "Son las del reloj, y las que usa garmin_create_workout con 'zone'. Para un techo o " +
        "una banda concretos, mejor ppm absolutos ('bpm': [min, max]).",
    );
    // Una zona de 1-3 ppm de ancho no es una zona: es un corte mal configurado
    // que hace que un paso «en Z4» sea imposible de cumplir.
    const estrechas = suelos
      .slice(0, -1)
      .map((suelo, i) => ({ z: i + 1, ancho: suelos[i + 1]! - suelo }))
      .filter((x) => x.ancho > 0 && x.ancho < 4);
    if (estrechas.length) {
      lineas.push(
        `⚠ Zona${estrechas.length > 1 ? "s" : ""} de muy pocas pulsaciones: ` +
          estrechas.map((x) => `Z${x.z} de ${x.ancho} ppm`).join(", ") +
          ". No prescribas por número de zona hasta revisarlas en Garmin Connect.",
      );
    }
  }
  if (umbrales.fallos.length) {
    lineas.push("", `No se pudo leer de Garmin: ${umbrales.fallos.join(", ")}.`);
  }
  if (discrepantes(umbrales).length) {
    lineas.push(
      "",
      "⚠ Garmin y intervals.icu no dicen lo mismo. Se usa el de Garmin, que es el origen " +
        "y lo que acaba en el reloj. Si el bueno es el de intervals —lo editaste ahí tras un " +
        "test—, cámbialo en Garmin Connect: intervals no se lo va a contar.",
    );
  }
  if (diagnostico) {
    lineas.push(
      "",
      `Claves que trae Garmin en su respuesta de zonas (solo los nombres): ${
        umbrales.clavesZonas?.length ? umbrales.clavesZonas.join(", ") : "ninguna"
      }.`,
    );
  }
  lineas.push(
    "",
    "Un umbral desactualizado no da error: escribe un paso plausible y falso en el reloj.",
  );
  return lineas.join("\n");
}
