# Referencia técnica

Cómo está hecho por dentro y por qué. Para instalarlo, [INSTALAR.md](../INSTALAR.md);
para usarlo, el [README](../README.md).

## Herramientas MCP

El servidor solo anuncia las herramientas de lo que está instalado: decirle al
modelo que use una herramienta que no existe es otra forma de que afirme sin
leer.

**Núcleo (siempre):**

| Herramienta | Qué hace |
|---|---|
| `briefing` | El protocolo de lectura antes de programar, en **una** llamada: contrato compacto con los disparadores vencidos, bienestar y actividades recientes de Garmin, el calendario, la carga de las últimas semanas, y los días de la próxima semana **sin nada escrito**. Lo que no se pudo leer sale como `NO LEÍDO`: sobre eso no se programa. |
| `get_contract` | Contrato en **vista compacta** (una línea por entrada, con su `resumen`): versión, reglas activas (las vencidas se dan de baja solas y se registran en el log), estado, pendientes (`ESTANCADO` si llevan más de 60 días sin tocarse), disparadores, condiciones especiales, carreras con cuenta atrás y el resumen del material. Termina con la línea `[TAMAÑO]`. El detalle se pide con `detalle: "R024"` / `"#13"` / `"nivel_tobillo"` o `seccion` + `detalle: true`. |
| `contract_commit` | Commit atómico: entrada de log (append-only) + cambios estructurados (reglas, estado, pendientes, disparadores, condiciones, carreras) + subida de versión. Todo o nada. Las reglas **protegidas** solo se tocan con la frase textual del atleta en `cita_textual`. |
| `get_log` | Historial de acuerdos, más reciente primero. Nunca se edita ni se borra. |
| `get_material` / `set_material` | Inventario de lo que el atleta tiene, por categorías, con para qué sirve cada cosa. |
| `diary_set` / `diary_get` | El diario subjetivo: dolor, síntomas o cualquier escala propia, declarada antes de usarse. |
| `garmin_weekly_summary` | Volumen, carga y CTL/ATL/TSB por semana, en la escala de carga de Garmin (histórico de D1). |
| `garmin_records` | Mejores marcas por distancia y FC máxima sostenida, de **todo** el histórico. |
| `garmin_wellness_history` | Bandas de FC en reposo, VFC y sueño (mediana, p10-p90) sobre 120 días, y los últimos 14 en tabla. |
| `garmin_search_activities` | Buscar en el histórico por fechas, deporte, km o minutos, con el desacople aeróbico. |
| `garmin_streaks` | Constancia: días moviéndote, días haciendo lo que tocaba, noches de sueño y semanas cumplidas. |
| `garmin_sync` | Adelanta la carga del histórico desde Garmin, con presupuesto de llamadas. |
| `garmin_wellness` | Bienestar en vivo de Garmin (1 a 7 días): readiness, Body Battery, sueño con fases, VFC, FC en reposo, estrés y estado de entrenamiento. |
| `garmin_thresholds` | LTHR, FC máxima, FTP y ritmo de umbral, con su fuente. |
| `garmin_activities` / `garmin_activity` | Las actividades como las registró el reloj y, **en fuerza, sus series** (ejercicio, repeticiones, peso). |
| `garmin_list_calendar` | Qué hay escrito en el calendario de Garmin entre dos fechas. |
| `garmin_create_workout` / `garmin_schedule_workout` | Escribe un entreno en Garmin, paso a paso, y lo programa. |
| `garmin_get_workout` / `garmin_list_workouts` / `garmin_delete_workout` | Leer, listar y borrar entrenos de Garmin. |

**Con intervals.icu (opcional, solo si está configurado):** `get_wellness`,
`set_wellness`, `get_activities`, `search_activities`, `get_records`,
`get_activity`, `get_activity_streams`, `get_weekly_summary`, `get_streaks`,
`list_events`, `get_event`, `create_workout`, `create_note`, `update_event`,
`delete_event`, `get_athlete_settings` y `update_athlete_settings`. Con
`INTERVALS_EN_ENTRENADOR=no` el entrenador no las ve aunque intervals esté
conectado.

**Con la página pública de progreso (opcional):** `set_plan_publico`.

### Escribir entrenos en Garmin

`garmin_create_workout` escribe en Garmin y los pasos llegan al reloj tal cual.
Admite objetivos absolutos (`watts`, `bpm`, `pace`), zonas `Z1`-`Z5` y
porcentajes. Los porcentajes se convierten con umbrales **leídos, nunca
supuestos**, y la respuesta dice cuál se ha usado en cada paso
(`88-92 % de LTHR 193 ppm → 170-178 ppm`). Si falta el umbral que hace falta, el
entreno **no se escribe**: un umbral desactualizado no da error, escribe un paso
plausible y falso en el reloj.

| | Se aplica sobre |
|---|---|
| `power_pct` | FTP |
| `hr_pct` | FC de umbral (LTHR), **no** la FC máxima |
| `pace_pct` | Velocidad de umbral: **más porcentaje es más rápido** |

