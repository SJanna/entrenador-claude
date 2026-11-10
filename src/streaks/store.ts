/**
 * Persistencia del resumen diario de rachas en D1 (tabla `dias_resumen`).
 *
 * Solo guarda agregados sin juzgar; los umbrales se aplican al leer. La
 * escritura es idempotente por fecha: se puede reescribir el mismo día tantas
 * veces como haga falta, que es justo lo que pasa cuando Garmin sincroniza
 * tarde o cuando se edita una actividad de hace tres días.
 */

import type { DiaAgregado } from "./compute";

const LOTE = 100;

interface FilaDia {
  fecha: string;
  segundos: number;
  segundos_max: number;
  carga: number;
  sesiones: number;
  deportes: string;
  programados: number;
  segundos_programados: number;
  descanso_explicito: number;
  sueno_secs: number | null;
}

function aDia(fila: FilaDia): DiaAgregado {
  return {
    fecha: fila.fecha,
    segundos: fila.segundos,
    segundosMax: fila.segundos_max,
    carga: fila.carga,
    sesiones: fila.sesiones,
    deportes: fila.deportes ? fila.deportes.split(",").filter(Boolean) : [],
    programados: fila.programados,
    segundosProgramados: fila.segundos_programados,
    descansoExplicito: fila.descanso_explicito === 1,
    suenoSecs: fila.sueno_secs,
  };
}

export interface Cobertura {
  primero: string | null;
  ultimo: string | null;
  total: number;
}

export class RachasStore {
  constructor(private db: D1Database) {}

  /** Qué tramo del histórico hay guardado. */
  async cobertura(): Promise<Cobertura> {
    const fila = await this.db
      .prepare(
        "SELECT MIN(fecha) AS primero, MAX(fecha) AS ultimo, COUNT(*) AS total FROM dias_resumen",
      )
      .first<{ primero: string | null; ultimo: string | null; total: number }>();
    return {
      primero: fila?.primero ?? null,
      ultimo: fila?.ultimo ?? null,
      total: fila?.total ?? 0,
    };
  }

  async leer(desde: string, hasta: string): Promise<DiaAgregado[]> {
    if (desde > hasta) return [];
    const { results } = await this.db
      .prepare("SELECT * FROM dias_resumen WHERE fecha >= ? AND fecha <= ? ORDER BY fecha")
      .bind(desde, hasta)
      .all<FilaDia>();
    return (results ?? []).map(aDia);
  }

  /** Upsert por fecha, en lotes. Devuelve cuántos días se escribieron. */
  async guardar(dias: DiaAgregado[], ahora: string): Promise<number> {
    if (!dias.length) return 0;
    const sentencia = this.db.prepare(
      `INSERT INTO dias_resumen
         (fecha, segundos, segundos_max, carga, sesiones, deportes, programados,
          segundos_programados, descanso_explicito, sueno_secs, actualizado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fecha) DO UPDATE SET
         segundos = excluded.segundos,
         segundos_max = excluded.segundos_max,
         carga = excluded.carga,
         sesiones = excluded.sesiones,
         deportes = excluded.deportes,
         programados = excluded.programados,
         segundos_programados = excluded.segundos_programados,
         descanso_explicito = excluded.descanso_explicito,
         -- El sueño llega por su lado: no borramos lo que ya había con un NULL.
         sueno_secs = COALESCE(excluded.sueno_secs, dias_resumen.sueno_secs),
         actualizado_en = excluded.actualizado_en`,
    );

    for (let i = 0; i < dias.length; i += LOTE) {
      const lote = dias.slice(i, i + LOTE).map((d) =>
        sentencia.bind(
          d.fecha,
          Math.round(d.segundos),
          Math.round(d.segundosMax),
          d.carga,
          d.sesiones,
          d.deportes.join(","),
          d.programados,
          Math.round(d.segundosProgramados),
          d.descansoExplicito ? 1 : 0,
          d.suenoSecs === null ? null : Math.round(d.suenoSecs),
          ahora,
        ),
      );
      await this.db.batch(lote);
    }
    return dias.length;
  }
}
