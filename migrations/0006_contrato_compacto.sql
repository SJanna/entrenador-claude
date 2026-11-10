-- Vista compacta del contrato y freno al crecimiento.
--
-- El 03/09/2026 get_contract devolvía 185.000 caracteres: ya no cabía en una
-- lectura y el entrenador pasó a buscar dentro con grep, saltándose reglas
-- vigentes. Tres causas de diseño: solo las reglas caducaban solas, todo se
-- escribía dos veces (en el log y otra vez en el estado) y nadie veía el
-- tamaño crecer. Esta migración da soporte de esquema a las tres correcciones;
-- los límites de longitud y la vista compacta viven en el código.
--
-- Todo nullable y sin tocar una sola fila: los datos de producción se leen
-- igual antes y después. Cuando `resumen` es NULL la vista compacta enseña el
-- principio de `contenido`/`texto` recortado, y el modelo lo va rellenando con
-- el uso normal (reglas → modificar, pendientes → actualizar).

-- Reglas: `resumen` es el mandato operativo (qué hacer); `contenido` guarda el
-- porqué, el precedente y el razonamiento, y solo se lee bajo demanda.
ALTER TABLE reglas ADD COLUMN resumen TEXT;

-- Pendientes: mismo par resumen/texto, más `vence` (caducan solas como las
-- reglas) y `actualizado_en` para poder marcar los estancados. Los pendientes
-- se citan por id desde reglas y disparadores, así que `actualizar` conserva
-- el id y anota aquí cuándo se tocó por última vez (NULL = nunca: cuenta desde
-- `creado_en`).
ALTER TABLE pendientes ADD COLUMN resumen TEXT;
ALTER TABLE pendientes ADD COLUMN vence TEXT;
ALTER TABLE pendientes ADD COLUMN actualizado_en TEXT;
