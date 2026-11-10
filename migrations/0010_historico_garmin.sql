-- Histórico propio sacado de Garmin: lo que hasta ahora solo daba intervals.icu.
--
-- intervals guardaba el histórico y hacía los cálculos (CTL/ATL/TSB, curvas de
-- ritmo, desacople, ventanas largas de bienestar). Garmin tiene los datos pero
-- no la memoria: su API de bienestar es día a día y sus récords son solo los
-- oficiales. Estas tablas son esa memoria. Las llena el cron poco a poco
-- (src/historico/sincronizar.ts), con un presupuesto de llamadas por ejecución,
-- y se pueden reconstruir enteras desde Garmin: no son fuente de verdad, son
-- caché con cálculo.

-- Una fila por actividad del reloj.
CREATE TABLE g_actividades (
  id INTEGER PRIMARY KEY,               -- activityId de Garmin
  fecha TEXT NOT NULL,                  -- YYYY-MM-DD local
  inicio TEXT,                          -- startTimeLocal
  deporte TEXT NOT NULL,                -- typeKey: running, trail_running, walking…
  nombre TEXT,
  segundos REAL,
  segundos_mov REAL,
  distancia_m REAL,
  fc_media REAL,
  fc_max REAL,
  desnivel_m REAL,
  carga REAL,                           -- activityTrainingLoad (escala de Garmin)
  efecto_aerobico REAL,
  -- Detalle (series de pulso, velocidad y distancia): pendiente | hecho | sin_datos | no_aplica | error
  detalle_estado TEXT NOT NULL DEFAULT 'pendiente',
  detalle_error TEXT,
  detalle_intentos INTEGER NOT NULL DEFAULT 0,  -- fallos transitorios: a los 3, 'error'

  desacople_pct REAL,                   -- Pa:FC primera mitad frente a segunda
  mejores TEXT,                         -- JSON {"400": s, "1000": s, …}
  fc_max_serie REAL,
  actualizado_en TEXT NOT NULL
);
CREATE INDEX g_actividades_fecha ON g_actividades (fecha);
CREATE INDEX g_actividades_detalle ON g_actividades (detalle_estado, detalle_intentos, fecha);

-- Una fila por día de bienestar. `datos` guarda el día entero tal como lo
-- normaliza src/garmin/bienestar.ts; las columnas sueltas son las que se
-- agregan en ventanas largas.
CREATE TABLE g_bienestar (
  fecha TEXT PRIMARY KEY,
  fc_reposo REAL,
  hrv_noche REAL,
  sueno_seg REAL,
  sueno_puntuacion REAL,
  readiness REAL,
  carga_aguda REAL,
  carga_cronica REAL,
  peso_kg REAL,
  datos TEXT,
  fallos TEXT,
  actualizado_en TEXT NOT NULL
);

-- Cursores de la sincronización (hasta dónde llegó la carga inicial, etc.).
CREATE TABLE g_sync (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