Las **rampas** (`ramp`) no existen en Garmin; para eso hace falta intervals.icu
(`create_workout`). Y una trampa que conviene tener presente: en `create_workout`
(intervals.icu) `"400m"` son **400 minutos** y los metros se escriben
`"400mtr"`; en `garmin_create_workout` `"400m"` son **400 metros**. Hay tests que
fijan las dos lecturas.

Después de escribir algo que importe, `garmin_get_workout`: **la duración total
no delata un paso perdido** si ese paso acababa con el botón de vuelta. Solo el
recuento de pasos lo caza, y por eso la respuesta de creación dice bloques,
pasos escritos y pasos que ejecuta el reloj.

### Fuerza

Una sesión de fuerza en intervals.icu es un bloque de minutos con una carga
estimada. El registro real —qué ejercicio, cuántas repeticiones y con cuánto
peso, serie a serie— solo está en Garmin, y es lo que hace falta para progresar
una variable cada vez. `garmin_activity` lo trae, con el volumen total sumado.

Garmin identifica los ejercicios con **enums de su catálogo** (`ROW` /
`BARBELL_ROW`), no con texto libre: el nombre que enseña el reloj sale de ahí,
no de la etiqueta. Por eso `garmin_activity` los muestra en su propia columna —
son los que hay que pasar como `category` y `exercise` al prescribir. Un paso de
fuerza acepta además `reps` y `weight_kg`.

**El peso de un paso va en kilogramos**, tal cual: el `factor: 1000` de la unidad
es su equivalencia en gramos, no un multiplicador. Se comprobó por las malas —se
pidieron 8 kg, se escribieron 8000 «gramos» y el reloj enseñó «8,000.0 kg»,
ocho toneladas, sin que nada fallara—. El peso que devuelven las series de una
actividad ya hecha sí viene en gramos; son dos APIs distintas y cada una tiene
su test.

Y el nombre que enseña el reloj en fuerza sale del enum, no de la etiqueta:
**sin `category`, el paso aparece como `--`**. La etiqueta se ve, pero debajo.
Verificado en el reloj el 16/09/2026.

### Con intervals.icu: dos calendarios

Si intervals.icu está conectado, `list_events` ve su calendario y
`garmin_list_calendar` el de Garmin. Lo programado en Garmin **no aparece en
intervals**, ni su carga entra en sus CTL/ATL proyectados. Dar por vacío un
calendario que solo está vacío en un lado es como se escribe la misma semana dos
veces: `briefing` lee los dos y marca los días que tienen algo en ambos.

### Un contrato que no crece sin freno

La vista compacta reparte un presupuesto fijo entre todas las entradas: cuantas
más hay, más estrecha es cada línea. Con 157 entradas, de una regla de 2.500
caracteres se ven 70 — sigue ahí y deja de gobernar. **Comprimir textos no
devuelve ancho; solo lo devuelve tener menos entradas**, así que:

- Un pendiente **sin `vence` caduca solo a los 90 días** de la última vez que se
  tocó. Trabajarlo lo renueva. A los 60 sale marcado `ESTANCADO` (el aviso) y en
  los últimos 14 días lleva un `⚠ CADUCA EN N DÍAS` en su propia línea, para
  poder rescatarlo. El cierre va al log, que es append-only: nada se pierde.
- El pie `⚠ SALUD` avisa de lo que cuesta cada lectura: cuántas entradas hay,
  cuántos pendientes están parados y cuándo varios disparadores se apilan en la
  misma fecha.

## El diario subjetivo

El dolor de una lesión, los síntomas o cualquier escala propia viven en la base de
datos de la app, no en intervals.icu. No es una preferencia: **la API de
intervals.icu no deja crear campos de bienestar personalizados desde fuera**
—solo se definen a mano en su web— y, lo que es peor, escribir uno que no
existe no da error: se descarta en silencio. Creerías tener una serie de dolor
y tendrías una fila de huecos.

Así que el diario es de la app, que es justo para lo que está:

- **Un campo se declara antes de usarse** (`definir` en `diary_set`), con su
  tipo (`numero`, `si_no`, `texto`), su escala y una descripción de qué
  significa el 0 y qué el 10. Escribir un campo sin declarar es un **error** y
  no guarda nada de la llamada: una errata en el nombre no puede crear una
  serie fantasma que luego parezca falta de datos. Es lo contrario de lo que
  hace intervals.icu, y es el motivo de que esto exista.
- **Las claves se normalizan** (`"Dolor del tobillo"` → `dolor_del_tobillo`), así
  que da igual cómo se escriba el mismo campo entre una conversación y otra.
- **Vacío borra, cero no.** Un `null` retira la medición del día; un `0` es un
  día sin dolor. No apuntar y apuntar cero no son lo mismo, y la tabla los
  distingue (`—` frente a `0`).
