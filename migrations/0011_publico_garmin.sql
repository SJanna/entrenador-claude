-- La página pública deja de leer intervals.icu: todo sale del histórico de
-- Garmin (g_actividades). Le faltaban dos datos que calculaba intervals:
--
--  - gap_ms: ritmo ajustado por pendiente, en m/s (avgGradeAdjustedSpeed de
--    Garmin). Lo usan el ritmo a pulso fijo y la predicción.
--  - temp_clima: temperatura del CLIMA en °C (endpoint de clima de cada
--    actividad), no la del sensor del reloj, que calienta la muñeca. Sale en
--    las sesiones de ayer y junto al ritmo a pulso fijo.
--
-- El clima cuesta una llamada por actividad: se pide solo para carrera al aire
-- libre, de la más nueva a la más vieja, unas pocas por pasada del cron.
ALTER TABLE g_actividades ADD COLUMN gap_ms REAL;
ALTER TABLE g_actividades ADD COLUMN temp_clima REAL;
-- pendiente | hecho | sin_datos | no_aplica | error
ALTER TABLE g_actividades ADD COLUMN clima_estado TEXT NOT NULL DEFAULT 'pendiente';
ALTER TABLE g_actividades ADD COLUMN clima_intentos INTEGER NOT NULL DEFAULT 0;
UPDATE g_actividades SET clima_estado = 'no_aplica'
  WHERE deporte NOT IN ('running', 'trail_running', 'street_running', 'track_running');
CREATE INDEX g_actividades_clima ON g_actividades (clima_estado, clima_intentos, fecha);

-- El GAP viene en el listado de actividades: se vuelve a recorrer la carga
-- inicial (página a página, una por pasada) para rellenarlo en lo ya guardado.
-- El detalle ya calculado (series, desacople, marcas) no se toca.
UPDATE g_sync SET valor = '0' WHERE clave IN ('actividades_completas', 'actividades_inicio');
