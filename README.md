# Entrenador en Claude

Un entrenador personal de running, fuerza y natación que vive en **Claude**. Lee tu
**Garmin**, guarda los acuerdos en un **contrato con memoria** y escribe cada sesión
directamente en tu reloj. Viene con **zancada**, un panel web para mirar desde el
móvil cómo vas.

Cada persona lo instala en **su propia cuenta de Cloudflare** (el plan gratuito
basta). Tus datos de sueño, pulso y lesiones no pasan por la instalación de nadie
más.

> En español. Hecho para una persona por instalación. Garmin es la fuente de
> datos; intervals.icu es opcional.

## Qué hace

- **Programa contigo, no por ti.** Antes de proponer nada lee tus datos reales:
  sueño, VFC, FC en reposo, carga, marcas y lo que hiciste ayer. Si algo no se
  pudo leer, lo dice y no programa encima.
- **Escribe las sesiones en tu reloj**, paso a paso (calentamiento, bloque, vuelta
  a la calma), con objetivos de ritmo o pulso calculados con *tus* umbrales.
- **Recuerda lo acordado.** Reglas, carreras, pendientes y el nivel de cada lesión
  viven en un contrato versionado: cada cambio es un commit con su porqué, y el
  historial no se borra.
- **Respeta tus límites médicos.** Una lesión se guarda como **regla protegida**:
  el servidor no deja cambiarla sin tu frase textual, ni siquiera si insistes un
  día bueno.
- **Lleva un diario** de lo que Garmin no mide (dolor 0-10, síntomas) y lo cruza
  con la carga.
- **Te enseña cómo vas** en el panel zancada: qué toca hoy, cómo amaneciste frente
  a tu normal, la semana, tu progreso y el contrato. Solo lectura: todo se escribe
  hablando con Claude.

```text
 Reloj Garmin ─► Garmin Connect ◄──────────┐
                                           │ lee datos, escribe sesiones
 Claude (proyecto «Entrenador») ── MCP ──► Tu Worker en Cloudflare ──► D1
                                           │  histórico de Garmin · contrato
 Móvil (panel zancada) ──── solo lectura ──┘  diario · material
```

## Empezar

1. **[INSTALAR.md](INSTALAR.md)**: unos 30 minutos. Necesitas un reloj Garmin, una
   cuenta de Claude que admita conectores personalizados, una cuenta de Cloudflare
   y un ordenador con git y Node 22 o más.
2. En **[entrenador/](entrenador/)** está lo que se pega en el proyecto de Claude:
   la **constitución** (cómo trabaja el entrenador, igual para todos) y una
   **plantilla de perfil** (tu entorno y tus objetivos).
3. Primera conversación: «Hola, empecemos». El entrenador ve el contrato vacío, te
   entrevista y escribe la primera semana.

## El día a día

| | |
|---|---|
| **Por la mañana** | Abre el panel: qué toca hoy, cómo amaneciste frente a tus últimos 120 días y qué límite manda. |
| **Antes de entrenar** | Carga la sesión desde el menú de entrenos del reloj. Si no, el reloj graba una actividad suelta y no sigue los pasos. |
| **Después** | Cuéntale a Claude cómo fue y, si tienes una lesión, el dolor: el mismo día y a las 48 h. Él lo apunta. |
| **La noche anterior** | La sesión siguiente queda escrita. Nunca más de 7 días por delante. |

## Privacidad y seguridad

- **Tus datos viven en tu D1 y en tu Garmin.** El repositorio no lleva datos de
  ningún atleta: tu perfil va en tu proyecto de Claude, y tu configuración
  (`wrangler.jsonc`) no se sube.
- **La URL del conector es una credencial**: quien la tenga lee y escribe tu
  contrato. Guárdala como una contraseña.
- **La contraseña de Garmin no se guarda nunca.** Se usa para enlazar y se
  olvida; lo que se guarda es el token, cifrado con una clave que no vive en la
  base de datos.
- **El panel no puede cambiar el contrato, el diario ni el material.** Una
  cookie robada no reescribe tus acuerdos.
- ¿Encontraste un fallo de seguridad? Mira [SECURITY.md](SECURITY.md) antes de
  abrir un issue.

## Límites conocidos

- **Garmin no tiene API pública.** La conexión usa la misma vía que su app móvil.
  Si Garmin cambia su login, puede romperse hasta que se actualice el código. Las
  cuentas con verificación en dos pasos todavía no se pueden enlazar.
- **Una instalación, un atleta.** Si alguien más quiere el entrenador, que instale
  el suyo.
- **Solo en español**, de momento: la constitución, el panel y los mensajes.
- **No es consejo médico.** Es una herramienta para entrenar con criterio; ante
  una lesión que no mejora, al médico.

## Documentación

| | |
|---|---|
| [INSTALAR.md](INSTALAR.md) | Instalación paso a paso y cómo actualizar |
| [entrenador/](entrenador/) | Constitución y plantilla de perfil para el proyecto de Claude |
| [docs/referencia.md](docs/referencia.md) | Herramientas MCP, contrato, diario, histórico de Garmin, panel, despliegue a mano, notas de diseño |
| [docs/garmin.md](docs/garmin.md) | Cómo se habla con Garmin sin API pública y por qué funciona |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Cómo proponer cambios |

## Desarrollo

```sh
npm install
npm run check   # tipos
npm test        # unitarios
npm run e2e     # end-to-end sin red ni credenciales: stub + wrangler dev + D1 local
```

Cloudflare Workers + [Hono](https://hono.dev) + D1, TypeScript sin más
dependencias en producción. El servidor MCP (streamable HTTP, sin estado) está
escrito a mano en `src/mcp/server.ts`.

## Licencia

[PolyForm Noncommercial 1.0.0](LICENSE): puedes usarlo, estudiarlo, modificarlo y
compartirlo **para fines no comerciales** (uso personal, aficionados, educación,
investigación, organizaciones sin ánimo de lucro). Para cualquier uso comercial,
pregunta antes. El código y las tipografías de terceros conservan sus licencias:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Proyecto independiente: no está afiliado a Garmin, Anthropic ni intervals.icu.