- **`diary_get` da la tabla de los últimos días** con la escala de cada campo
  (y, con intervals.icu, `get_wellness` pega esas columnas a su tabla de
  bienestar, sobre el mismo eje de fechas que el sueño y la carga). Ahí es donde una
  molestia se lee contra la carga en vez de contra el recuerdo. Debajo van la
  escala y la descripción de cada columna: un 3 sin escala no significa nada.
- Un campo declarado **sin registros en el rango** se anuncia aparte, para que
  el hueco se lea como «no se apuntó» y no como «no pasó nada».
- **Las etiquetas son únicas entre campos.** Son la cabecera con la que salen
  en la tabla de bienestar, y dos columnas llamadas igual no habría forma de
  distinguirlas. Se comprueba al declarar, contra los campos que ya existen.

Se apunta hablando con el entrenador (`diary_set`). En el panel se mira en
**Más → Diario**: los últimos catorce días de cada campo, un cuadro por día, y
un cuadro vacío es un día sin registro, no un cero.

En **Progreso**, cada campo tiene su gráfica justo debajo de la de forma y
fatiga, con el mismo periodo, para leer una encima de otra. Debajo va su
lectura: cuántos registros hay y —lo que motivó todo esto— **qué carga llevó el
día anterior a los días malos frente a los demás** (el dolor llega después). Un
sí/no se cuenta por días, no se promedia: «7 dijeron que sí» y no «media 0,7».

## El material (D1)

Qué tiene el atleta, por categorías que elige él (running, fuerza,
recuperación…), cada cosa con **para qué sirve**. Existe porque prescribir sin
saber qué hay es adivinar: cuando se pide «terapia para el tobillo», la diferencia
entre una recomendación aplicable y una genérica es saber si hay pistola de
masaje, bandas y hielo, o solo una pelota de tenis.

- **El resumen viaja dentro de `get_contract`**, una línea por categoría con los
  nombres. Una herramienta aparte que hay que acordarse de llamar no garantiza
  nada; con el inventario delante en la lectura obligatoria, sí. El detalle
  (para qué sirve cada cosa) sigue en `get_material`.
- **Con el inventario vacío, la respuesta manda preguntar**, no se queda muda:
  el modo de fallo que importa es recomendar material que no se tiene.
- **Las categorías se normalizan** igual que las claves del diario:
  «Recuperación», «recuperacion» y «RECUPERACIÓN» son la misma estantería. Si se
  fragmentaran, pedir una categoría devolvería media estantería con pinta de
  estantería entera, que es peor que no devolver nada.
- **Nada se borra, se retira.** Unas zapatillas gastadas siguen explicando los
  entrenos de hace seis meses. Y dar de alta algo que ya existe lo actualiza (y
  lo reactiva) en vez de duplicarlo.
- **Por qué no en intervals.icu**: su `gear` solo entiende zapatillas y bicis
  con kilómetros. Un rodillo de espuma o una bolsa de hielo no caben ahí, y
  justo la mitad del inventario que importa para la recuperación se quedaría
  fuera.

En el panel se ve en **Más → Material**, agrupado por categoría y con lo
retirado al final; se cambia hablando con el entrenador.

**Constancia:** `garmin_streaks` devuelve las mismas rachas que el panel y la
advertencia de que una racha viva nunca es argumento para entrenar.

## Página pública de progreso (opcional)

Un módulo para publicar **agregados** del entrenamiento en una página pública:
km por semana (real frente a planificado), la tirada más larga, hitos, % de
sesiones cumplidas y racha de semanas. Ni una hora, ni un nombre de actividad,
ni un lugar, ni coordenadas, ni salud. Hoy necesita intervals.icu para el
histórico de km.

- **Solo existe si hay un namespace KV `PUBLICO`** en `wrangler.jsonc`. Sin él,
  ni la herramienta `set_plan_publico` ni el cron de publicación se cargan.
- **El cron diario** calcula los agregados (`src/publico/`) y, si pasan la
  **lista blanca** (`src/publico/esquema.ts`), los escribe en KV. Una clave
  nueva, un texto que no sea fecha o etiqueta conocida, una salud que no sea
  `null`… y no se publica. Añadir un dato obliga a describirlo ahí, que es donde
  se revisa si filtra algo.
- **La página va aparte** (por ejemplo, Cloudflare Pages) con un binding de
  **solo lectura** a ese KV: no tiene secretos ni acceso a D1.
- `GET /app/api/publico` (detrás del login) enseña lo que se publicaría, con el
  diagnóstico de qué sesión cuenta y cuál no; `POST /app/api/publico/publicar`
  publica sin esperar al cron.

## Despliegue en Cloudflare (una vez)

Lo normal es `npm run instalar` ([INSTALAR.md](../INSTALAR.md)). Esto es lo
mismo a mano. Necesitas una cuenta de Cloudflare (el plan gratuito sobra) y Node
22 o más.

