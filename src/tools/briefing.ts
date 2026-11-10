/**
 * briefing: el protocolo de lectura obligatorio antes de programar, en UNA
 * llamada.
 *
 * Existe por la familia de errores más cara del log: afirmar sin leer. El
 * calendario que «estaba vacío» porque solo se miró uno de los dos; el
 * disparador cancelado suponiendo su id; la semana que nadie evaluó. Siete
 * lecturas encadenadas son siete oportunidades de saltarse una. Aquí van todas
 * juntas, y lo que no se pudo leer sale escrito como NO LEÍDO, para que el
 * entrenador no programe encima de un hueco que no ve.
 *
 * Además calcula lo que un modelo tiende a pasar por alto al leer dos tablas
 * por separado: qué días de los próximos siete no tienen nada escrito en
 * ningún calendario, y qué días tienen algo en los dos (la misma sesión escrita
 * dos veces).
 */

import { addDays } from "../dates";
import type { Calendario } from "../garmin/calendario";

export interface FuentesBriefing {
  hoy: () => string;
  contrato: () => Promise<string>;
  bienestar: (dias: number) => Promise<string>;
  actividades: () => Promise<string>;
  calendarioGarmin: (desde: string, hasta: string) => Promise<Calendario>;
  /** Solo si hay intervals.icu. */
  eventosIntervals?: (desde: string, hasta: string) => Promise<Array<Record<string, unknown>>>;
  /** Carga semanal del histórico de Garmin. */
  resumenSemanal?: () => Promise<string>;
}

interface Planificado {
  fecha: string;
  texto: string;
  /** Cuenta como «hay algo ese día»: sesión programada o actividad hecha. */
  cuenta: boolean;
  /** Ya hecho (actividad registrada), no solo programado. */
  hecho: boolean;
  /** Nombre normalizado, para reconocer la misma sesión en los dos calendarios. */
  nombre: string;
}

const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

