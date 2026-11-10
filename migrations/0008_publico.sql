-- Página pública de progreso (opcional): lo que hace falta para calcular los agregados que
-- se publican, y nada más.
--
-- Aquí no hay ni un dato crudo publicable: el cron lee intervals.icu y Garmin,
-- calcula, pasa el resultado por una lista blanca (src/publico/esquema.ts) y
-- solo entonces lo escribe en KV, que es lo único que ve la página. Estas
-- tablas son la parte privada de ese cálculo.

-- Temporadas: se mueven si falla un gate, así que viven aquí y no en el código.
-- Contiguas y sin huecos; la 4 termina el día D (lo comprueba el código).
CREATE TABLE publico_temporadas (
  numero INTEGER PRIMARY KEY CHECK (numero BETWEEN 0 AND 4),
  nombre TEXT NOT NULL,
  desde TEXT NOT NULL,                -- YYYY-MM-DD
  hasta TEXT NOT NULL,                -- YYYY-MM-DD, incluido
  actualizado_en TEXT NOT NULL
);
INSERT INTO publico_temporadas (numero, nombre, desde, hasta, actualizado_en) VALUES
  (0, 'Prólogo',     '2026-11-03', '2026-12-13', '2026-10-22T00:00:00.000Z'),
  (1, 'Base',        '2026-12-14', '2027-02-28', '2026-10-22T00:00:00.000Z'),
  (2, 'Durabilidad', '2027-03-01', '2027-05-31', '2026-10-22T00:00:00.000Z'),
  (3, 'Específica',  '2027-06-01', '2027-07-31', '2026-10-22T00:00:00.000Z'),
  (4, 'Día D',       '2027-08-01', '2027-08-21', '2026-10-22T00:00:00.000Z');

-- Ajustes sueltos: el día D, hasta qué día llega el cumplimiento leído de Garmin.
CREATE TABLE publico_config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
INSERT INTO publico_config (clave, valor, actualizado_en) VALUES
  ('dia_d', '2027-08-21', '2026-10-22T00:00:00.000Z');

-- Km de carrera planificados por semana (lunes). Se CONGELAN el lunes: si la
-- semana cambia a mitad, la gráfica sigue enseñando el plan original. Si no,
-- planificado y real acaban siendo iguales y la gráfica no dice nada.
CREATE TABLE publico_plan_semanal (
  lunes TEXT PRIMARY KEY,
  km REAL NOT NULL CHECK (km >= 0),
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

-- Hitos que no se deducen de una distancia (la primera salida de noche) o que
-- el GPS no dejó caer solos (un maratón medido en 42,1 km).
CREATE TABLE publico_hitos_manuales (
  clave TEXT PRIMARY KEY,
  fecha TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

-- Sesiones programadas en Garmin que cuentan para el % (carrera, fuerza y
-- natación), una fila por cita del calendario. El plan de un día se guarda al
-- empezar ese día (cron de las 03:00) y no se borra aunque desaparezca de Garmin
-- después: una sesión fallada que se quita del calendario sigue siendo una
-- sesión fallada, y borrar un entreno de la biblioteca borra sus citas pasadas.
-- Sin nombre ni lugar a propósito: solo lo que hace falta para contar.
CREATE TABLE publico_programadas (
  programacion TEXT PRIMARY KEY,      -- id de la cita en Garmin
  fecha TEXT NOT NULL,
  categoria TEXT NOT NULL,            -- carrera | fuerza | natacion
  segundos INTEGER,                   -- duración estimada del entreno (NULL = sin dato)
  cumplida INTEGER NOT NULL DEFAULT 0,
  actualizado_en TEXT NOT NULL
);
CREATE INDEX idx_publico_programadas_fecha ON publico_programadas (fecha);

-- Lo que se calculó cada día, publicado o no. Sirve para comparar y para
-- saber qué vio la gente un día concreto.
CREATE TABLE publico_snapshots (
  fecha TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  publicado INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL
);