```sh
npm install
npx wrangler login                       # abre el navegador

# 1. Tu configuración: wrangler.jsonc no se sube al repo
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler d1 create intervals-pro
#    → pega el "database_id" en wrangler.jsonc y ajusta INTERVALS_TZ

# 2. Migraciones
npm run db:migrate

# 3. Secretos (te los pide por teclado, no quedan en el repo)
npx wrangler secret put MCP_SECRET_PATH     # genera uno: node -e "console.log(crypto.randomBytes(32).toString('base64url'))"
npx wrangler secret put APP_PASSWORD        # contraseña del panel web
npx wrangler secret put SESSION_SECRET      # otro aleatorio distinto, para firmar cookies

# opcional, con intervals.icu:
# npx wrangler secret put INTERVALS_API_KEY  (y INTERVALS_ATHLETE_ID en wrangler.jsonc)

# 4. Desplegar
npm run deploy
```

### Despliegue automático desde GitHub (Workers Builds)

Si tu copia del repositorio está en GitHub, Cloudflare puede desplegar sola cada
vez que llega algo a `main`. El problema es que `wrangler.jsonc` no está en el
repositorio, y Workers Builds lo necesita. Lo genera
`scripts/config-desde-entorno.mjs` a partir de unas variables que guardas en
Cloudflare: tus ids viven allí, no en git.

En Cloudflare → tu Worker → **Settings → Build**:

1. **Git repository**: conecta tu repositorio, rama `main`.
2. **Build command**: `npm run config:entorno`
3. **Deploy command**:
   `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`.
   Así las migraciones se aplican antes que el código, en el mismo paso.
4. **Build variables**:

   | Variable | Valor |
   |---|---|
   | `D1_DATABASE_ID` | el id de tu base (`npx wrangler d1 list`) |
   | `WORKER_NAME` | el nombre de tu Worker, si no es `intervals-pro` |
   | `D1_DATABASE_NAME` | el nombre de tu base, si no es `intervals-pro` |
   | `KV_PUBLICO_ID` | solo con página pública: el id del namespace |
   | `INTERVALS_TZ` | tu zona horaria, si no es `America/Bogota` |
   | `INTERVALS_ATHLETE_ID` | solo si usas intervals.icu |

El nombre del Worker que genera la configuración tiene que coincidir con el del
Worker en Cloudflare: si cambias uno, cambia el otro. Las variables del Worker
(`vars`) salen de aquí en cada despliegue; los secretos no se tocan.

### Actualizar una instalación que ya vive

**La migración va antes que el código.** Si conectas el repositorio a
Cloudflare Workers Builds, el despliegue lo dispara la llegada del código a `main`, y **las migraciones de
D1 no forman parte de ese build** salvo que el *deploy command* las incluya,
como en la sección anterior. Sin eso, «antes que el código» significa antes de fusionar, no antes de un `npm run deploy` que quizá nadie llegue a
escribir:

```sh
npm run db:migrate     # 1. la D1 remota, con el PR todavía sin fusionar
                       # 2. fusionar a main (Workers Builds despliega solo);
                       #    a mano, si no hay Workers Builds:
npm run deploy
```

Al revés, el código nuevo se encuentra una base vieja. El 04/09/2026 pasó
exactamente eso con la migración `0006`: se fusionó el PR, Workers Builds
desplegó, nadie aplicó la migración y `get_contract` respondía
`D1_ERROR: no such column: vence`, dejando al entrenador sin la lectura que el
protocolo exige antes de prescribir. Desde entonces el código **tolera un
esquema atrasado** (ver más abajo) y avisa en la cabecera del contrato en vez
de caerse, pero eso es una red de seguridad, no una excusa: mientras falte la
migración hay funciones apagadas.

Una migración solo añade columnas nullable, así que aplicarla antes de fusionar
no rompe el código viejo que sigue vivo mientras tanto: ese es el orden seguro
en los dos sentidos.

Comprueba que vive:

```sh
curl https://intervals-pro.TU-SUBDOMINIO.workers.dev/healthz
# {"status":"ok","service":"intervals-pro", …}
```

Y con tu cuenta real (solo lectura):

```sh
SMOKE_URL=https://intervals-pro.TU-SUBDOMINIO.workers.dev \
SMOKE_SECRET=EL-VALOR-DE-MCP_SECRET_PATH \
node scripts/smoke.mjs
```

## Conectar en la app de Claude

1. Ajustes → Conectores → **Añadir conector personalizado**.
2. Nombre: `Entrenador` · URL:
   `https://intervals-pro.TU-SUBDOMINIO.workers.dev/EL-VALOR-DE-MCP_SECRET_PATH/mcp`
3. Sin OAuth: queda conectado directamente.

Esa URL es una credencial: quien la tenga puede leer y escribir tu
calendario y tu contrato. La raíz y cualquier otra ruta devuelven 404.

