/**
 * Rachas: cálculo puro sobre actividades, calendario y bienestar.
 *
 * Sin red y sin D1: recibe los datos ya mapeados y devuelve los contadores, el
 * día a día (para el heatmap) y los avisos. Así el panel, el MCP y los tests
 * comparten exactamente la misma lógica.
 *
 * Tres decisiones de diseño, deliberadas:
 *
 *  1. El descanso solo cuenta como cumplido si está EXPLÍCITO en el calendario
 *     (HOLIDAY/SICK/INJURED o una nota de descanso). Un día vacío es un día
 *     perdido, no un descanso: si no, la racha se infla sola.
 *  2. El día de hoy nunca rompe una racha: queda "pendiente" hasta que acabe.
 *     Lo mismo con la semana en curso.
 *  3. La racha no es un premio por apretar. Si encadenas días sin uno suave,
 *     `aviso` lo dice: el contador deja de celebrar y avisa.
 */

import { addDays, mondayOf } from "../dates";

// ---------------------------------------------------------------- entradas

export interface ActividadRacha {
  fecha: string; // YYYY-MM-DD en hora local del atleta (start_date_local)
  deporte?: string;
  segundos?: number | null;
  carga?: number | null;
}

export interface EventoRacha {
  fecha: string;
  categoria?: string; // WORKOUT | NOTE | HOLIDAY | SICK | INJURED | RACE_A…
  nombre?: string;
  descripcion?: string;
  segundos?: number | null;
}

export interface BienestarRacha {
  fecha: string;
  sueno_secs?: number | null;
}

export interface UmbralesRachas {
  /** Duración mínima (segundos) de una actividad para que el día cuente. */
  minSegundos: number;
  /** Fracción del tiempo programado que basta para dar la sesión por hecha. */
  fraccionProgramado: number;
  /** Sueño mínimo (segundos) para que la noche cuente. */
  suenoSegundos: number;
  /** Días activos que necesita una semana para contar como cumplida. */
  diasActivosSemana: number;
  /** Carga por debajo de la cual el día se considera suave (no aprieta). */
  cargaSuave: number;
  /** Días seguidos sin ningún día suave a partir de los cuales avisamos. */
  techoDias: number;
}

export const UMBRALES: UmbralesRachas = {
  minSegundos: 15 * 60,
  fraccionProgramado: 0.6,
  suenoSegundos: 7 * 3600,
  diasActivosSemana: 3,
  cargaSuave: 25,
  techoDias: 10,
};

export interface EntradaRachas {
  hoy: string;
  desde: string;
  actividades: ActividadRacha[];
  eventos?: EventoRacha[];
  bienestar?: BienestarRacha[];
  umbrales?: Partial<UmbralesRachas>;
}

// ---------------------------------------------------------------- salidas

export type EstadoDia = "activo" | "descanso" | "fallado" | "pendiente";

/**
 * El día ya resumido, pero SIN juzgar: aquí no hay ningún umbral aplicado.
 * Es lo que se puede guardar en D1, porque cambiar un umbral no lo invalida.
 */
export interface DiaAgregado {
  fecha: string;
  /** Suma del tiempo en movimiento del día. */
  segundos: number;
  /** La actividad más larga del día: es la que decide si el día cuenta. */
  segundosMax: number;
  carga: number;
  sesiones: number;
  deportes: string[];
  programados: number;
  segundosProgramados: number;
  descansoExplicito: boolean;
  suenoSecs: number | null;
}

/** El día ya juzgado con unos umbrales concretos. */
export interface DiaRacha extends DiaAgregado {
  activo: boolean;
  cumple: boolean;
  estado: EstadoDia;
}

export interface Racha {
  actual: number;
  desde: string | null;
  mejor: number;
  mejorDesde: string | null;
  mejorHasta: string | null;
  /** El periodo en curso (hoy, o la semana actual) aún no cuenta. */
  pendiente: boolean;
  /** La racha actual llega al borde de la ventana: puede ser más larga. */
  truncada: boolean;
}

export interface Semana {
  lunes: string;
  diasActivos: number;
  segundos: number;
  carga: number;
  cumplida: boolean;
  enCurso: boolean;
}

export interface AvisoRacha {
  tipo: "techo";
  dias: number;
  texto: string;
}

export interface RachasResultado {
  hoy: string;
  desde: string;
  umbrales: UmbralesRachas;
  /** Días seguidos con al menos una actividad de ≥ `minSegundos`. */
  movimiento: Racha;
  /** Días seguidos haciendo lo que tocaba (el descanso explícito cuenta). */
  cumplimiento: Racha;
  /** Noches seguidas durmiendo ≥ `suenoSegundos`. */
  sueno: Racha;
  /** Semanas (lunes→domingo) seguidas con ≥ `diasActivosSemana` días activos. */
  semanal: Racha;
  semanas: Semana[];
  aviso: AvisoRacha | null;
  dias: DiaRacha[];
}

// -------------------------------------------------------------- utilidades

