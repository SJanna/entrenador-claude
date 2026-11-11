-- Dos datos que el entrenador necesitaba y no veía:
--
--  - Humedad y sensación térmica de cada carrera al aire libre. Con calor y
--    humedad el pulso sube para el mismo ritmo: un pulso alto no se lee sin
--    ellas. La temperatura ya estaba (0011); las carreras con clima ya leído se
--    vuelven a pedir para rellenar la humedad, pocas por pasada del cron.
--  - Segundos en cada zona de FC del reloj (Z1..Z5, JSON [s1,s2,s3,s4,s5]),
--    para el reparto suave / medio / duro de cada semana («~80 % fácil»). Una
--    llamada por actividad: se rellena poco a poco, de lo nuevo a lo viejo y
--    solo en la ventana reciente que pide el cron.
ALTER TABLE g_actividades ADD COLUMN humedad_clima REAL;
ALTER TABLE g_actividades ADD COLUMN sensacion_clima REAL;
ALTER TABLE g_actividades ADD COLUMN zonas_fc TEXT;
-- NULL (sin pedir) | hecho | sin_datos | error
ALTER TABLE g_actividades ADD COLUMN zonas_estado TEXT;
ALTER TABLE g_actividades ADD COLUMN zonas_intentos INTEGER NOT NULL DEFAULT 0;
CREATE INDEX g_actividades_zonas ON g_actividades (zonas_estado, zonas_intentos, fecha);
UPDATE g_actividades SET clima_estado = 'pendiente' WHERE clima_estado = 'hecho';