**Mejor aún, si tu cliente deja poner cabeceras:** el mismo servidor responde
en `/mcp` autenticando con `Authorization: Bearer EL-VALOR-DE-MCP_SECRET_PATH`.
Es preferible porque las trazas del Worker registran la URL completa —y con el
secreto en la ruta, eso significa el secreto escrito en los logs—, mientras que
las cabeceras no se registran. Las dos formas conviven: cambia el conector
cuando quieras, sin prisa.

## El panel web: «zancada»

`https://intervals-pro.TU-SUBDOMINIO.workers.dev/app` → login con
`APP_PASSWORD` (cookie de 60 días).

Todo sale de **Garmin** (el histórico que el cron guarda en D1 cada hora y el
calendario de Garmin), del **contrato**, del **diario** y del **material**:
intervals.icu no entra. Identidad propia: arena y tinta, mar/coral/sol, Bungee para cifras, Silkscreen para etiquetas e
Inter para leer, tarjetas de borde grueso y teclas con sombra dura. Los tokens
viven en `src/web/estilo.ts` y las tipografías van embebidas (`/fuentes/*`,
licencia OFL): el panel no depende de ningún CDN. Modo noche automático con el
del sistema; a dos columnas desde 900 px.

Se instala en la pantalla de inicio del móvil (manifest + `display: standalone`).

El panel es **de solo lectura**: el diario, el material y los acuerdos se
escriben hablando con el entrenador (que pasa por el MCP); la web es para
mirarlos. La API del panel no escribe en el contrato, el diario ni el material,
así que una cookie robada no reescribe tus acuerdos. Desde aquí solo se enlaza
Garmin (y, si existe, se publica la página pública).

- **Hoy** responde, por este orden, a lo que se pregunta uno por la mañana:
  **qué toca hoy** (la sesión de Garmin, lo ya hecho y lo de mañana); **cómo
  amaneciste** (disposición de Garmin, sueño, VFC, FC en reposo y batería, cada
  una frente a *tu normal* de 120 días; si la FC sube o la VFC cae, la pantalla
  pregunta primero por síntomas); los **límites** (reglas protegidas y claves
  `nivel_*` del estado); los avisos vencidos del entrenador; y, en pequeño, la
  semana y la cuenta atrás. Iconos pixel de 12×12 en señales, deportes y
  navegación.
- **Semana**: los siete días con lo hecho (ritmo, desacople) y lo programado
  que queda o que se saltó; se navega semana a semana.
- **Progreso**: forma y fatiga en la escala de Garmin (4 semanas, 3 meses o un
  año), km corriendo por semana, tu normal (FC en reposo, VFC, sueño) y las
  mejores marcas de todo el histórico.
- **Contrato**: buscador; reglas (las protegidas primero), carreras,
  pendientes y disparadores, estado y condiciones.
- **Más**: Garmin (enlazar, estado de la carga del histórico), constancia
  (mismas reglas que `garmin_streaks`: un día vacío es un día perdido, no un
  descanso), diario (catorce días por campo, un cuadro por día), material e
  historial completo.

Cuando algo no se pudo leer (el calendario de Garmin, el histórico sin la
migración 0010), la pantalla lo dice en vez de enseñar un hueco que parece un
dato. `node scripts/captura.mjs` saca capturas de todas las pantallas con datos
de mentira, sin levantar wrangler.

## Migrar un contrato antiguo desde intervals.icu (una vez)

Solo para quien guardaba el contrato como notas en la «zona 2099» del
calendario de intervals.icu. Una instalación nueva no lo necesita: el contrato
empieza vacío y lo escribe el entrenador.


1. `POST /app/api/import/preview` (con la cookie del panel): lee la zona 2099
   (`[SYS/CONTRATO]`, `[SYS/ESTADO]`, `[SYS/PENDIENTES]`) y las notas
   `[LOG]`/`[NOTA]`/`[REVISAR]` del último año, y muestra qué entiende.
2. Revisa la tabla (las líneas no interpretadas se listan aparte; el texto
   crudo queda guardado en el log de importación).
3. `POST /app/api/import/apply` con esa vista previa: escribe todo en D1 en un commit. La
   numeración de versiones continúa la del snapshot antiguo (v10 → v11).
   Solo funciona sobre una base vacía, para no duplicar.
4. Pega **[entrenador/constitucion.md](../entrenador/constitucion.md)** y tu
   perfil en las instrucciones de tu proyecto de Claude.
5. Cuando confirmes que todo está, borra las notas 2099 de intervals desde
   Claude (`delete_event` con confirm) o déjalas como reliquia: ya no se leen.

## Desarrollo local y pruebas

Cada push a `main` y cada PR pasan por `.github/workflows/ci.yml`: tipos,
unitarios y el e2e completo. El e2e no necesita credenciales de Cloudflare ni
salida a internet, así que corre igual en CI que en tu portátil.

