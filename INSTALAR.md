# Instalar tu propio entrenador

Un entrenador de running y fuerza que vive en Claude: lee tu Garmin, guarda los acuerdos en un contrato con memoria y te escribe las sesiones directamente en el reloj. Cada persona lo instala en **su propia cuenta de Cloudflare**: los datos (sueño, pulso, lesiones) son tuyos y no pasan por la instalación de nadie más.

**Tiempo:** unos 30 minutos. **Coste:** 0 (plan gratuito de Cloudflare). **Necesitas:** un reloj Garmin, una cuenta de Claude con conectores personalizados, Node 22 o más y una cuenta de Cloudflare.

intervals.icu es **opcional**: el entrenador funciona entero solo con Garmin.

---

## 1. Desplegar (una vez)

```sh
git clone <este repositorio> entrenador && cd entrenador
npm install
npx wrangler login          # abre el navegador: entra en TU cuenta de Cloudflare
npm run instalar
```

El instalador crea la base de datos, escribe tu `wrangler.jsonc` (no se sube al repositorio: lleva los ids de tu base), aplica las migraciones, despliega, genera los secretos y al final te enseña **dos cosas que tienes que guardar**: la contraseña del panel y la URL del conector. Esa URL es una credencial: quien la tenga puede leer y escribir tu contrato.

¿Quieres ver antes qué va a hacer? `npm run instalar -- --simular`.

## 2. Enlazar Garmin

Abre `https://…workers.dev/app`, entra con la contraseña del panel y, en **Más → Garmin Connect**, enlaza tu cuenta de Garmin.

- La contraseña de Garmin **no se guarda**: se usa para enlazar y se olvida. Lo que se guarda es el token, cifrado.
- Si tu cuenta tiene **verificación en dos pasos**, el enlace todavía no la soporta y te lo dirá.
- Desde ese momento, un cron va llenando cada hora tu **histórico** (actividades, series, bienestar de 120 días, peso) sin pasarse del límite de Garmin. La carga inicial tarda uno o dos días en el plan gratuito (en el de pago, sube `HISTORICO_PRESUPUESTO`); mientras tanto, el entrenador marca como provisional lo que dependa de ella.

## 3. Conectar a Claude

1. Claude → Ajustes → Conectores → **Añadir conector personalizado**. Pega la URL del conector.
2. Crea un **proyecto** («Entrenador»). En sus instrucciones pega:
   - [`entrenador/constitucion.md`](entrenador/constitucion.md), entero;
   - debajo, **tu perfil**: copia [`entrenador/perfil-plantilla.md`](entrenador/perfil-plantilla.md) y rellénalo. Corto: se lee en cada conversación.

## 4. Primera conversación

Escribe «Hola, empecemos». El contrato está vacío y el servidor le da al entrenador un **guion de arranque**: te entrevista por bloques (lesiones, objetivos, agenda, material, cómo quieres que te programe), lee tus marcas y bandas reales, escribe el contrato v1 y te propone la primera semana.

**Si tienes una lesión u operación, díselo aquí.** Se escribe como **regla protegida**: el servidor no deja cambiarla sin tu frase textual, ni siquiera aunque tú insistas un día bueno en otra conversación.

---

## Lo que conviene saber

| Tema | Qué pasa |
|---|---|
| Antes de programar | El entrenador llama a `briefing`, que lee todo en una vez y marca los días de la próxima semana sin sesión. Si algo no se pudo leer, lo dice y no programa encima |
| Sesiones | Se escriben en Garmin y se verifican releyéndolas. Para que el reloj las siga, **cárgalas desde el menú de entrenos del reloj** |
| Histórico | CTL/ATL/TSB en la escala de carga de Garmin, mejores marcas sacadas de las series, desacople aeróbico de las tiradas largas y bandas de bienestar. Todo empieza diciendo cuántos datos hay detrás |
| Diario | Dolor 0-10, síntomas y notas: lo que Garmin no mide. Es el sensor de cualquier lesión |
| Panel web | «zancada»: hoy, semana, progreso, contrato y más, todo con datos de Garmin, el contrato y el diario. Ábrelo en el móvil y añádelo a la pantalla de inicio |
| Garmin no oficial | La conexión usa la misma vía que la app de Garmin, no una API pública. Si Garmin cambia su login, puede romperse hasta que se actualice el código |
| Actualizar | `git pull`, después `npm run db:migrate` (la migración **siempre antes** que el código) y `npm run deploy`. Tu `wrangler.jsonc` no se toca: no está en el repositorio |

## intervals.icu (opcional)

Si ya lo usas, puedes conectarlo como respaldo: el instalador lo pregunta, o más tarde pon `INTERVALS_ATHLETE_ID` en `wrangler.jsonc` y `npx wrangler secret put INTERVALS_API_KEY`. Con él aparecen sus herramientas (histórico de intervals, su calendario, rampas dentro de un paso), pero **Garmin sigue mandando**.

## Privacidad

- Tus datos viven en tu D1 y en tu Garmin. Nadie más los ve.
- El repositorio no lleva datos de ningún atleta: tu perfil va en tu proyecto de Claude, no aquí.
- Tu instalación solo la usas tú: si alguien más quiere el entrenador, que se instale el suyo.
