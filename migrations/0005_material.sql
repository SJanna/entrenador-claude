-- Inventario de material por categorías: lo que el atleta TIENE.
--
-- Existe porque prescribir sin saber qué hay es adivinar. Cuando se pide
-- "terapia para el tobillo", la diferencia entre una recomendación aplicable y
-- una genérica es saber si hay pistola de masaje, bandas elásticas y hielo, o
-- solo una pelota de tenis.
--
-- Hasta ahora el material vivía como pares clave:valor en el `estado` del
-- contrato, que no distingue categorías ni permite retirar nada sin borrarlo.
--
-- Por qué no en intervals.icu: su `gear` solo entiende zapatillas y bicis con
-- kilómetros. Un rodillo de espuma o una bolsa de hielo no caben ahí, y la
-- mitad del inventario que importa para la recuperación se quedaría fuera.
--
-- `categoria` es una clave normalizada (running, fuerza, recuperacion) y
-- `categoria_etiqueta` es cómo se escribe de verdad ("Recuperación"). Se separan
-- para que "Recuperación" y "recuperacion" caigan en el mismo grupo: si se
-- fragmentaran, una consulta por categoría devolvería media estantería y
-- parecería la estantería entera.
CREATE TABLE material (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  categoria TEXT NOT NULL,
  categoria_etiqueta TEXT NOT NULL,
  nombre TEXT NOT NULL,
  -- Para qué sirve, no solo qué es: es lo que se lee al buscar con qué hacer
  -- una terapia o qué llevar a una sesión.
  detalle TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'disponible',   -- disponible | retirado
  desde TEXT,                                  -- YYYY-MM-DD, opcional
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  -- Dos cosas con el mismo nombre en la misma categoría son la misma cosa
  -- apuntada dos veces. El alta se convierte en actualización en vez de
  -- duplicar, y así reaparecer algo retirado no obliga a inventarle otro nombre.
  UNIQUE (categoria, nombre)
);

CREATE INDEX idx_material_categoria ON material (categoria, estado, nombre);
