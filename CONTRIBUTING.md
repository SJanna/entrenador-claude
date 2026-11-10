# Cómo contribuir

Gracias por querer mejorar el entrenador. Este documento dice cómo proponer
cambios para que lleguen rápido y sin sustos. Si algo no está claro, abre un
issue y pregunta.

## Antes de empezar

- **Para un cambio grande, abre antes un issue.** Una herramienta nueva, un
  cambio en el contrato o en la constitución, un módulo opcional: mejor acordar el
  enfoque antes de escribir mil líneas.
- **Para un error, cuenta cómo reproducirlo** con la plantilla de issue. Nunca
  pegues datos reales tuyos (ver *Datos personales*, abajo).
- **Para un fallo de seguridad, no abras un issue**: sigue [SECURITY.md](SECURITY.md).
- El proyecto, el código, los comentarios y la documentación están **en
  español**. Los issues y PR también; si no escribes español, adelante en inglés y
  lo resolvemos.

## Montar el entorno

```sh
git clone <este repositorio> && cd <carpeta>
npm install
npm run check   # tipos (tsc)
npm test        # unitarios (vitest)
npm run e2e     # end-to-end: stub de intervals.icu + wrangler dev + D1 local
```

No hace falta cuenta de Cloudflare ni de Garmin para desarrollar: el e2e corre
sin red y con la plantilla `wrangler.example.jsonc`. Para el panel,
`node scripts/captura.mjs` saca capturas de todas las pantallas con datos de
mentira (usa el Chrome del sistema o `CHROMIUM_PATH`).

## Las reglas

### Datos personales: nunca en el repositorio

Es la regla que más importa. Este repositorio es público y lo que entra en un
commit se queda en el historial para siempre.

- **Ni datos de salud, ni nombres, ni lugares, ni ids de cuentas** en código,
  tests, fixtures, capturas ni mensajes de commit. Los ejemplos se inventan: «Dolor
  del tobillo», «Trail de la Sierra», «Ciudad - Rodaje 40 min».
- **Tu configuración no se sube.** `wrangler.jsonc` y `.dev.vars` están en
  `.gitignore`; la plantilla es `wrangler.example.jsonc`.
- **Nada de secretos**, ni de prueba que se parezcan a uno real: usa valores que
  se lean como falsos (`contrasena-e2e`, `clave-de-prueba`).
- El perfil del atleta vive en su proyecto de Claude, no aquí.

### Base de datos

- **Una migración nunca se edita** una vez fusionada: cada cambio es un fichero
  nuevo en `migrations/`, numerado. Las instalaciones vivas ya la aplicaron.
- **Solo se añade**: tablas o columnas nullable. Así una migración se puede
  aplicar antes de desplegar el código sin romper el que sigue vivo.
- **El código tolera una base atrasada**: si una columna falta, se apaga lo que
  la usa y se dice; no se cae la lectura del contrato. Hay tests que montan la
  base parada en una migración vieja (`test/apoyo-d1.mjs`).
- En la descripción del PR, di si trae migración. Se aplica **antes** de
  desplegar.

### El contrato y las reglas protegidas

- El log es **append-only**: no hay ruta que lo edite, y no la añadas.
- Una regla protegida solo cambia con la frase textual del atleta. No añadas
  caminos que la rodeen (una regla nueva que la contradiga, un estado que suba el
  nivel de una lesión sin sus condiciones).

### Garmin

- No hay API pública: cada endpoint nuevo se comprueba con datos reales y se fija
  con un test sobre una respuesta grabada **y anonimizada**.
- Respeta el presupuesto de llamadas. Garmin limita por IP y las de Cloudflare
  son compartidas: un bucle que reintenta tumba la instalación de todos.
- **Las unidades se comprueban, no se suponen.** Un número plausible y falso no
  da error (8 kg escritos como 8.000 «gramos» dieron 8 toneladas en el reloj).

### Herramientas MCP

- Cada respuesta dice qué no pudo leer. Un hueco nunca se convierte en un cero.
- La descripción de la herramienta es lo que lee el modelo: que diga cuándo
  usarla y qué no hace.
- Si una herramienta pertenece a un módulo opcional, regístrala en ese módulo
  (`src/tools/registry.ts`): el servidor no anuncia lo que no está instalado.

### El panel

- **Solo lectura.** Lo que se escribe, se escribe hablando con el entrenador.
- Identidad en `src/web/estilo.ts`: arena y tinta, mar/coral/sol, Bungee,
  Silkscreen e Inter, iconos pixel de 12×12. Sin dependencias de CDN.
- El JavaScript va en un `String.raw`: sin comillas invertidas, sin `${` y sin la
  etiqueta de cierre del script. `test/panel.test.ts` lo vigila.
- Texto sobre fondo con contraste de 4,5:1 en los dos temas.

### Estilo

- TypeScript estricto; `npm run check` limpio.
- Los comentarios explican **por qué**, no qué. Si un cambio viene de un fallo
  real, cuéntalo en el comentario: es lo que evita repetirlo.
- Sin dependencias nuevas en producción salvo que sea imprescindible: dilo en el
  PR y explica por qué.

## El pull request

1. Una rama por cambio, desde `main`.
2. `npm run check`, `npm test` y `npm run e2e` en verde (CI los corre igual).
3. Tests para lo nuevo; para un error, un test que fallaba antes.
4. Mensajes de commit en español, en presente y diciendo qué cambia y por qué
   («Panel: semana y progreso sin 404»).
5. Rellena la plantilla del PR, incluida la casilla de datos personales.

Revisaré cuanto antes. Puede que pida cambios: no es nada personal, es para que el
proyecto siga siendo fácil de mantener.

## Licencia de las contribuciones

El proyecto se distribuye bajo la [PolyForm Noncommercial 1.0.0](LICENSE). Al
abrir un PR aceptas que tu contribución se distribuya bajo esa misma licencia, y
confirmas que tienes derecho a aportarla.

## Convivencia

Trato respetuoso y sin ataques personales. Se discuten ideas, no personas. Quien
no respete esto puede quedar fuera del proyecto.
