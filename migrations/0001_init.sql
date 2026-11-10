-- Esquema del contrato de entrenamiento. La app es la fuente de verdad:
-- esto reemplaza la zona de sistema 2099 del calendario de intervals.icu.

-- Metadatos del contrato: versión y fecha del último commit.
CREATE TABLE meta (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
INSERT INTO meta (clave, valor) VALUES ('version', '0');
INSERT INTO meta (clave, valor) VALUES ('ultimo_commit', '');

-- Reglas vigentes del contrato ([SYS/CONTRATO]).
CREATE TABLE reglas (
  id TEXT PRIMARY KEY,                -- R001, R002…
  tema TEXT NOT NULL,
  contenido TEXT NOT NULL,
  vence TEXT,                         -- YYYY-MM-DD, o NULL = nunca
  estado TEXT NOT NULL DEFAULT 'activa',  -- activa | retirada | expirada
  creada_en TEXT NOT NULL,            -- fecha del acuerdo
  creada_version INTEGER NOT NULL,
  finalizada_en TEXT,
  finalizada_version INTEGER,
  motivo_baja TEXT
);

-- Estado vivo ([SYS/ESTADO]): nivel de una lesión, bloque, flags…
CREATE TABLE estado (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

-- Registro append-only ([LOG]). NUNCA se actualiza ni se borra:
-- el código solo hace INSERT y SELECT sobre esta tabla.
CREATE TABLE log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,                -- día del acuerdo (YYYY-MM-DD)
  version INTEGER,                    -- versión del contrato tras este commit
  mensaje TEXT NOT NULL,
  detalles TEXT,                      -- JSON con los cambios estructurados
  creado_en TEXT NOT NULL             -- timestamp ISO de escritura
);
CREATE INDEX idx_log_fecha ON log (fecha);

-- Backlog ([SYS/PENDIENTES]).
CREATE TABLE pendientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  texto TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'abierto',  -- abierto | resuelto
  creado_en TEXT NOT NULL,
  resuelto_en TEXT
);

-- Disparadores en fecha futura ([REVISAR]).
CREATE TABLE disparadores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,                -- YYYY-MM-DD
  accion TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | completado | cancelado
  creado_en TEXT NOT NULL,
  finalizado_en TEXT
);
CREATE INDEX idx_disparadores_fecha ON disparadores (fecha);

-- Condiciones especiales ([NOTA]): viaje, molestia, semana intensa…
CREATE TABLE condiciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  texto TEXT NOT NULL,
  desde TEXT,                         -- YYYY-MM-DD (NULL = desde ya)
  hasta TEXT,                         -- YYYY-MM-DD (NULL = sin fecha de fin)
  estado TEXT NOT NULL DEFAULT 'activa',   -- activa | cerrada
  creado_en TEXT NOT NULL,
  cerrado_en TEXT
);

-- Objetivos con fecha: carreras y eventos. La jerarquía cambia con el calendario.
CREATE TABLE carreras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  fecha TEXT,                         -- YYYY-MM-DD
  distancia_km REAL,
  desnivel_m INTEGER,
  prioridad TEXT,                     -- A | B | C
  estado TEXT NOT NULL DEFAULT 'candidata', -- candidata | confirmada | completada | cancelada
  resultado TEXT,
  notas TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
CREATE INDEX idx_carreras_fecha ON carreras (fecha);
