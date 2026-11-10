# Garmin junto a intervals: qué hay, qué falta y qué decide

Investigación previa a tocar nada. `intervals.icu` sigue intacto: el objetivo es
que Garmin **conviva** con él, no que lo sustituya.

## El resumen

1. **Casi todos los MCP de Garmin de GitHub están tocados o muertos.** La
   librería en la que se apoyaban (`garth`) está **deprecada desde marzo de
   2026**: Garmin cambió el flujo de autenticación y su autor no tiene capacidad
   para seguirlo. Los MCP que siguen vivos lo están porque han reimplementado la
   autenticación por su cuenta.
2. **El único que funciona de verdad hoy es `Taxuspt/garmin_mcp`** (1,2k
   estrellas, commits de esta misma semana, 110+ herramientas, MFA, HTTP y
   Docker). Se apoya en `python-garminconnect`, que ya no usa `garth` y tiene
   **cinco estrategias de login** encadenadas.
3. **Y ahí está el problema para meter Garmin en este Worker:** cuatro de esas
   cinco estrategias funcionan porque **imitan la huella TLS de un navegador**
   (`curl_cffi`). Un Worker de Cloudflare no puede hacer eso: no controla su
   pila TLS. Sólo le queda la estrategia sin huella falsa, que existe como
   último recurso precisamente porque es la que más se cae.

Eso no se decidía leyendo código, sino preguntándole a Garmin desde la IP del
Worker. Ya está preguntado: **entra** (§4.1). El resto de este documento explica
por qué había motivos para temer lo contrario, y qué queda por construir.

## 1. El ecosistema, a septiembre de 2026