```sh
npm run check          # tipos (tsc)
npm test               # unitarios (vitest): entrenos, contrato, diario, histórico, panel…
npm run e2e            # end-to-end SIN red externa: stub de intervals + wrangler dev + D1 local
                       #   (usa wrangler.example.jsonc: no depende de tu configuración)
npm run dev            # wrangler dev con .dev.vars (copia .dev.vars.example)
npm run stub           # API falsa de intervals en :8999
node scripts/captura.mjs   # capturas del panel con datos de mentira, sin wrangler
```

## Estructura

```text
├── wrangler.example.jsonc    # plantilla; tu wrangler.jsonc (con tus ids) no se sube
├── .github/workflows/ci.yml  # tipos + unitarios + e2e en cada push
├── migrations/               # esquema de D1, una migración por cambio, nunca se editan
├── entrenador/               # constitución + plantilla de perfil: lo que se pega en Claude
├── src/
│   ├── index.ts              # rutas: /app, /login, /healthz, /mcp, /<secreto>/mcp; cron
│   ├── env.ts                # config, módulos opcionales, comparación en tiempo constante
│   ├── mcp/server.ts         # protocolo MCP streamable HTTP sin dependencias
│   ├── tools/                # registry.ts (qué herramientas existen), briefing.ts y una por módulo
│   ├── contract/             # store.ts (D1, commits atómicos, caducidad, protegidas), arranque.ts
│   ├── diario/ · material/   # stores del diario y del inventario
│   ├── garmin/               # cliente (login y refresco), almacén cifrado, bienestar,
│   │                         #   calendario, actividades, entrenos, umbrales, sonda
│   ├── historico/            # histórico de Garmin en D1: sync por tandas, CTL/ATL, marcas, bandas
│   ├── streaks/              # rachas: cálculo puro + histórico (con intervals)
│   ├── intervals/            # cliente y formato de intervals.icu (opcional)
│   ├── publico/              # página pública de progreso (opcional)
│   └── web/                  # panel «zancada»: app.ts, api.ts (solo lectura), panelDatos.ts,
│                             #   estilo.ts, fuentes.ts (OFL), login.ts, garmin.ts
├── scripts/                  # instalar.mjs, stub-intervals.mjs, smoke.mjs, captura.mjs
├── test/                     # unitarios (vitest) + e2e.mjs
└── GARMIN.md                 # cómo se habla con Garmin sin API pública, y por qué funciona
```

## El histórico de Garmin (D1)

La API de Garmin sirve ventanas cortas y limita por IP, así que la app guarda su
propio histórico (migración `0010`) y calcula sobre él:

- **Un cron horario** trae lo que falta con un presupuesto de llamadas (por
  defecto 18; `HISTORICO_PRESUPUESTO`): primero lo reciente, luego la carga
  inicial hacia atrás. En el plan gratuito, D1 admite 50 consultas por
  invocación; el presupuesto deja margen.
- **Actividades** con sus series a pie (velocidad y FC muestra a muestra), de
  las que salen las **mejores marcas** por distancia y el **desacople
  aeróbico** de las tiradas largas.
- **Bienestar de 120 días** (FC en reposo, VFC, sueño, readiness, peso) para las
  bandas de *tu normal*. Hoy se relee cada hora mientras le falten sueño o VFC.
- **CTL/ATL/TSB** con medias exponenciales de 42 y 7 días sobre la carga de
  Garmin. Durante las primeras seis semanas subestiman, y se dice.
- Todo lo que sale del histórico empieza diciendo su cobertura: si dice
  **INCOMPLETO**, lo que se saque es provisional.

## Garmin, en directo

Garmin es la fuente principal: la app habla con Garmin Connect **directamente**,
por la misma vía que su app móvil (no hay API pública).

Se enlaza la cuenta una vez, desde el panel (**Más → Garmin Connect**).
A partir de ahí se vive del `refresh_token`: el login cuesta ~2 s y pasa por la
WAF de Garmin, y como las IPs de salida de Cloudflare son compartidas, repetirlo
es la forma más rápida de acabar limitados por IP.

- **La contraseña de Garmin no se guarda nunca**, ni cifrada. Se usa para
  enlazar y se olvida en la misma petición.
- **El token sí se guarda, cifrado** (AES-GCM, migración `0007`). La clave se
  deriva de `SESSION_SECRET` con HKDF, así que no vive en la base de datos:
  quien lea D1 se lleva ruido. Rotar `SESSION_SECRET` obliga a volver a enlazar.
- `/app/garmin` trae un **diagnóstico** sin credenciales para distinguir «nos
  ha cerrado Garmin» de «nos hemos equivocado nosotros».
- Si tu cuenta pide **segundo factor**, el enlace todavía no sabe hacerlo y te
  lo dice con todas las letras en vez de fallar raro.

**[GARMIN.md](../GARMIN.md)** cuenta la historia entera: qué MCP de Garmin hay en
GitHub y cuáles siguen vivos, por qué había motivos para pensar que esto era
imposible, cómo se midió que no lo era, y qué endpoints se usan para leer
bienestar y escribir entrenos.

