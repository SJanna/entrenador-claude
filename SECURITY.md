# Seguridad

## Cómo avisar de un fallo

**No abras un issue público.** Usa el aviso privado de GitHub: pestaña
**Security → Report a vulnerability** de este repositorio. Llega solo a quien lo
mantiene.

Cuenta qué encontraste, cómo reproducirlo y qué podría hacer alguien con él. No
incluyas datos reales de ninguna persona ni credenciales vivas.

Respondo en cuanto pueda, normalmente en unos días. Si el fallo se confirma, se
arregla, se publica la corrección y, si quieres, se reconoce tu aviso.

## Qué es sensible en una instalación

Cada persona tiene su propia instalación. Lo que protege sus datos:

| Pieza | Qué abre | Dónde vive |
|---|---|---|
| URL del conector MCP (`MCP_SECRET_PATH`) | Leer y escribir el contrato y el diario; escribir entrenos en Garmin | Secreto de Cloudflare; ajustes de Claude |
| Contraseña del panel (`APP_PASSWORD`) | Ver el panel, enlazar o soltar Garmin y, si existe, publicar la página pública | Secreto de Cloudflare |
| `SESSION_SECRET` | Firma las cookies y deriva la clave que cifra el token de Garmin | Secreto de Cloudflare |
| Token de Garmin | Leer la cuenta de Garmin y escribir entrenos | Cifrado (AES-GCM) en D1 |
| `INTERVALS_API_KEY` (opcional) | La cuenta de intervals.icu | Secreto de Cloudflare |

La contraseña de Garmin no se guarda nunca. Si crees que alguna de estas piezas se
filtró: rota el secreto (`npx wrangler secret put …`), cambia la URL del conector
en Claude y, si fue `SESSION_SECRET`, vuelve a enlazar Garmin.

## Fuera de alcance

- Fallos de Garmin Connect, Cloudflare, Claude o intervals.icu: avisa a cada uno.
- Que Garmin cambie su login y la conexión deje de funcionar: es un límite
  conocido, ábrelo como issue normal.
