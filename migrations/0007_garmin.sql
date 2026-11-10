-- La cuenta de Garmin enlazada: UNA fila, con los tokens cifrados.
--
-- Por qué hace falta guardar algo. Entrar en Garmin cuesta ~2 segundos y pasa
-- por su WAF; hacerlo en cada petición sería lento y, sobre todo, la vía más
-- rápida de que Garmin nos meta en su cubo de rate-limit (las IPs de salida de
-- Cloudflare son compartidas). Así que se entra UNA vez y se vive del
-- `refresh_token`, que dura meses.
--
-- Por qué cifrado. Un `access_token` de Garmin abre la cuenta entera: sueño,
-- ubicaciones de las actividades, peso. En texto plano, cualquiera con una
-- lectura de esta base —una copia de seguridad, un volcado, un error de
-- permisos mañana— se lleva la cuenta. La clave no vive aquí: se deriva de
-- SESSION_SECRET, que es un secreto del Worker y no de la base de datos.
--
-- La CONTRASEÑA de Garmin no se guarda nunca, ni cifrada. Se usa para el
-- enlace y se olvida en la misma petición.
CREATE TABLE garmin_cuenta (
  -- Un solo atleta, una sola cuenta: la fila 1 o ninguna.
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Sobre AES-GCM con los tokens dentro (base64url de iv‖ciphertext).
  sobre TEXT NOT NULL,
  -- Quién es, para que el panel diga a qué cuenta está enlazado sin descifrar.
  display_name TEXT NOT NULL DEFAULT '',
  -- Con qué client_id se emitió: el refresco tiene que usar el mismo.
  di_client_id TEXT NOT NULL,
  -- Caducidad del access_token en ms epoch. Fuera del sobre a propósito: así se
  -- sabe si toca refrescar sin tener que descifrar nada.
  expira_en INTEGER NOT NULL,
  enlazado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