## El histórico de rachas de intervals.icu (opcional)

La API de intervals.icu solo sirve la ventana que le pidas, así que el resumen
día a día se materializa en D1 (`dias_resumen`, migración `0002`):

- Se guardan **agregados sin juzgar** (tiempo, la sesión más larga, carga,
  sesiones, deportes, entrenos programados, descanso explícito, sueño). Ningún
  umbral queda congelado: cambiar el mínimo de minutos reclasifica el histórico
  entero al leerlo, sin reescribir nada.
- Cada lectura pide **en vivo los últimos 21 días** (Garmin sincroniza tarde y
  las actividades se editan) y saca de D1 todo lo anterior. Lo que viene en vivo
  se persiste, así que la base se llena sola con el uso normal.
- Si D1 aún no cubre la ventana pedida, esa lectura va entera en vivo y queda
  guardada: el primer arranque no necesita backfill manual.
- El **cron diario** (`0 8 * * *` = 03:00 en Bogotá) reescribe esos 21 días
  aunque nadie abra el panel. Si intervals falla, el cron lo registra y no
  rompe nada: mañana se reintenta y las lecturas siguen yendo en vivo.
- La ventana máxima de lectura son 365 días, que es lo que la API devuelve de
  una vez. Cuando el histórico guardado sea más largo que eso, ampliarlo es
  subir ese tope y leer de D1 el tramo antiguo.

Con `npm run e2e` se prueba el camino entero contra D1 local: la segunda
lectura de la misma ventana sirve 9 días desde la base y 21 en vivo, y las
rachas salen idénticas.

## Notas de diseño

- **Commits atómicos**: `D1.batch()` es transaccional; log + cambios + versión
  entran juntos o no entra nada.
- **El log solo tiene INSERT y SELECT** en el código: no existe ruta que lo
  edite.
- **Una versión, una entrada de log** (migración `0003`): un índice único
  parcial sobre `log(version)` impide que dos commits simultáneos ocupen la
  misma versión. El que pierde recibe «vuelve a lanzar el mismo commit» y no ha
  escrito nada, porque el batch se deshace entero.
- **El contrato es corto por diseño** (migración `0006`). El 03/09/2026
  `get_contract` devolvía 185.000 caracteres, dejó de caber en una lectura y el
  entrenador pasó a buscar dentro con `grep`, saltándose reglas vigentes. Solo
  las reglas caducaban solas, el estado repetía la narrativa que ya estaba en
  el log y nadie veía el tamaño crecer. Cuatro medidas, todas en el código
  (`src/contract/store.ts` y `src/tools/contractTools.ts`), sin migrar datos:
  - **Vista compacta por defecto.** Reglas y pendientes tienen `resumen`
    (el mandato, ≤300) separado de `contenido`/`texto` (el porqué). Sin
    parámetros, `get_contract` enseña solo el `resumen`; si una entrada aún no
    lo tiene, el principio del texto recortado y marcado `…[+N]`. El ancho del
    recorte se calcula (entre 60 y 300) para que la vista entera quepa en
    15.000 caracteres. Todo texto libre —estado, disparadores próximos, notas
    de carrera— se recorta al mismo ancho; los disparadores **vencidos** van
    enteros porque hay que ejecutarlos. La cabecera dice cuántas entradas
    carecen de `resumen`.
  - **Límites duros al escribir** (`LIMITES`): estado ≤300 por clave,
    `reglas.resumen` ≤300, `reglas.contenido` ≤1.500, `pendientes.texto` y
    `resumen` ≤400, `carreras.notas` ≤600, `disparadores.accion_texto` ≤1.500.
    Superarlos rechaza el commit **entero** (se valida antes del batch) con un
    error que nombra el campo, la longitud y el límite. `mensaje` no tiene
    límite: la narrativa va al log. Lo que ya estaba en producción por encima
    del límite se sigue leyendo; solo se recorta en la vista compacta.
  - **`[TAMAÑO]` al pie de toda lectura**, con el tamaño del contrato
    completo por sección, y un aviso por encima de 60.000 en total o cuando
    una sección pasa del 35%.
  - **Muerte y mantenimiento**: `pendientes` acepta `actualizar` (conserva el
    id, que se cita desde reglas y disparadores) y `vence` (caduca solo, como
    una regla, con log y versión); pendientes y claves de estado sin tocar
    más de 60 días salen como `ESTANCADO` con su fecha; dar de alta una
    carrera con la misma fecha que otra activa devuelve un aviso.
  - **`get_log` compacto**: índice de una línea por entrada por defecto;
    `version`, `desde`/`hasta` (fechas o versiones) y `buscar` para el
    detalle. Solo lectura: el log sigue sin tener ruta de edición.