const CATEGORIAS_DESCANSO = new Set(["HOLIDAY", "SICK", "INJURED"]);
const RE_DESCANSO = /\b(descanso|reposo|rest day|d[ií]a libre|off day)\b/i;
/** "Descanso activo" o "regenerativo" son sesiones, no descanso. */
const RE_NO_ES_DESCANSO = /(descanso activo|regenerativ)/i;

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Lunes de la semana de `iso`. */
export const lunesDe = mondayOf;

/** ¿Este evento del calendario declara un día de descanso? */
export function esDescansoExplicito(evento: EventoRacha): boolean {
  const categoria = String(evento.categoria ?? "").toUpperCase();
  if (CATEGORIAS_DESCANSO.has(categoria)) return true;
  if (categoria !== "NOTE") return false; // un WORKOUT es sesión, se llame como se llame
  const texto = `${evento.nombre ?? ""} ${evento.descripcion ?? ""}`;
  return RE_DESCANSO.test(texto) && !RE_NO_ES_DESCANSO.test(texto);
}

interface Unidad {
  clave: string;
  ok: boolean;
  /** Aún en curso: si no cumple, no rompe la racha (solo la deja pendiente). */
  enCurso: boolean;
}

/**
 * Racha sobre una lista cronológica. Una unidad en curso que aún no cumple no
 * suma ni rompe: por eso "hoy sin entrenar" no te tira 15 días a la basura.
 */
function calculaRacha(unidades: Unidad[]): Racha {
  let mejor = 0;
  let mejorDesde: string | null = null;
  let mejorHasta: string | null = null;
  let actual = 0;
  let desde: string | null = null;

  for (const unidad of unidades) {
    if (unidad.ok) {
      actual += 1;
      if (actual === 1) desde = unidad.clave;
      if (actual > mejor) {
        mejor = actual;
        mejorDesde = desde;
        mejorHasta = unidad.clave;
      }
    } else if (!unidad.enCurso) {
      actual = 0;
      desde = null;
    }
  }

  const ultima = unidades[unidades.length - 1];
  const primera = unidades[0];
  return {
    actual,
    desde,
    mejor,
    mejorDesde,
    mejorHasta,
    pendiente: Boolean(ultima && ultima.enCurso && !ultima.ok),
    truncada: actual > 0 && Boolean(primera) && desde === primera!.clave,
  };
}

// ------------------------------------------------------------------ cálculo

/**
 * Datos crudos → un registro por día, sin aplicar ningún umbral. Rejilla densa:
 * los días vacíos también existen, porque los huecos son la mitad de la
 * información en una racha.
 */
export function diaVacio(fecha: string): DiaAgregado {
  return {
    fecha,
    segundos: 0,
    segundosMax: 0,
    carga: 0,
    sesiones: 0,
    deportes: [],
    programados: 0,
    segundosProgramados: 0,
    descansoExplicito: false,
    suenoSecs: null,
  };
}

/** Rellena los días que falten para que el rango no tenga agujeros. */
export function densificar(desde: string, hasta: string, dias: DiaAgregado[]): DiaAgregado[] {
  const mapa = new Map(dias.map((d) => [d.fecha, d]));
  const salida: DiaAgregado[] = [];
  for (let fecha = desde; fecha <= hasta; fecha = addDays(fecha, 1)) {
    salida.push(mapa.get(fecha) ?? diaVacio(fecha));
  }
  return salida;
}

