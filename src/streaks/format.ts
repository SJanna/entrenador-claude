/**
 * Las rachas en texto compacto para el MCP. El panel pinta el mismo cálculo con
 * celdas de colores; aquí van tabla y un calendario ASCII, que es lo que un
 * modelo puede leer sin gastar contexto en JSON.
 */

import * as fmt from "../intervals/format";
import { mondayOf, weekdayMonday0 } from "../dates";
import type { DiaRacha, Racha, RachasResultado } from "./compute";

const SIMBOLO: Record<string, string> = {
  activo: "#",
  descanso: "o",
  fallado: ".",
  pendiente: "?",
};

function rangoMejor(racha: Racha): string {
  if (!racha.mejorDesde) return fmt.DASH;
  if (racha.mejorDesde === racha.mejorHasta) return racha.mejorDesde;
  return `${racha.mejorDesde} → ${racha.mejorHasta}`;
}

function actual(racha: Racha): string {
  return (racha.truncada ? "≥" : "") + racha.actual;
}

/** Calendario ASCII: una línea por semana, columnas de lunes a domingo. */
function calendario(dias: DiaRacha[]): string[] {
  if (!dias.length) return [];
  const lineas: string[] = [];
  let semana = mondayOf(dias[0]!.fecha);
  let celdas = new Array<string>(7).fill(" ");
  for (const dia of dias) {
    const lunes = mondayOf(dia.fecha);
    if (lunes !== semana) {
      lineas.push(`  ${semana}  ${celdas.join("")}`);
      semana = lunes;
      celdas = new Array<string>(7).fill(" ");
    }
    celdas[weekdayMonday0(dia.fecha)] = SIMBOLO[dia.estado] ?? ".";
  }
  lineas.push(`  ${semana}  ${celdas.join("")}`);
  return lineas;
}

export function formatRachas(r: RachasResultado, diasCalendario = 28): string {
  const minutos = Math.round(r.umbrales.minSegundos / 60);
  const horasSueno = r.umbrales.suenoSegundos / 3600;

  const filas: string[][] = [
    ["movimiento", actual(r.movimiento), String(r.movimiento.mejor), r.movimiento.desde ?? fmt.DASH, rangoMejor(r.movimiento)],
    ["cumplimiento", actual(r.cumplimiento), String(r.cumplimiento.mejor), r.cumplimiento.desde ?? fmt.DASH, rangoMejor(r.cumplimiento)],
    [`sueño ≥${horasSueno} h`, actual(r.sueno), String(r.sueno.mejor), r.sueno.desde ?? fmt.DASH, rangoMejor(r.sueno)],
    [`semanas ≥${r.umbrales.diasActivosSemana} d`, actual(r.semanal), String(r.semanal.mejor), r.semanal.desde ?? fmt.DASH, rangoMejor(r.semanal)],
  ];

  const partes: string[] = [
    `Rachas · ${r.desde} → ${r.hoy}`,
    `Un día cuenta como activo con una actividad de ≥${minutos} min. El descanso solo ` +
      "cuenta como cumplido si está en el calendario (HOLIDAY/SICK/INJURED o nota de " +
      "descanso): un día vacío es un día perdido. Hoy y la semana en curso no rompen nada " +
      "hasta que acaben.",
    "",
    fmt.table(
      ["racha", "actual", "mejor", "desde", "mejor entre"],
      filas,
      ["l", "r", "r", "l", "l"],
    ),
  ];

  const pendientes = [
    r.movimiento.pendiente ? "movimiento" : null,
    r.cumplimiento.pendiente ? "cumplimiento" : null,
    r.sueno.pendiente ? "sueño" : null,
  ].filter(Boolean);
  if (pendientes.length) {
    partes.push("", `Hoy (${r.hoy}) sigue abierto en: ${pendientes.join(", ")}.`);
  }

  const ventana = r.dias.slice(-diasCalendario);
  if (ventana.length) {
    partes.push(
      "",
      "Calendario (lunes→domingo · # activo · o descanso · . perdido · ? hoy sin cerrar):",
      ...calendario(ventana),
    );
  }

  const ultima = r.semanas[r.semanas.length - 1];
  if (ultima) {
    partes.push(
      "",
      `Semana en curso (${ultima.lunes}): ${ultima.diasActivos}/7 días activos · ` +
        `${fmt.duration(ultima.segundos, { forceHours: true })} · carga ${Math.round(ultima.carga)}.`,
    );
  }

  if (r.aviso) {
    partes.push("", `AVISO: ${r.aviso.texto}`);
  }
  partes.push(
    "",
    "Si hoy toca descansar, la racha de cumplimiento no se rompe: deja el descanso escrito " +
      "en el calendario con create_note. Y nunca uses la racha como argumento para entrenar.",
  );

  return partes.join("\n");
}
