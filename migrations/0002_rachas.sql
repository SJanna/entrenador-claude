-- Resumen diario para las rachas. Existe para que el histórico no dependa de
-- la ventana que la API de intervals.icu esté dispuesta a devolver.
--
-- Aquí NO hay ningún umbral aplicado: nada de "activo" ni "cumplido", solo los
-- agregados del día. Así, cambiar el mínimo de minutos no obliga a reescribir
-- el histórico; se reclasifica al leer.
--
-- Lo llena el cron cada madrugada y también cada lectura del panel o del MCP:
-- la escritura es idempotente (upsert por fecha) porque Garmin sincroniza tarde
-- y las actividades se editan días después.
CREATE TABLE dias_resumen (
  fecha TEXT PRIMARY KEY,                    -- YYYY-MM-DD en la zona del atleta
  segundos INTEGER NOT NULL DEFAULT 0,       -- tiempo en movimiento, sumado
  segundos_max INTEGER NOT NULL DEFAULT 0,   -- la actividad más larga del día
  carga REAL NOT NULL DEFAULT 0,
  sesiones INTEGER NOT NULL DEFAULT 0,
  deportes TEXT NOT NULL DEFAULT '',         -- separados por coma, en orden de aparición
  programados INTEGER NOT NULL DEFAULT 0,    -- entrenos que había en el calendario
  segundos_programados INTEGER NOT NULL DEFAULT 0,
  descanso_explicito INTEGER NOT NULL DEFAULT 0,
  sueno_secs INTEGER,
  actualizado_en TEXT NOT NULL
);