export function agregarDias(entrada: EntradaRachas): DiaAgregado[] {
  const hoy = entrada.hoy;
  const desde = entrada.desde <= hoy ? entrada.desde : hoy;

  const dias = new Map<string, DiaAgregado>();
  for (let fecha = desde; fecha <= hoy; fecha = addDays(fecha, 1)) {
    dias.set(fecha, diaVacio(fecha));
  }

  for (const actividad of entrada.actividades) {
    const dia = dias.get(actividad.fecha);
    if (!dia) continue; // fuera de ventana, o en el futuro
    const segundos = num(actividad.segundos);
    dia.sesiones += 1;
    dia.segundos += segundos;
    dia.segundosMax = Math.max(dia.segundosMax, segundos);
    dia.carga += num(actividad.carga);
    const deporte = String(actividad.deporte ?? "").trim();
    if (deporte && !dia.deportes.includes(deporte)) dia.deportes.push(deporte);
  }

  for (const evento of entrada.eventos ?? []) {
    const dia = dias.get(evento.fecha);
    if (!dia) continue;
    if (String(evento.categoria ?? "").toUpperCase() === "WORKOUT") {
      dia.programados += 1;
      dia.segundosProgramados += num(evento.segundos);
    }
    if (esDescansoExplicito(evento)) dia.descansoExplicito = true;
  }

  for (const noche of entrada.bienestar ?? []) {
    const dia = dias.get(noche.fecha);
    if (!dia) continue;
    const secs = num(noche.sueno_secs);
    if (secs > 0) dia.suenoSecs = secs;
  }

  return [...dias.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/** Aplica los umbrales: aquí, y solo aquí, se decide qué cuenta. */
export function clasificarDias(
  dias: DiaAgregado[],
  umbrales: UmbralesRachas,
  hoy: string,
): DiaRacha[] {
  return dias.map((dia) => {
    const activo = dia.segundosMax >= umbrales.minSegundos;
    const hizoLoProgramado =
      dia.segundosProgramados > 0
        ? dia.segundos >= umbrales.fraccionProgramado * dia.segundosProgramados
        : dia.sesiones > 0;
    const cumple =
      dia.descansoExplicito || activo || (dia.programados > 0 && hizoLoProgramado);
    const estado: EstadoDia = cumple
      ? activo
        ? "activo"
        : "descanso"
      : dia.fecha === hoy
        ? "pendiente"
        : "fallado";
    return { ...dia, activo, cumple, estado };
  });
}

export function calcularRachas(entrada: EntradaRachas): RachasResultado {
  return rachasDeDias(agregarDias(entrada), {
    hoy: entrada.hoy,
    umbrales: entrada.umbrales,
  });
}

/**
 * El cálculo a partir de la rejilla ya agregada: es la vía que usa la lectura
 * mixta (histórico de D1 + los últimos días en vivo).
 */
export function rachasDeDias(
  dias: DiaAgregado[],
  opciones: { hoy: string; umbrales?: Partial<UmbralesRachas> },
): RachasResultado {
  const umbrales: UmbralesRachas = { ...UMBRALES, ...(opciones.umbrales ?? {}) };
  const hoy = opciones.hoy;
  const lista = clasificarDias(dias, umbrales, hoy);
  const desde = lista.length ? lista[0]!.fecha : hoy;

  const movimiento = calculaRacha(
    lista.map((d) => ({ clave: d.fecha, ok: d.activo, enCurso: d.fecha === hoy })),
  );
  const cumplimiento = calculaRacha(
    lista.map((d) => ({ clave: d.fecha, ok: d.cumple, enCurso: d.fecha === hoy })),
  );

  // Sueño: una noche sin registrar cuenta como rota (igual que un día vacío no
  // es descanso). La de hoy puede no haber sincronizado todavía: queda abierta.
  const sueno = calculaRacha(
    lista.map((d) => ({
      clave: d.fecha,
      ok: num(d.suenoSecs) >= umbrales.suenoSegundos,
      enCurso: d.fecha === hoy,
    })),
  );

  // Semanas de lunes a domingo. La primera puede venir cortada por la ventana:
  // la descartamos para no contar una semana incompleta como fallada.
  const semanasMap = new Map<string, Semana>();
  for (const dia of lista) {
    const lunes = lunesDe(dia.fecha);
    const semana = semanasMap.get(lunes) ?? {
      lunes,
      diasActivos: 0,
      segundos: 0,
      carga: 0,
      cumplida: false,
      enCurso: false,
    };
    if (dia.activo) semana.diasActivos += 1;
    semana.segundos += dia.segundos;
    semana.carga += dia.carga;
    semanasMap.set(lunes, semana);
  }
  const lunesHoy = lunesDe(hoy);
  const lunesPrimero = lunesDe(desde);
  const semanas = [...semanasMap.values()]
    .filter((s) => s.lunes !== lunesPrimero || desde === lunesPrimero)
    .sort((a, b) => a.lunes.localeCompare(b.lunes))
    .map((s) => ({
      ...s,
      cumplida: s.diasActivos >= umbrales.diasActivosSemana,
      enCurso: s.lunes === lunesHoy,
    }));
  const semanal = calculaRacha(
    semanas.map((s) => ({ clave: s.lunes, ok: s.cumplida, enCurso: s.enCurso })),
  );

  // Techo: días seguidos apretando, sin ninguno suave. Cuenta hacia atrás desde
  // el último día CERRADO: hoy por la mañana tiene carga 0 y, si contara, el
  // aviso no saltaría nunca antes de entrenar, que es justo cuando sirve.
  let inicio = lista.length - 1;
  const ultimoDia = lista[inicio];
  if (ultimoDia && ultimoDia.fecha === hoy && ultimoDia.sesiones === 0) inicio -= 1;
  let diasApretando = 0;
  for (let i = inicio; i >= 0; i--) {
    if (lista[i]!.carga > umbrales.cargaSuave) diasApretando += 1;
    else break;
  }
  const aviso: AvisoRacha | null =
    diasApretando >= umbrales.techoDias
      ? {
          tipo: "techo",
          dias: diasApretando,
          texto:
            `Llevas ${diasApretando} días seguidos sin un día suave (carga ≤ ${umbrales.cargaSuave}). ` +
            "Sostener la racha no es motivo para encadenar otro: mete descanso.",
        }
      : null;

  return { hoy, desde, umbrales, movimiento, cumplimiento, sueno, semanal, semanas, aviso, dias: lista };
}