function diaLegible(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dia = DIAS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
  return `${dia} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

/** Lo que devuelven las herramientas cuando fallan empieza por «Error». */
function esError(texto: string): boolean {
  return /^Error\b/.test(texto.trim());
}

function deGarmin(cal: Calendario): Planificado[] {
  return cal.items.map((i) => {
    const hecho = i.activityId !== null || i.completado;
    const programado = i.workoutId !== null || i.scheduleId !== null;
    return {
      fecha: i.fecha,
      texto: `Garmin · ${hecho ? "✓ " : ""}${i.titulo}${i.tipo && i.tipo !== "workout" ? ` (${i.tipo})` : ""}`,
      cuenta: hecho || programado,
      hecho,
      nombre: i.titulo.trim().toLowerCase(),
    };
  });
}

function deIntervals(eventos: Array<Record<string, unknown>>): Planificado[] {
  return eventos.map((e) => {
    const fecha = String(e.start_date_local ?? e.start_date ?? "").slice(0, 10);
    const categoria = String(e.category ?? "").toUpperCase();
    return {
      fecha,
      texto: `intervals · ${String(e.name ?? "(sin nombre)")}${categoria && categoria !== "WORKOUT" ? ` (${categoria.toLowerCase()})` : ""}`,
      // Una nota no es una sesión: no tapa un día vacío.
      cuenta: categoria === "WORKOUT" || categoria.startsWith("RACE"),
      hecho: false,
      nombre: String(e.name ?? "").trim().toLowerCase(),
    };
  });
}

/** Días de [desde, hasta] sin nada que cuente, y días con algo en las dos fuentes. */
export function huecosYDobles(
  desde: string,
  hasta: string,
  garmin: Planificado[],
  intervals: Planificado[] | null,
): { vacios: string[]; dobles: string[] } {
  const vacios: string[] = [];
  const dobles: string[] = [];
  for (let d = desde; d <= hasta; d = addDays(d, 1)) {
    const g = garmin.some((p) => p.fecha === d && p.cuenta);
    const i = intervals?.some((p) => p.fecha === d && p.cuenta) ?? false;
    if (!g && !i) vacios.push(d);
    // Varias sesiones el mismo día es lo normal (caminata + trote + fuerza): eso
    // no es un doble. Lo es la MISMA sesión dos veces en Garmin, y con intervals
    // una suya que no esté en Garmin con ese nombre habiendo otra programada
    // allí (intervals empuja sus entrenos a Garmin con el mismo nombre).
    const gNombres = garmin
      .filter((p) => p.fecha === d && p.cuenta && !p.hecho)
      .map((p) => p.nombre);
    const repetida = gNombres.some((n, k) => gNombres.indexOf(n) !== k);
    const iNombres = (intervals ?? []).filter((p) => p.fecha === d && p.cuenta).map((p) => p.nombre);
    if (repetida || (gNombres.length >= 1 && iNombres.some((n) => !gNombres.includes(n)))) {
      dobles.push(d);
    }
  }
  return { vacios, dobles };
}

export async function briefing(
  f: FuentesBriefing,
  args: Record<string, unknown>,
): Promise<string> {
  const hoy = f.hoy();
  const num = (v: unknown, def: number) => {
    const n = Math.round(Number(v ?? def));
    return Number.isFinite(n) ? n : def;
  };
  const atras = Math.min(14, Math.max(0, num(args.days_back, 7)));
  const adelante = Math.min(21, Math.max(7, num(args.days_ahead, 14)));
  const diasBienestar = Math.min(7, Math.max(1, num(args.wellness_days, 3)));
  const desde = addDays(hoy, -atras);
  const hasta = addDays(hoy, adelante);
  const noLeido: string[] = [];

  const motivo = (exc: unknown) => (exc instanceof Error ? exc.message : String(exc));
  const texto = async (nombre: string, fn: () => Promise<string>): Promise<string> => {
    try {
      const t = await fn();
      if (esError(t)) {
        noLeido.push(`${nombre}: ${t.trim().slice(0, 200)}`);
        return `NO LEÍDO — ${t.trim()}`;
      }
      return t;
    } catch (exc) {
      noLeido.push(`${nombre}: ${motivo(exc)}`);
      return `NO LEÍDO — ${motivo(exc)}`;
    }
  };

  // En paralelo: las fuentes no dependen unas de otras.
  const [contrato, bienestar, actividades, calGarmin, eventos, semanas] = await Promise.all([
    texto("contrato", f.contrato),
    texto("bienestar de Garmin", () => f.bienestar(diasBienestar)),
    texto("actividades de Garmin", f.actividades),
    f.calendarioGarmin(desde, hasta).then(
      (c) => {
        if (c.fallos.length) noLeido.push(`calendario de Garmin: meses sin leer ${c.fallos.join(", ")}`);
        return c;
      },
      (exc) => {
        noLeido.push(`calendario de Garmin: ${motivo(exc)}`);
        return null;
      },
    ),
    f.eventosIntervals
      ? f.eventosIntervals(desde, hasta).catch((exc) => {
          noLeido.push(`calendario de intervals: ${motivo(exc)}`);
          return null;
        })
      : Promise.resolve(null),
    f.resumenSemanal ? texto("resumen semanal de intervals", f.resumenSemanal) : Promise.resolve(null),
  ]);

  const garmin = calGarmin ? deGarmin(calGarmin) : [];
  const intervals = eventos ? deIntervals(eventos) : null;

  const lineas: string[] = [
    `[BRIEFING] hoy ${hoy} · protocolo de lectura en una llamada. Léelo entero antes de programar.`,
    "",
    "== 1 · CONTRATO ==",
    contrato,
    "",
    `== 2 · BIENESTAR (Garmin, ${diasBienestar} día${diasBienestar === 1 ? "" : "s"}) ==`,
    bienestar,
    "",
    "== 3 · ACTIVIDADES RECIENTES (Garmin) ==",
    actividades,
    "",
    `== 4 · CALENDARIOS ${desde} → ${hasta} ==`,
  ];

  const todos = [...garmin, ...(intervals ?? [])].sort((a, b) => a.fecha.localeCompare(b.fecha));
  if (!calGarmin && !intervals) {
    lineas.push("NO LEÍDO — ningún calendario. No escribas nada en el calendario hasta poder leerlo.");
  } else {
    for (let d = desde; d <= hasta; d = addDays(d, 1)) {
      const del = todos.filter((p) => p.fecha === d);
      const marca = d === hoy ? " ← hoy" : "";
      lineas.push(`${diaLegible(d)}${marca}: ${del.length ? del.map((p) => p.texto).join(" · ") : "—"}`);
    }
    const proximos = huecosYDobles(hoy, addDays(hoy, 6), garmin, intervals);
    const finSemana = addDays(hoy, 6);
    const programados = garmin.filter(
      (p) => p.fecha >= hoy && p.fecha <= finSemana && p.cuenta && !p.hecho,
    ).length;
    lineas.push("");
    // El recuento va siempre: si el calendario se leyó a medias, un «0» al lado
    // de una semana que sí está escrita se ve, y un «—» por día no.
    lineas.push(
      `Programado en Garmin de hoy al ${diaLegible(finSemana)}: ${programados} ` +
        `entreno${programados === 1 ? "" : "s"}.`,
    );
    lineas.push(
      proximos.vacios.length
        ? `⚠ PRÓXIMOS 7 DÍAS SIN NADA ESCRITO: ${proximos.vacios.map(diaLegible).join(", ")}. ` +
            "«Nunca cero»: cada uno necesita su sesión antes de la noche anterior."
        : "Próximos 7 días: todos tienen algo escrito.",
    );
    if (proximos.dobles.length) {
      lineas.push(
        `⚠ LA MISMA SESIÓN ESCRITA DOS VECES${intervals ? " (o en los dos calendarios)" : ""}: ` +
          `${proximos.dobles.map(diaLegible).join(", ")}. Quita la que sobra con ` +
          "garmin_unschedule_workout (una fecha), no borrando el entreno.",
      );
    }
    if (!calGarmin) lineas.push("⚠ El calendario de Garmin NO se leyó: los días vacíos de arriba pueden no estarlo.");
    if (f.eventosIntervals && !intervals) {
      lineas.push("⚠ El calendario de intervals NO se leyó: los días vacíos de arriba pueden no estarlo.");
    }
  }

  if (semanas !== null) {
    lineas.push("", "== 5 · CARGA DE LAS ÚLTIMAS SEMANAS (histórico de Garmin) ==", semanas);
  }

  lineas.push("");
  if (noLeido.length) {
    lineas.push(
      "== FUENTES NO LEÍDAS ==",
      ...noLeido.map((n) => `  · ${n}`),
      "Lo que depende de estas fuentes no se programa: dilo y pide que se arregle (§3).",
    );
  } else {
    lineas.push("Todas las fuentes leídas.");
  }
  lineas.push(
    "Para el detalle: get_contract(detalle), garmin_activity(id) para las series de fuerza, " +
      "garmin_thresholds para los umbrales.",
  );
  return lineas.join("\n");
}