- **El código tolera una base atrasada.** Un despliegue puede adelantarse a su
  migración, y cuando eso pasa la lectura obligatoria del contrato no puede ser
  lo que se rompa. Antes de leer o escribir, el store pregunta a la base qué
  columnas tiene de verdad (`pragma_table_info`, cacheado por petición) y
  compara con `COLUMNAS_0006`:
  - **Leer siempre funciona.** Lo que falta se apaga (resúmenes, caducidad de
    pendientes, `ESTANCADO` por fecha de modificación) y `get_contract` lo dice
    en la cabecera, con la orden para arreglarlo. El resto del contrato se lee
    entero, así que se puede seguir prescribiendo.
  - **Escribir funciona para todo lo que la base sabe guardar**: las sentencias
    se construyen saltándose las columnas ausentes. Solo se rechaza —entero, y
    antes de tocar nada— el commit que pide guardar un campo imposible, con un
    error que nombra la columna y la migración en vez de un `D1_ERROR` crudo.
  - Se comprueba **columna a columna**, no «migración sí/no», porque una
    migración puede quedarse a medias.
  `test/contrato-esquema.test.mjs` monta la base parada en la `0005` con
  SQLite de verdad (`test/apoyo-d1.mjs`) y exige que el código de hoy siga
  leyendo la base de ayer.
- **Caducidad automática**: al leer el contrato, toda regla con `vence < hoy`
  pasa a `expirada` con su entrada de log y su bump de versión; los pendientes
  con `vence` se cierran igual, como `vencido`. Es una
  escritura disparada por una LECTURA, así que está escrita para tolerar
  lecturas simultáneas: el INSERT del log va condicionado a que las reglas
  sigan activas y antes de los UPDATE que las expiran, los UPDATE llevan
  `AND estado = 'activa'` y el bump de versión es monótono. Dos `get_contract` a
  la vez dan de baja la regla una sola vez.
- **Nada de esperar a lo que no hace falta**: cuando el histórico de rachas ya
  cubre la ventana pedida, reescribir los últimos días solo la refresca, así que
  va en `ctx.waitUntil` y la respuesta sale antes. La primera vez, cuando esa
  escritura sí es la que rellena la base, se espera.
- **Caché de conveniencia** (`src/cache.ts`): las lecturas de intervals se
  reutilizan 1–2 minutos dentro del mismo isolate. No se usa la Cache API
  porque en `*.workers.dev` sus operaciones son no-ops. `?fresh=1` la salta.
- **Lo que la API no tiene, y qué se hace con ello.** Comprobado contra el spec
  OpenAPI (`https://intervals.icu/api/v1/docs`), no de memoria:
  - **No existe `total_elevation_loss` por intervalo**, solo
    `total_elevation_gain`, `min/max_altitude` y `average_gradient`. El descenso
    por vuelta se deriva de la serie de altitud con un acumulador con histéresis
    (umbral 1 m; sin umbral, el ruido del barómetro convierte una llanura en
    cientos de metros). Como subida y bajada salen de métodos distintos,
    `get_activity` imprime debajo de la tabla cuánto daría la subida con el
    método de la bajada: la discrepancia se enseña, no se esconde.
  - **No existe humedad** en ninguna parte del spec. Temperatura sí
    (`average_weather_temp`, `average_feels_like`, `min/max_weather_temp`) y va
    en `get_activity`, que es lo que pide mirar antes de interpretar
    pulsaciones altas. La humedad no se puede dar y la descripción de la
    herramienta lo dice para que nadie la busque.
  - **No hay parámetro de resolución en `/streams`**: la API sirve la serie
    entera y el remuestreo lo hace el Worker, por eso `get_activity_streams`
    tiene tope de filas y aviso de recorte.
- **Las unidades de la API no son homogéneas y el spec no las declara.**
  `average_gradient` de un intervalo viene como **fracción** (0.054 = 5,4 %) y
  hay que multiplicar por 100; `decoupling`, en cambio, ya viene en
  **porcentaje** (4.2 = 4,2 %) y no se toca. Equivocarse aquí no rompe nada:
  imprime un número plausible y falso, que es la peor clase de error para algo
  que se lee como dato. `test/actividad.test.ts` fija las dos convenciones con
  un test cada una, y cualquier campo nuevo debe comprobarse contra datos
  reales antes de darle unidad.
- **Trampas de intervals.icu cubiertas** (heredadas del proyecto original):
  `m` son minutos y los metros van como `mtr`; un ritmo absoluto sin la
  palabra `pace` se descarta en silencio; si intervals no interpreta los
  pasos, la respuesta lo avisa.
- **El panel se prueba solo**: son ~1000 líneas de JavaScript dentro de un
  template string, terreno que `tsc` no pisa. `test/panel.test.ts` compila ese
  bloque con `new Function` (compila sin ejecutar), comprueba que no hay un
  `</script>` suelto que parta la página, que siguen ahí las rutas de API de las
  que depende y que no pide nada a intervals.icu.
- El endpoint MCP y el login comparan secretos en **tiempo constante**.
