/**
 * D1 del histórico de Garmin (migración 0010). Caché con cálculo: se puede
 * reconstruir entera desde Garmin, así que nada aquí es fuente de verdad.
 */

import type { Actividad } from "../garmin/actividades";
import type { DiaBienestar } from "../garmin/bienestar";
import type { ActividadH } from "./calculos";

export interface FilaActividad extends ActividadH {
  inicio: string | null;
  segundos_mov: number | null;
  fc_max: number | null;
  efecto_aerobico: number | null;
  detalle_estado: string;
  detalle_error: string | null;
  /** Migración 0011: GAP en m/s y temperatura del clima en °C. */
  gap_ms?: number | null;
  temp_clima?: number | null;
  clima_estado?: string;
}

/** Carrera al aire libre: lo único que tiene clima. Cinta y virtual, no. */
const CON_CLIMA = new Set(["running", "trail_running", "street_running", "track_running"]);
export function conClima(deporte: string): boolean {
  return CON_CLIMA.has(deporte);
}

export interface FilaBienestar {
  fecha: string;
  fc_reposo: number | null;
  hrv_noche: number | null;
  sueno_seg: number | null;
  sueno_puntuacion: number | null;
  readiness: number | null;
  carga_aguda: number | null;
  carga_cronica: number | null;
  peso_kg: number | null;
  fallos: string | null;
  actualizado_en: string;
}

export interface Cobertura {
  actividades: number;
  primera: string | null;
  ultima: string | null;
  detallesPendientes: number;
  diasBienestar: number;
  bienestarDesde: string | null;
  cargaInicialCompleta: boolean;
  objetivoBienestar: string | null;
  ultimaSync: string | null;
}

const nowIso = () => new Date().toISOString();

export class HistoricoStore {
  private columnasGarmin: Promise<boolean> | null = null;

  constructor(private readonly db: D1Database) {}

  /**
   * ¿Está la migración 0011 (GAP y clima)? Si el código llega antes que la
   * migración, el histórico sigue funcionando como antes, sin esos dos datos.
   */
  conGapYClima(): Promise<boolean> {
    this.columnasGarmin ??= this.db
      .prepare("SELECT gap_ms, temp_clima, clima_estado FROM g_actividades LIMIT 0")
      .all()
      .then(() => true, () => false);
    return this.columnasGarmin;
  }

  /** ¿Está la migración 0010? Sin ella el histórico no existe y se dice. */
  async disponible(): Promise<boolean> {
    try {
      await this.db.prepare("SELECT 1 FROM g_sync LIMIT 1").all();
      return true;
    } catch {
      return false;
    }
  }