| Proyecto | Estrellas | Base | Estado |
| --- | --- | --- | --- |
| [`Taxuspt/garmin_mcp`](https://github.com/Taxuspt/garmin_mcp) | ~1,2k | Python · `python-garminconnect` | **Vivo.** 110+ herramientas, MFA, stdio/HTTP/SSE, Docker. Commits de septiembre de 2026 |
| [`eddmann/garmin-connect-mcp`](https://github.com/eddmann/garmin-connect-mcp) | ~63 | Python · `python-garminconnect` | Vivo, 22 herramientas, más cerrado y ordenado |
| [`brunosantos/garmin-workouts-mcp`](https://github.com/brunosantos/garmin-workouts-mcp) | ~5 | Python · `garth` | v0.1. **Escribe entrenos** y los programa en el calendario. Depende de `garth`, deprecado |
| [`epodivilov/garmin-connect-mcp`](https://github.com/epodivilov/garmin-connect-mcp) | ~6 | TypeScript · `garmin-connect` | Sin MFA documentado. Poco recorrido |
| [`RedlineTriad/garmin-connect-cloudflare-mcp`](https://github.com/RedlineTriad/garmin-connect-cloudflare-mcp) | 0 | **TypeScript · Cloudflare Workers** | La misma arquitectura que esta app. 9 herramientas de solo lectura. **Sin fichero de licencia** |

Dos avisos sobre el último, que es el que más se parece a lo que querríamos:

- No trae licencia, así que **su código no se puede copiar**. Sí se puede leer, y
  su `NOTICE.md` dice de dónde sacó el conocimiento: `garth`,
  `python-garminconnect` y `garmin-connect`, los tres MIT. De ahí es de donde
  hay que partir, y es de donde parte la sonda de este repo.
- Su propio README avisa: *«Garmin y Cloudflare limitan agresivamente el inicio
  de sesión automatizado»*, y el Worker se impone una hora de espera tras cada
  limitación. Cero estrellas: nadie ha confirmado públicamente que le funcione.

## 2. Por qué la huella TLS lo decide todo

`python-garminconnect` documenta su cadena de estrategias así:

```
1. Mobile iOS + curl_cffi  (rotación de huella TLS, sin espera)
2. Mobile iOS + requests   (HTTP normal, plan B)
3. SSO embed widget + cffi (formulario HTML, esquiva el límite por clientId)
4. Portal web + curl_cffi  (rotación de huella, espera anti-WAF de 10-20 s)
5. Portal web + requests   (HTTP normal, último recurso)
```

Y en sus constantes:

```python
# Cloudflare marca como bot las secuencias GET→POST rápidas.
LOGIN_DELAY_MIN_S = 10.0
MOBILE_IMPERSONATIONS = ("safari_ios", "safari", "chrome120")
```

Traducido: **Garmin está detrás de la WAF de Cloudflare y filtra por huella
TLS**, y las librerías que funcionan van rotando huellas de navegador hasta caer
en un cubo de rate-limit que las deje pasar.

Un Worker sólo puede hacer la estrategia 2. Además su tráfico sale de
Cloudflare hacia una web protegida por Cloudflare, lo que puede tomar rutas
internas; por eso el proyecto de RedlineTriad activa el flag
`global_fetch_strictly_public`, para forzar la salida por la Internet pública.

Hay tres resultados posibles y sólo uno se sabe probando:

- Garmin contesta con normalidad → adelante.
- Garmin **corta con un desafío antibot** → el Worker no pasa, y no hay forma de
  arreglarlo desde el Worker.
- Garmin devuelve **429** → la IP compartida de Cloudflare está quemada; puede
  ser temporal o crónico.

Ojo con leer el código HTTP a secas: **un 403 no es de por sí un muro**. La API
de Garmin devuelve 401 o 403 a cualquiera que llame sin token, y eso es la
aplicación funcionando. Quien corta de verdad se firma: Cloudflare marca lo que
bloquea con la cabecera `cf-mitigated` y sirve una página de desafío en vez del
cuerpo de la aplicación. La sonda mira eso, y qué código es normal en cada paso,
no un número suelto.

No he podido probarlo desde esta sesión: la política de red de la sesión bloquea
`sso.garmin.com` (403 al abrir el túnel). Da igual: lo que responda esta máquina
no dice nada de lo que responderá tu Worker, que es lo que importa.

## 3. Lo que ya está resuelto, si la WAF deja pasar

Todo lo demás está claro y es implementable con `fetch` y WebCrypto, sin
dependencias. Conocimiento de proyectos MIT (`python-garminconnect`, `garth`):

**Entrar** (flujo de la app de iOS, JSON puro, sin scrapear HTML):

```
POST https://sso.garmin.com/sso/mobile/api/login?clientId=GCM_IOS_DARK&locale=en-US&service=…
     {"username", "password", "rememberMe": true, "captchaToken": ""}
  → responseStatus.type: SUCCESSFUL | MFA_REQUIRED | INVALID_USERNAME_PASSWORD | CAPTCHA_REQUIRED
  → serviceTicketId: "ST-…"

POST https://diauth.garmin.com/di-oauth2-service/oauth/token
     grant_type=…/grant/service_ticket, service_ticket=ST-…, client_id=GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2
  → access_token (Bearer) + refresh_token   ← se renueva solo, sin volver a pedir la contraseña
```

**Leer bienestar** — lo que hoy llega tarde o incompleto vía intervals:

| Dato | Endpoint (`connectapi.garmin.com`) |
| --- | --- |
| Pasos, FC, estrés, Body Battery | `/usersummary-service/usersummary/daily/{usuario}?calendarDate=` |
| Sueño (fases, puntuación, SpO2) | `/wellness-service/wellness/dailySleepData/{usuario}?date=` |
| Training readiness | `/metrics-service/metrics/trainingreadiness/{fecha}` |
| Training status y carga | `/metrics-service/metrics/trainingstatus/aggregated/{fecha}` |
| HRV | `/hrv-service/hrv/{fecha}` |
| VO₂ máx | `/metrics-service/metrics/maxmet/daily/{fecha}/{fecha}` |

**Escribir entrenos** — lo que hoy se deforma al pasar por intervals:

| Acción | Endpoint |
| --- | --- |
| Crear | `POST /workout-service/workout` → devuelve `workoutId` |
| Sustituir (conserva el id y sus programaciones) | `PUT /workout-service/workout/{id}` |
| Programar en el calendario | `POST /workout-service/schedule/{workoutId}` con `{"date": "YYYY-MM-DD"}` |
| Quitar del calendario | `DELETE /workout-service/schedule/{scheduleId}` |
| Empujar al reloj ya | `POST` al servicio de mensajes del dispositivo, con `FIT` |
| Borrar | `DELETE /workout-service/workout/{id}` |

Escribir directo en Garmin significa **controlar el paso tal y como llega al
reloj**, sin el traductor de intervals por medio. Es justo el problema nº 1.

## 4. La sonda

Una página en el panel, detrás del login de siempre:

```
https://TU-WORKER/app/garmin
```

Dos botones:

1. **Eco** — tres lecturas públicas, sin credenciales. Si aquí ya sale 403, se
   acabó la conversación. No gasta intentos de login ni arriesga la cuenta.
2. **Login de verdad** — el POST del flujo de iOS con tu correo y tu contraseña.
   Las credenciales van de este Worker a Garmin y se olvidan: no se escriben en
   D1 ni en los logs, y la respuesta nunca trae el token.

Cómo se lee el veredicto:

| Veredicto | Qué significa | Qué hacer |
| --- | --- | --- |
| `enlazado` | Login completo y token válido contra la API | **Adelante**, camino abierto de punta a punta |
| `mfa` | Garmin acepta la clave y pide código | **Adelante**: la WAF deja pasar. Falta implementar el paso del código |
| `credenciales` | Contraseña incorrecta según Garmin | Camino abierto: llegó al validador. Repite con la clave buena |
| `paso-libre` | El eco pasa sin credenciales | Buena señal, no prueba: haz el login |
| `bloqueado` | 403 o captcha | Camino cerrado. Ver §6 |
| `limitado` | 429 | Espera una hora larga y repite antes de concluir |
| `protocolo` | Respuesta rara | El flujo ha cambiado; hay que revisar los endpoints |

La sonda no forma parte de la integración: es un diagnóstico y se borra entera
(`src/garmin/`, `src/web/garmin.ts`, su línea en `src/index.ts`) el día que
responda.

## 4.1. Lo medido hasta ahora

Eco del **16/09/2026**, desde el Worker en producción (con el flujo iOS
apuntando ya a `sso.garmin.com/mobile/api/login`, sin el `/sso` de más):

| Paso | HTTP | Tiempo | Lectura |
| --- | --- | --- | --- |
| Página de login (SSO) | 200 | 319 ms | Garmin sirve el login al Worker sin rechistar |
| Servicio de tokens (diauth) | 405 | 107 ms | Alcanzable: el 405 lo da la aplicación, no un muro |
| API sin token | 403 | 118 ms | Lo normal sin `Bearer`. Sin marcas de WAF |

**Veredicto del eco: `paso-libre`.** Los dos endpoints que hacen falta para
entrar responden con normalidad, y ninguna respuesta venía firmada por la WAF.

Y el login real, el mismo día, desde el mismo Worker:

| Paso | HTTP | Tiempo |
| --- | --- | --- |
| Login móvil (iOS) | 200 | 2013 ms |
| Canje del ticket (`GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2`) | 200 | 1374 ms |
| Perfil con el token | 200 | 116 ms |

**Veredicto: `enlazado`.** Login completo y token válido contra la API.

## La respuesta

**La hipótesis de §2 era falsa: un Worker de Cloudflare SÍ entra en Garmin.**

La huella TLS no lo impidió. Las librerías de Python la imitan porque les hace
falta desde donde corren —máquinas con IPs muy quemadas, y el flujo web del
portal, que es el más vigilado—, pero el flujo JSON de la app de iOS
(`sso.garmin.com/mobile/api/login`) atendió al Worker a la primera, sin captcha,
sin 403 y sin MFA. El canje del ticket, que es donde Garmin limita a las nubes,
también pasó.

Dos cautelas que sobreviven al resultado:

- **Es una medida, no una garantía.** Las IPs de salida de Cloudflare son
  compartidas: lo que hoy pasa mañana puede dar 429. La integración debe
  guardar el token y **refrescarlo**, no volver a iniciar sesión; tratar el 429
  con una espera larga; y no dejar que un fallo de Garmin tumbe nada de
  intervals.
- **El login tardó 2 s.** Entrar es caro y no debe hacerse por petición: se
  enlaza una vez y se vive del `refresh_token`.

Dos falsos bloqueos por el camino, los dos corregidos con test de regresión:

- Tratar **cualquier 403** como muro. Sin token, 401 y 403 son la respuesta
  normal de la API.
- Buscar la palabra **«captcha»** en el cuerpo. Toda página de login lleva un
  captcha embebido, y Cloudflare inyecta su script de detección
  (`challenge-platform`) en páginas que sirve sin bloquear nada. Ahora solo
  cuentan dos pruebas: la cabecera `cf-mitigated`, o una página de desafío con
  código de error. **Un 200 no es un bloqueo**, diga lo que diga su HTML.

## 5. Cómo conviven

Sin tocar nada de lo que ya funciona.

**Hecho** (migración `0007`):

- Enlace de la cuenta desde `/app/garmin`, una vez. El `refresh_token` renueva
  solo; la contraseña no se guarda nunca, ni cifrada.
- Token cifrado (AES-GCM) en **D1**, con la clave derivada de `SESSION_SECRET`
  por HKDF. Ni KV ni Durable Objects: una tabla y una migración.
- El código tolera la base atrasada y lo dice («falta la migración 0007») en vez
  de morir con un error de SQLite, como pasó con la 0006 el 04/09/2026.
- El segundo factor **no** está implementado: se detecta y se avisa.

- Herramientas MCP con prefijo `garmin_`, en el mismo endpoint MCP: desde el
  móvil, sin instalar nada, junto a las de intervals. `garmin_create_workout`,
  `garmin_schedule_workout`, `garmin_list_workouts` y `garmin_delete_workout`.
- Bienestar directo con `garmin_wellness`: los seis endpoints de §3 en paralelo
  por día, con ventana máxima de 7 días. Cada métrica va por su cuenta, así que
  la que falte no tumba el día, y un «no se pudo leer» nunca se disfraza de
  cero.

- Objetivos en porcentaje, convertidos con los umbrales de Garmin
  (`garmin_thresholds`). Como no hay documentación de esas respuestas, los
  umbrales se buscan por nombre de clave en varias fuentes y solo se acepta un
  número PLAUSIBLE: un FTP de 4 W o una FC de umbral de 12 ppm no son el dato
  que se buscaba, tengan la clave que tengan. Cada conversión dice qué umbral
  usó.

- Lectura del calendario (`garmin_list_calendar`) y de un entreno escrito
  (`garmin_get_workout`). Sin esto se podía escribir en Garmin y no leer lo
  escrito, y entonces el protocolo miraba `list_events`, veía el calendario de
  intervals vacío y volvía a escribir la semana entera.
- Los umbrales salen de **Garmin**, que es el origen: el reloj escribe ahí e
  intervals.icu recibe la copia. intervals queda de respaldo para lo que Garmin
  no expone, y la divergencia se avisa —importa, porque lo que se edita a mano
  en intervals no vuelve a Garmin—. Con las **zonas de FC** igual, salvo que ahí
  no hay documentación de la respuesta: se reconocen las claves `zoneNFloor` y
  solo se enseñan si el conjunto tiene sentido (tres o más, desde la 1, en ppm
  creíbles y crecientes).

- Actividades y **series de fuerza** (`garmin_activities`, `garmin_activity`):
  ejercicio, repeticiones, peso y tiempo, serie a serie, con el volumen sumado.
  El peso viaja en gramos aunque la unidad diga kilogramos.
- **Nombres de ejercicio** al prescribir: `category` y `exercise` con los enums
  del catálogo de Garmin, que son los que el reloj enseña. Se sacan de
  `garmin_activity`, así que no hace falta embeber el catálogo de 1527
  ejercicios en el Worker: se leen de las sesiones que el atleta ya ha hecho.
  **Verificado en el reloj el 16/09/2026**: con `category: "CURL"` el paso sale
  como «Curl» y activa el diagrama de músculos; sin enum sale como «--», ni
  siquiera un genérico. La etiqueta se lee debajo, como segunda línea.
- **Duplicados**: Garmin no tiene clave de idempotencia, así que la identidad
  natural es el nombre. Un entreno con un nombre que ya existe no se crea dos
  veces; `allow_duplicate` lo fuerza.

**Por hacer:**

- **Segundo factor** en el enlace.
- **Rampas** dentro de un paso: Garmin no las tiene, habría que partirlas en
  varios pasos y eso ya es interpretar lo que el entrenador quería decir.
- **Reparto de papeles:** Garmin manda en bienestar y en los entrenos que van al
  reloj; intervals sigue mandando en histórico, análisis, records y rachas. Las
  instrucciones del servidor MCP dicen cuál mirar para cada cosa, para que no se
  contradigan.
- Si Garmin falla o caduca el token, las herramientas de intervals siguen
  funcionando igual. Nada de lo que hay hoy depende de lo nuevo.

## 6. Si algún día se cierra (403 o 429 crónico)

- **`Taxuspt/garmin_mcp` en local** (`uvx`), como segundo servidor MCP junto a
  éste. Funciona hoy, pero sólo en escritorio: desde el móvil no.
- **`Taxuspt/garmin_mcp` en un VPS** con transporte `streamable-http`, detrás de
  tu propio auth. Vuelve el acceso desde el móvil a costa de mantener un
  servidor.
- **Un relé mínimo** en una máquina con huella TLS de navegador, que sólo haga
  el login y le pase el token al Worker. El Worker se queda con la parte fácil
  (llamadas con el Bearer, que no llevan desafío) y el relé con la difícil.
- **Programa de desarrolladores de Garmin**: API oficial, aprobación individual,
  poco realista para una cuenta personal.

## Fuentes

- `garth` deprecado: https://github.com/matin/garth/discussions/222
- `python-garminconnect` (MIT), estrategias de login y endpoints:
  https://github.com/cyberjunky/python-garminconnect
- `Taxuspt/garmin_mcp`: https://github.com/Taxuspt/garmin_mcp
- `RedlineTriad/garmin-connect-cloudflare-mcp`:
  https://github.com/RedlineTriad/garmin-connect-cloudflare-mcp
- `brunosantos/garmin-workouts-mcp` (MIT): https://github.com/brunosantos/garmin-workouts-mcp
