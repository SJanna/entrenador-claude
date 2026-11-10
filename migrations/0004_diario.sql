-- Diario subjetivo propio: lo que intervals.icu no mide y su API no deja crear
-- desde fuera.
--
-- intervals.icu tiene campos de bienestar personalizados, pero solo se definen
-- a mano en su web y su API no publica ni las definiciones ni un error cuando
-- escribes uno que no existe: se descarta EN SILENCIO. Para el dolor de una lesión
-- eso es inaceptable —creerías tener una serie y tendrías una fila de huecos—,
-- así que el diario vive aquí, que es de lo que va esta app.
--
-- Dos tablas a propósito:
--   · `diario_campos` DECLARA qué se mide y en qué escala;
--   · `diario` guarda los valores, uno por día y campo.
-- Escribir un campo sin declarar es un error, no un dato perdido: una errata en
-- el nombre no puede crear una serie fantasma que luego parezca falta de datos.
--
-- El histórico es del atleta y no se recalcula solo: aquí no hay caché de nada
-- de intervals.icu, al revés que en `dias_resumen`. Borrar una fila borra una
-- medición real.

CREATE TABLE diario_campos (
  campo TEXT PRIMARY KEY,               -- clave estable: minúsculas y guion bajo
  etiqueta TEXT NOT NULL,               -- cabecera con la que sale en las tablas
  tipo TEXT NOT NULL,                   -- numero | si_no | texto
  minimo REAL,                          -- solo para 'numero'; NULL = sin tope
  maximo REAL,
  descripcion TEXT NOT NULL DEFAULT '', -- qué significa el 0 y qué el 10
  creado_en TEXT NOT NULL
);

CREATE TABLE diario (
  fecha TEXT NOT NULL,                  -- YYYY-MM-DD en la zona del atleta
  campo TEXT NOT NULL REFERENCES diario_campos(campo) ON DELETE CASCADE,
  valor REAL,                           -- número, o 0/1 en los si_no
  texto TEXT,                           -- solo para tipo 'texto'
  actualizado_en TEXT NOT NULL,
  PRIMARY KEY (fecha, campo)
);

-- Leer una serie entera de un campo ("dolor_tobillo de los últimos 90 días") es
-- la consulta que más se va a hacer, y sin esto barre la tabla completa.
CREATE INDEX idx_diario_campo_fecha ON diario (campo, fecha);