  async guardarActividades(lista: Actividad[], aplicaDetalle: (deporte: string) => boolean): Promise<number> {
    if (!lista.length) return 0;
    const ts = nowIso();
    const antes = await this.db
      .prepare(`SELECT id FROM g_actividades WHERE id IN (${lista.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...lista.map((a) => a.id))
      .all<{ id: number }>();
    const conocidas = new Set(antes.results.map((r) => r.id));
    if (!(await this.conGapYClima())) {
      await this.guardarActividadesSin0011(lista, aplicaDetalle, ts);
      return lista.filter((a) => !conocidas.has(a.id)).length;
    }
    // Upsert del resumen sin tocar el detalle ya calculado.
    await this.db.batch(
      lista.map((a) =>
        this.db
          .prepare(
            "INSERT INTO g_actividades (id, fecha, inicio, deporte, nombre, segundos, segundos_mov, " +
              "distancia_m, fc_media, fc_max, desnivel_m, carga, efecto_aerobico, detalle_estado, " +
              "actualizado_en, gap_ms, clima_estado) " +
              "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17) " +
              "ON CONFLICT(id) DO UPDATE SET fecha = excluded.fecha, inicio = excluded.inicio, " +
              "deporte = excluded.deporte, nombre = excluded.nombre, segundos = excluded.segundos, " +
              "segundos_mov = excluded.segundos_mov, distancia_m = excluded.distancia_m, " +
              "fc_media = excluded.fc_media, fc_max = excluded.fc_max, desnivel_m = excluded.desnivel_m, " +
              "carga = excluded.carga, efecto_aerobico = excluded.efecto_aerobico, " +
              // Si cambió el deporte (un paseo que era carrera), vuelve a pedir series.
              "detalle_estado = CASE WHEN g_actividades.detalle_estado = 'no_aplica' AND " +
              "excluded.detalle_estado = 'pendiente' THEN 'pendiente' ELSE g_actividades.detalle_estado END, " +
              // Un GAP que no viene no borra el que ya había.
              "gap_ms = COALESCE(excluded.gap_ms, g_actividades.gap_ms), " +
              // Y lo mismo con el clima: si pasa a ser carrera al aire libre, se pide.
              "clima_estado = CASE WHEN g_actividades.clima_estado = 'no_aplica' AND " +
              "excluded.clima_estado = 'pendiente' THEN 'pendiente' " +
              "WHEN excluded.clima_estado = 'no_aplica' THEN 'no_aplica' ELSE g_actividades.clima_estado END, " +
              "actualizado_en = excluded.actualizado_en",
          )
          .bind(
            a.id, a.fecha, a.fecha && a.hora ? `${a.fecha}T${a.hora}` : null, a.deporte, a.nombre,
            a.segundos, a.segundosMov, a.distanciaM, a.fcMedia, a.fcMax, a.desnivelM, a.carga,
            a.efectoAerobico, aplicaDetalle(a.deporte) ? "pendiente" : "no_aplica", ts,
            a.gapMs ?? null, conClima(a.deporte) ? "pendiente" : "no_aplica",
          ),
      ),
    );
    return lista.filter((a) => !conocidas.has(a.id)).length;
  }

  /** Lo de siempre, sin GAP ni clima: para una base sin la migración 0011. */
  private async guardarActividadesSin0011(
    lista: Actividad[],
    aplicaDetalle: (deporte: string) => boolean,
    ts: string,
  ): Promise<void> {
    await this.db.batch(
      lista.map((a) =>
        this.db
          .prepare(
            "INSERT INTO g_actividades (id, fecha, inicio, deporte, nombre, segundos, segundos_mov, " +
              "distancia_m, fc_media, fc_max, desnivel_m, carga, efecto_aerobico, detalle_estado, " +
              "actualizado_en) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) " +
              "ON CONFLICT(id) DO UPDATE SET fecha = excluded.fecha, inicio = excluded.inicio, " +
              "deporte = excluded.deporte, nombre = excluded.nombre, segundos = excluded.segundos, " +
              "segundos_mov = excluded.segundos_mov, distancia_m = excluded.distancia_m, " +
              "fc_media = excluded.fc_media, fc_max = excluded.fc_max, desnivel_m = excluded.desnivel_m, " +
              "carga = excluded.carga, efecto_aerobico = excluded.efecto_aerobico, " +
              "detalle_estado = CASE WHEN g_actividades.detalle_estado = 'no_aplica' AND " +
              "excluded.detalle_estado = 'pendiente' THEN 'pendiente' ELSE g_actividades.detalle_estado END, " +
              "actualizado_en = excluded.actualizado_en",
          )
          .bind(
            a.id, a.fecha, a.fecha && a.hora ? `${a.fecha}T${a.hora}` : null, a.deporte, a.nombre,
            a.segundos, a.segundosMov, a.distanciaM, a.fcMedia, a.fcMax, a.desnivelM, a.carga,
            a.efectoAerobico, aplicaDetalle(a.deporte) ? "pendiente" : "no_aplica", ts,
          ),
      ),
    );
  }

  async pendientesDeDetalle(limite: number): Promise<Array<{ id: number }>> {
    const r = await this.db
      .prepare(
        "SELECT id FROM g_actividades WHERE detalle_estado = 'pendiente' " +
          "ORDER BY detalle_intentos, fecha DESC LIMIT ?1",
      )
      .bind(limite)
      .all<{ id: number }>();
    return r.results;
  }

  async guardarDetalle(
    id: number,
    d: { estado: string; error?: string | null; desacople?: number | null; mejores?: Record<string, number> | null; fcMax?: number | null },
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE g_actividades SET detalle_estado = ?1, detalle_error = ?2, desacople_pct = ?3, " +
          "mejores = ?4, fc_max_serie = ?5, actualizado_en = ?6 WHERE id = ?7",
      )
      .bind(
        d.estado, d.error ?? null, d.desacople ?? null, d.mejores ? JSON.stringify(d.mejores) : null,
        d.fcMax ?? null, nowIso(), id,
      )
      .run();
  }

  /** Carreras al aire libre sin clima todavía, de la más nueva a la más vieja. */
  async pendientesDeClima(limite: number): Promise<Array<{ id: number }>> {
    if (limite <= 0 || !(await this.conGapYClima())) return [];
    const r = await this.db
      .prepare(
        "SELECT id FROM g_actividades WHERE clima_estado = 'pendiente' " +
          "ORDER BY clima_intentos, fecha DESC LIMIT ?1",
      )
      .bind(limite)
      .all<{ id: number }>();
    return r.results;
  }

  /** null = Garmin no tiene clima de esa actividad: no se vuelve a pedir. */
  async guardarClima(id: number, tempC: number | null): Promise<void> {
    await this.db
      .prepare(
        "UPDATE g_actividades SET temp_clima = ?1, clima_estado = ?2, actualizado_en = ?3 WHERE id = ?4",
      )
      .bind(tempC, tempC === null ? "sin_datos" : "hecho", nowIso(), id)
      .run();
  }

  /** Fallo transitorio del clima: al tercero, 'error' y no se insiste. */
  async falloClima(id: number, maxIntentos = 3): Promise<void> {
    await this.db
      .prepare(
        "UPDATE g_actividades SET clima_intentos = clima_intentos + 1, " +
          "clima_estado = CASE WHEN clima_intentos + 1 >= ?1 THEN 'error' ELSE 'pendiente' END, " +
          "actualizado_en = ?2 WHERE id = ?3",
      )
      .bind(maxIntentos, nowIso(), id)
      .run();
  }

  /** Fallo transitorio: se reintenta en otra pasada; al tercero queda como 'error'. */
  async falloDetalle(id: number, error: string, maxIntentos = 3): Promise<void> {
    await this.db
      .prepare(
        "UPDATE g_actividades SET detalle_intentos = detalle_intentos + 1, detalle_error = ?1, " +
          "detalle_estado = CASE WHEN detalle_intentos + 1 >= ?2 THEN 'error' ELSE 'pendiente' END, " +
          "actualizado_en = ?3 WHERE id = ?4",
      )
      .bind(error, maxIntentos, nowIso(), id)
      .run();
  }

  /**
   * Días leídos pero vacíos (sin FC en reposo ni sueño): el reloj pudo
   * sincronizar tarde. Se releen mientras sean recientes.
   */
  async diasVacios(desde: string, hasta: string): Promise<Map<string, string>> {
    const r = await this.db
      .prepare(
        "SELECT fecha, actualizado_en FROM g_bienestar WHERE datos IS NOT NULL AND " +
          "fc_reposo IS NULL AND sueno_seg IS NULL AND fecha BETWEEN ?1 AND ?2",
      )
      .bind(desde, hasta)
      .all<{ fecha: string; actualizado_en: string }>();
    return new Map(r.results.map((f) => [f.fecha, f.actualizado_en]));
  }

  async guardarDia(dia: DiaBienestar): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO g_bienestar (fecha, fc_reposo, hrv_noche, sueno_seg, sueno_puntuacion, readiness, " +
          "carga_aguda, carga_cronica, datos, fallos, actualizado_en) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) " +
          "ON CONFLICT(fecha) DO UPDATE SET fc_reposo = excluded.fc_reposo, hrv_noche = excluded.hrv_noche, " +
          "sueno_seg = excluded.sueno_seg, sueno_puntuacion = excluded.sueno_puntuacion, " +
          "readiness = excluded.readiness, carga_aguda = excluded.carga_aguda, " +
          "carga_cronica = excluded.carga_cronica, datos = excluded.datos, fallos = excluded.fallos, " +
          "actualizado_en = excluded.actualizado_en",
      )
      .bind(
        dia.fecha, dia.fcReposo, dia.hrvNoche, dia.sueñoSegundos, dia.sueñoPuntuacion, dia.readiness,
        dia.cargaAguda, dia.cargaCronica, JSON.stringify(dia), dia.fallos.length ? dia.fallos.join(" · ") : null,
        nowIso(),
      )
      .run();
  }

  async guardarPesos(pesos: Array<{ fecha: string; kg: number }>): Promise<void> {
    if (!pesos.length) return;
    const ts = nowIso();
    await this.db.batch(
      pesos.map((p) =>
        this.db
          .prepare(
            "INSERT INTO g_bienestar (fecha, peso_kg, actualizado_en) VALUES (?1, ?2, ?3) " +
              "ON CONFLICT(fecha) DO UPDATE SET peso_kg = excluded.peso_kg",
          )
          .bind(p.fecha, p.kg, ts),
      ),
    );
  }

  /** Días con bienestar ya leído (no solo peso), dentro de un rango. */
  async diasLeidos(desde: string, hasta: string): Promise<Map<string, string>> {
    const r = await this.db
      .prepare(
        "SELECT fecha, actualizado_en FROM g_bienestar WHERE datos IS NOT NULL AND fecha BETWEEN ?1 AND ?2",
      )
      .bind(desde, hasta)
      .all<{ fecha: string; actualizado_en: string }>();
    return new Map(r.results.map((f) => [f.fecha, f.actualizado_en]));
  }

  async actividades(filtro: { desde?: string; hasta?: string } = {}): Promise<FilaActividad[]> {
    const r = await this.db
      .prepare(
        "SELECT * FROM g_actividades WHERE fecha >= ?1 AND fecha <= ?2 ORDER BY fecha, inicio",
      )
      .bind(filtro.desde ?? "0000-00-00", filtro.hasta ?? "9999-99-99")
      .all<Record<string, unknown>>();
    return r.results.map((f) => ({
      ...(f as unknown as FilaActividad),
      mejores: typeof f.mejores === "string" ? (JSON.parse(f.mejores) as Record<string, number>) : null,
    }));
  }

  async bienestar(desde: string, hasta: string): Promise<FilaBienestar[]> {
    const r = await this.db
      .prepare("SELECT * FROM g_bienestar WHERE fecha BETWEEN ?1 AND ?2 ORDER BY fecha")
      .bind(desde, hasta)
      .all<FilaBienestar>();
    return r.results;
  }

  async leerCursor(clave: string): Promise<string | null> {
    const f = await this.db
      .prepare("SELECT valor FROM g_sync WHERE clave = ?1")
      .bind(clave)
      .first<{ valor: string }>();
    return f?.valor ?? null;
  }

  async fijarCursor(clave: string, valor: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO g_sync (clave, valor, actualizado_en) VALUES (?1, ?2, ?3) " +
          "ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en",
      )
      .bind(clave, valor, nowIso())
      .run();
  }

  async cobertura(): Promise<Cobertura> {
    const [a, p, b, completa, objetivo, sync] = await Promise.all([
      this.db
        .prepare("SELECT COUNT(*) AS n, MIN(fecha) AS primera, MAX(fecha) AS ultima FROM g_actividades")
        .first<{ n: number; primera: string | null; ultima: string | null }>(),
      this.db
        .prepare("SELECT COUNT(*) AS n FROM g_actividades WHERE detalle_estado = 'pendiente'")
        .first<{ n: number }>(),
      this.db
        .prepare("SELECT COUNT(*) AS n, MIN(fecha) AS desde FROM g_bienestar WHERE datos IS NOT NULL")
        .first<{ n: number; desde: string | null }>(),
      this.leerCursor("actividades_completas"),
      this.leerCursor("bienestar_objetivo"),
      this.leerCursor("ultima_sync"),
    ]);
    return {
      actividades: a?.n ?? 0,
      primera: a?.primera ?? null,
      ultima: a?.ultima ?? null,
      detallesPendientes: p?.n ?? 0,
      diasBienestar: b?.n ?? 0,
      bienestarDesde: b?.desde ?? null,
      cargaInicialCompleta: completa === "1",
      objetivoBienestar: objetivo,
      ultimaSync: sync,
    };
  }
}
