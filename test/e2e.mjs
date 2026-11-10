/**
 * Prueba end-to-end sin red externa:
 *  1. Levanta el stub de intervals.icu (scripts/stub-intervals.mjs).
 *  2. Levanta el Worker con `wrangler dev` y una D1 local migrada.
 *  3. Hace el handshake MCP completo, ejercita el contrato (importación,
 *     commit, caducidad) y la web (login, API, panel).
 *
 * Uso:  node test/e2e.mjs
 */

import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";

const STUB_PORT = 8999;
const DEV_PORT = 8787;
const SECRET = "secreto-e2e-suficientemente-largo";
const PASSWORD = "contrasena-e2e";
const BASE = `http://127.0.0.1:${DEV_PORT}`;
const MCP = `${BASE}/${SECRET}/mcp`;
const CONFIG_E2E = ".wrangler-e2e.jsonc";

let fallos = 0;
let total = 0;
function check(nombre, ok, extra) {
  total += 1;
  if (ok) console.log(`  ✓ ${nombre}`);
  else {
    fallos += 1;
    console.error(`  ✗ ${nombre}${extra ? ` → ${String(extra).slice(0, 400)}` : ""}`);
  }
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function esperaHttp(url, intentos = 60) {
  for (let i = 0; i < intentos; i++) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      // aún no arranca
    }
    await esperar(1000);
  }
  return false;
}

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params || {} }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function llamar(nombre, args) {
  const r = await rpc("tools/call", { name: nombre, arguments: args || {} });
  const texto = r.body?.result?.content?.[0]?.text ?? "";
  return { texto, isError: r.body?.result?.isError ?? null, status: r.status };
}

async function main() {
  console.log("— Limpiando estado local de D1 (.wrangler/state)…");
  rmSync(".wrangler/state", { recursive: true, force: true });

  console.log("— Arrancando stub de intervals.icu…");
  const stub = spawn("node", ["scripts/stub-intervals.mjs", String(STUB_PORT)], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  stub.on("error", (exc) => {
    console.error("No se pudo arrancar el stub:", exc);
    process.exit(1);
  });

  // Configuración propia del e2e: la plantilla del repo más el KV de la página
  // pública, que el e2e también prueba. No depende del wrangler.jsonc de nadie.
  const plantilla = readFileSync("wrangler.example.jsonc", "utf8");
  writeFileSync(
    CONFIG_E2E,
    plantilla.replace(
      '// "kv_namespaces": [{ "binding": "PUBLICO", "id": "<id del namespace>" }],',
      '"kv_namespaces": [{ "binding": "PUBLICO", "id": "kv-e2e" }],',
    ),
  );

  console.log("— Migrando D1 local…");
  await new Promise((resolve, reject) => {
    // stdin cerrado y CI=true: que wrangler nunca se quede esperando un "y/n".
    const mig = spawn("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "-c", CONFIG_E2E], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    });
    mig.on("error", reject);
    mig.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`migraciones: ${code}`))));
  });

  console.log("— Arrancando wrangler dev…");
  const dev = spawn(
    "npx",
    [
      "wrangler", "dev", "-c", CONFIG_E2E, "--port", String(DEV_PORT), "--ip", "127.0.0.1",
      "--test-scheduled",   // expone /__scheduled para probar el cron de rachas
      "--var", `INTERVALS_API_KEY:clave-de-prueba`,
      "--var", `INTERVALS_ATHLETE_ID:i1`,
      "--var", `INTERVALS_BASE_URL:http://127.0.0.1:${STUB_PORT}/api/v1`,
      "--var", `INTERVALS_TZ:America/Bogota`,
      "--var", `INTERVALS_EN_ENTRENADOR:si`, // el e2e prueba también las herramientas de intervals
      "--var", `MCP_SECRET_PATH:${SECRET}`,
      "--var", `APP_PASSWORD:${PASSWORD}`,
      "--var", `SESSION_SECRET:firma-de-sesiones-e2e`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    },
  );
  dev.on("error", (exc) => {
    console.error("No se pudo arrancar wrangler dev:", exc);
    process.exit(1);
  });
  dev.stdout.on("data", (d) => process.stdout.write("[dev] " + d));
  dev.stderr.on("data", (d) => process.stderr.write("[dev] " + d));

  // Matar el GRUPO de procesos: `npx wrangler` lanza workerd como nieto y un
  // SIGTERM al padre lo dejaría huérfano ocupando el puerto para siempre.
  const limpiar = () => {
    for (const proc of [dev, stub]) {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { /* ya muerto */ }
    }
  };
  process.on("exit", limpiar);
  process.on("SIGINT", () => { limpiar(); process.exit(130); });

  const listo = await esperaHttp(`${BASE}/healthz`);
  if (!listo) {
    console.error("wrangler dev no llegó a arrancar.");
    limpiar();
    process.exit(1);
  }

  console.log("\n— Salud y seguridad");
  const salud = await fetch(`${BASE}/healthz`).then((r) => r.json());
  check("healthz responde", salud.status === "ok");
  // Un {status:"ok"} fijo respondia igual con la base caida: §3 dice que si las
  // herramientas no estan, no se programa, y eso hay que poder comprobarlo.
  check("healthz dice en que version va el contrato", /^v\d+$/.test(String(salud.contrato)));
  check("healthz dice la ultima migracion aplicada", String(salud.esquema).startsWith("0010"), JSON.stringify(salud));
  check("healthz dice que modulos hay", typeof salud.modulos?.intervals === "boolean", JSON.stringify(salud));
  const mal = await fetch(`${BASE}/ruta-incorrecta/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  check("secreto incorrecto → 404", mal.status === 404);

  // Endpoint MCP por cabecera: el secreto deja de viajar en la URL (y por
  // tanto de acabar escrito en los logs del Worker).
  const cuerpoInit = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const bearerMal = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer no-es-el-bueno" },
    body: cuerpoInit,
  });
  check("bearer incorrecto → 401", bearerMal.status === 401, String(bearerMal.status));
  const bearerSin = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: cuerpoInit,
  });
  check("sin cabecera Authorization → 401", bearerSin.status === 401, String(bearerSin.status));
  const bearerBien = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: cuerpoInit,
  }).then((r) => r.json());
  check(
    "bearer correcto → mismo servidor MCP que la ruta con secreto",
    bearerBien.result?.serverInfo?.name === "zancada",
    JSON.stringify(bearerBien),
  );

  const manifest = await fetch(`${BASE}/manifest.webmanifest`);
  const manifestJson = await manifest.json();
  check(
    "manifest público y apuntando al panel",
    manifest.status === 200 && manifestJson.start_url === "/app",
    JSON.stringify(manifestJson),
  );
  const icono = await fetch(`${BASE}/icono.svg`);
  check(
    "icono servido como SVG",
    icono.status === 200 && (icono.headers.get("content-type") || "").includes("image/svg"),
    icono.headers.get("content-type"),
  );

  console.log("\n— Handshake MCP");
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  check("initialize devuelve versión de protocolo", init.body?.result?.protocolVersion === "2025-06-18", JSON.stringify(init.body));
  check("initialize trae instrucciones del contrato", String(init.body?.result?.instructions || "").includes("get_contract"));
  const notif = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  check("notificación initialized → 202", notif.status === 202);
  const lista = await rpc("tools/list");
  const nombres = (lista.body?.result?.tools || []).map((t) => t.name);
  check("tools/list expone 42 herramientas (briefing, diario e histórico de Garmin)", nombres.length === 42, nombres.join(","));
  for (const requerido of ["get_contract", "contract_commit", "get_log", "get_wellness", "create_workout", "get_athlete_settings", "get_streaks", "get_activity_streams", "get_records", "search_activities", "set_wellness", "get_material", "set_material"]) {
    check(`herramienta presente: ${requerido}`, nombres.includes(requerido));
  }

  const b0 = await llamar("briefing");
  check(
    "briefing lee todo en una llamada y marca lo que no pudo leer",
    b0.texto.includes("[BRIEFING]") && b0.texto.includes("== 1 · CONTRATO ==") && b0.texto.includes("FUENTES NO LEÍDAS"),
    b0.texto.slice(0, 600),
  );

  const h0 = await llamar("garmin_weekly_summary");
  check("garmin_weekly_summary arranca diciendo cuánto histórico hay", h0.texto.startsWith("Histórico de Garmin: 0 actividades"), h0.texto.slice(0, 300));
  const s0 = await llamar("garmin_sync", { budget: 6 });
  check("garmin_sync sin cuenta enlazada para y lo dice", /no hay ninguna cuenta de garmin enlazada/i.test(s0.texto), s0.texto.slice(0, 300));
  const d0 = await llamar("diary_set", {
    definir: [{ campo: "dolor_lesion", etiqueta: "lesión", tipo: "numero", minimo: 0, maximo: 10 }],
    campos: { dolor_lesion: 2 },
  });
  const d1 = await llamar("diary_get");
  check("el diario funciona sin intervals", d0.texto.includes("dolor_lesion = 2") && d1.texto.includes("lesión"), d0.texto + d1.texto);

  console.log("\n— Contrato vacío");
  const c0 = await llamar("get_contract");
  check("get_contract arranca en v0", c0.texto.includes("[CONTRATO] v0"), c0.texto);
  check(
    "get_contract con el inventario vacío manda preguntar, no callar",
    c0.texto.includes("MATERIAL: (vacío)") && c0.texto.includes("pregunta qué tiene"),
    c0.texto,
  );

  console.log("\n— Material");
  const matVacio = await llamar("get_material");
  check(
    "get_material vacío explica por qué importa antes que quedarse mudo",
    matVacio.texto.includes("inventario está vacío") && matVacio.texto.includes("a ciegas"),
    matVacio.texto,
  );
  const matAlta = await llamar("set_material", {
    articulos: [
      { accion: "añadir", categoria: "Running", nombre: "Zapatillas Pegasus 40", detalle: "rodaje diario", desde: "2026-02-10" },
      { accion: "añadir", categoria: "Running", nombre: "Bastones plegables", detalle: "trail con desnivel" },
      { accion: "añadir", categoria: "Recuperación", nombre: "Pistola de masaje", detalle: "descargar gemelo y planta" },
    ],
  });
  check(
    "set_material da de alta varias cosas de una vez",
    matAlta.texto.includes("3 cambios") && matAlta.texto.includes("añadido #1") &&
      matAlta.texto.includes("queda con 3 cosas"),
    matAlta.texto,
  );
  const matDup = await llamar("set_material", {
    articulos: [{ accion: "añadir", categoria: "recuperacion", nombre: "Pistola de masaje", detalle: "también para el cuádriceps" }],
  });
  check(
    "un alta repetida actualiza en vez de duplicar, aunque la categoría venga sin tilde",
    matDup.texto.includes("actualizado #3") && matDup.texto.includes("queda con 3 cosas"),
    matDup.texto,
  );
  const matLista = await llamar("get_material");
  check(
    "get_material agrupa por categoría con el detalle y el id",
    matLista.texto.includes("Running (2):") && matLista.texto.includes("Recuperación (1):") &&
      matLista.texto.includes("#1 Zapatillas Pegasus 40 — rodaje diario · desde 2026-02-10") &&
      matLista.texto.includes("cuádriceps"),
    matLista.texto,
  );
  const matFiltro = await llamar("get_material", { categoria: "RECUPERACIÓN" });
  check(
    "get_material filtra por categoría sin distinguir tildes ni mayúsculas",
    matFiltro.texto.includes("Pistola de masaje") && !matFiltro.texto.includes("Bastones"),
    matFiltro.texto,
  );
  const matRetiro = await llamar("set_material", { articulos: [{ accion: "retirar", id: 2 }] });
  check(
    "set_material retira sin borrar",
    matRetiro.texto.includes("retirado #2") && matRetiro.texto.includes("queda con 2 cosas"),
    matRetiro.texto,
  );
  const matConRetirados = await llamar("get_material", { incluir_retirados: true });
  check(
    "lo retirado solo sale si se pide, y avisa de para qué sirve",
    matConRetirados.texto.includes("Retirados (1)") && matConRetirados.texto.includes("explican el pasado") &&
      !matLista.texto.includes("Retirados"),
    matConRetirados.texto,
  );
  const matMal = await llamar("set_material", { articulos: [{ accion: "añadir", nombre: "sin categoría" }] });
  check(
    "set_material exige categoría con un mensaje que dice qué poner",
    matMal.texto.startsWith("Error:") && matMal.texto.includes("Falta 'categoria'"),
    matMal.texto,
  );
  const matFantasma = await llamar("set_material", { articulos: [{ accion: "retirar", id: 999 }] });
  check(
    "set_material avisa si el id no existe",
    matFantasma.texto.includes("No existe el artículo 999"),
    matFantasma.texto,
  );
  const cMat = await llamar("get_contract");
  check(
    "get_contract trae el resumen del material por categorías",
    cMat.texto.includes("MATERIAL DISPONIBLE (2):") &&
      cMat.texto.includes("Running: Zapatillas Pegasus 40") &&
      cMat.texto.includes("Recuperación: Pistola de masaje"),
    cMat.texto,
  );

  console.log("\n— Web: login y sesión");
  const sinSesion = await fetch(`${BASE}/app`, { redirect: "manual" });
  check("/app sin sesión redirige a /login", sinSesion.status === 302);
  const loginMal = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=incorrecta",
  });
  check("login con contraseña mala → 401", loginMal.status === 401);
  const loginBien = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(PASSWORD)}`,
    redirect: "manual",
  });
  const cookie = (loginBien.headers.get("set-cookie") || "").split(";")[0];
  check("login correcto → 302 + cookie", loginBien.status === 302 && cookie.startsWith("sesion="), cookie);
  const panel = await fetch(`${BASE}/app`, { headers: { Cookie: cookie } });
  const panelHtml = await panel.text();
  check("/app con sesión sirve el panel", panel.status === 200 && panelHtml.includes("<title>zancada</title>"));
  const fuente = await fetch(`${BASE}/fuentes/bungee.woff2`);
  const bytesFuente = new Uint8Array(await fuente.arrayBuffer());
  check(
    "las tipografías se sirven sin login y con caché larga",
    fuente.status === 200 && fuente.headers.get("content-type") === "font/woff2" &&
      /immutable/.test(fuente.headers.get("cache-control") || "") &&
      String.fromCharCode(...bytesFuente.slice(0, 4)) === "wOF2",
    `${fuente.status} ${fuente.headers.get("content-type")}`,
  );
  const noFuente = await fetch(`${BASE}/fuentes/nada.woff2`);
  check("una tipografía que no existe → 404", noFuente.status === 404);

  console.log("\n— Importación desde intervals (stub con zona 2099)");
  const preview = await fetch(`${BASE}/app/api/import/preview`, {
    method: "POST",
    headers: { Cookie: cookie },
  }).then((r) => r.json());
  check("preview lee v7 del snapshot", preview.version === 7, JSON.stringify(preview).slice(0, 300));
  check("preview trae 2 reglas", preview.reglas?.length === 2);
  check("preview trae estado (nivel_tobillo)", preview.estado?.some((e) => e.clave === "nivel_tobillo"));
  check("preview trae pendientes", preview.pendientes?.length === 2);
  check("preview trae [LOG] histórico", preview.logs?.length >= 1);
  check("preview trae condición [NOTA]", preview.condiciones?.length >= 1);
  check("preview trae carrera RACE_A", preview.carreras?.some((c) => c.nombre === "Trail de la Sierra"));
  const aplicado = await fetch(`${BASE}/app/api/import/apply`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ preview, incluirLogs: true, incluirCondiciones: true, incluirCarreras: true }),
  }).then((r) => r.json());
  check("importación aplicada continúa la numeración (v8)", aplicado.version === 8, JSON.stringify(aplicado));
  const reAplicar = await fetch(`${BASE}/app/api/import/apply`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ preview }),
  });
  check("segunda importación bloqueada → 409", reAplicar.status === 409);

  console.log("\n— Contrato: commit atómico y caducidad");
  const c1 = await llamar("get_contract");
  check("contrato importado muestra R001", c1.texto.includes("R001"), c1.texto);
  check("contrato muestra la carrera con cuenta atrás", c1.texto.includes("Trail de la Sierra"));
  const commit = await llamar("contract_commit", {
    mensaje: "Prueba e2e: nueva regla temporal y estado",
    reglas: [
      { accion: "crear", tema: "regla-caducada", contenido: "Debe expirar sola", vence: "2020-01-01" },
      { accion: "crear", id: "R100", tema: "regla-viva", contenido: "Sigue activa", vence: "nunca" },
    ],
    estado: { nivel_tobillo: "2" },
    condiciones: [{ accion: "añadir", texto: "Molestia leve en el tobillo", desde: "2026-08-09" }],
  });
  check("commit devuelve v9", commit.texto.includes("commit v9"), commit.texto);
  const c2 = await llamar("get_contract");
  check("regla caducada se dio de baja sola", c2.texto.includes("BAJAS AUTOMÁTICAS") && !c2.texto.match(/^R\d+ regla-caducada/m), c2.texto);
  check("R100 sigue activa", c2.texto.includes("R100 regla-viva"));
  check("estado actualizado (nivel_tobillo: 2)", c2.texto.includes("nivel_tobillo: 2"));
  check("condición registrada", c2.texto.includes("Molestia leve"));
  const log = await llamar("get_log", { limit: 50 });
  check("log contiene la importación y la baja automática", log.texto.includes("Importación") && log.texto.includes("Baja automática"), log.texto);
  check("log contiene el [LOG] histórico importado", log.texto.includes("R018"));

  // La caducidad se dispara en una LECTURA, así que dos lecturas simultáneas
  // (Claude en el móvil y el panel a la vez) ven la misma regla vencida. Solo
  // una puede darla de baja: ni dos entradas de log ni dos bumps de versión.
  const previo = await llamar("contract_commit", {
    mensaje: "Prueba e2e: regla que vence, para la carrera de dos lecturas",
    reglas: [
      { accion: "crear", id: "R200", tema: "regla-carrera", contenido: "Vence ya", vence: "2020-01-02" },
    ],
  });
  const vPrevio = Number(/commit v(\d+)/.exec(previo.texto)?.[1]);
  await Promise.all([llamar("get_contract"), llamar("get_contract")]);
  const trasCarrera = await llamar("get_contract");
  const logCarrera = await llamar("get_log", { limit: 80 });
  check(
    "dos lecturas simultáneas dan de baja R200 una sola vez",
    (logCarrera.texto.match(/R200/g) || []).length === 1,
    logCarrera.texto,
  );
  check(
    "la caducidad sube la versión exactamente una vez",
    new RegExp(`\\[CONTRATO\\] v${vPrevio + 1} `).test(trasCarrera.texto),
    `esperaba v${vPrevio + 1} · ${trasCarrera.texto.split("\n")[0]}`,
  );

  console.log("\n— Contrato: vista compacta, límites, actualizar y log");
  const largo3416 = "x".repeat(3416);
  const vAntes = Number(/\[CONTRATO\] v(\d+)/.exec(trasCarrera.texto)?.[1]);
  const rechazado = await llamar("contract_commit", {
    mensaje: "Prueba e2e: clave de estado de 3.416 caracteres",
    estado: { errores_entrenador: largo3416 },
    pendientes: [{ accion: "añadir", texto: "no debe colarse" }],
  });
  check(
    "un estado de 3.416 caracteres se rechaza nombrando clave, longitud y límite",
    rechazado.texto.startsWith("Error:") &&
      rechazado.texto.includes("'estado.errores_entrenador' tiene 3.416 caracteres y el límite es 300") &&
      rechazado.texto.includes("'mensaje'"),
    rechazado.texto,
  );
  const trasRechazo = await llamar("get_contract");
  check(
    "el rechazo no escribe nada: misma versión y sin el pendiente",
    new RegExp(`\\[CONTRATO\\] v${vAntes} `).test(trasRechazo.texto) && !trasRechazo.texto.includes("no debe colarse"),
    trasRechazo.texto.split("\n")[0],
  );
  const mensajeLargo = await llamar("contract_commit", {
    mensaje: "Prueba e2e: mensaje largo. " + "narrativa que va al log ".repeat(170),
    reglas: [{ accion: "crear", id: "R300", tema: "compacta", resumen: "Mandato corto de R300", contenido: "Porqué largo de R300: " + "razón ".repeat(150), vence: "nunca" }],
    pendientes: [{ accion: "añadir", texto: "Pendiente con vencimiento", vence: "2020-01-01" }],
  });
  check("un mensaje de 4.000 caracteres se acepta", mensajeLargo.texto.startsWith(`commit v${vAntes + 1}`), mensajeLargo.texto);
  const compacta = await llamar("get_contract");
  check("la vista compacta enseña el resumen y no el contenido", compacta.texto.includes("R300 compacta | vence nunca | Mandato corto de R300") && !compacta.texto.includes("Porqué largo de R300"), compacta.texto);
  check("toda lectura termina con [TAMAÑO]", compacta.texto.split("\n").pop().startsWith("[TAMAÑO] "), compacta.texto.split("\n").pop());
  check("el pendiente vencido se cierra solo y se anuncia", compacta.texto.includes("BAJAS AUTOMÁTICAS") && compacta.texto.includes("Pendiente con vencimiento · vencía 2020-01-01 → cerrado como vencido") && !/^#\d+ Pendiente con vencimiento/m.test(compacta.texto), compacta.texto);
  const detalleR300 = await llamar("get_contract", { detalle: "R300" });
  check("get_contract(detalle) trae el contenido íntegro", detalleR300.texto.includes("contenido: Porqué largo de R300: razón razón"), detalleR300.texto.slice(0, 300));
  const seccion = await llamar("get_contract", { seccion: "reglas", detalle: true });
  check("get_contract(seccion, detalle: true) trae la sección entera y solo esa", seccion.texto.includes("↳ Porqué largo de R300") && !seccion.texto.includes("ESTADO:"), seccion.texto.slice(0, 300));
  const idPend = Number(/^#(\d+) .*(?:Comprar|Revisar|pendiente)/mi.exec(compacta.texto)?.[1] ?? /^#(\d+) /m.exec(compacta.texto.split("PENDIENTES")[1] || "")?.[1]);
  const actualizado = await llamar("contract_commit", {
    mensaje: "Prueba e2e: actualizar pendiente sin cambiar el id",
    pendientes: [{ accion: "actualizar", id: idPend, resumen: "Resumen nuevo del pendiente", vence: "2030-01-01" }],
  });
  const trasActualizar = await llamar("get_contract");
  check(
    `actualizar conserva el id #${idPend}`,
    actualizado.texto.includes(`~pendiente #${idPend}`) && new RegExp(`^#${idPend} Resumen nuevo del pendiente  \\(desde .* · vence 2030-01-01\\)`, "m").test(trasActualizar.texto),
    actualizado.texto + "\n" + trasActualizar.texto,
  );
  const fechaCarrera = /Trail de la Sierra · (\d{4}-\d{2}-\d{2})/.exec(trasActualizar.texto)?.[1];
  const duplicada = await llamar("contract_commit", {
    mensaje: "Prueba e2e: carrera con la misma fecha que otra",
    carreras: [{ accion: "añadir", nombre: "Trail de la Sierra (¿repetida?)", fecha: fechaCarrera }],
  });
  check("una carrera con la misma fecha que otra activa avisa", duplicada.texto.includes("Avisos:") && duplicada.texto.includes(`comparte fecha (${fechaCarrera})`), duplicada.texto);
  const vUltimo = Number(/commit v(\d+)/.exec(duplicada.texto)?.[1]);
  const indice = await llamar("get_log");
  check("get_log() es un índice de una línea por entrada", indice.texto.includes("índice de") && /^v\d+ · \d{4}-\d{2}-\d{2} · /m.test(indice.texto) && !indice.texto.includes("narrativa que va al log narrativa que va al log narrativa que va al log narrativa"), indice.texto.slice(0, 400));
  const entera = await llamar("get_log", { version: vAntes + 1 });
  check("get_log(version) trae la entrada entera", entera.texto.includes("narrativa que va al log ".repeat(170).trim()) && entera.texto.includes("reglas · crear · id=R300"), entera.texto.slice(0, 300));
  const busquedaLog = await llamar("get_log", { buscar: "R300" });
  check("get_log(buscar) filtra por texto", busquedaLog.texto.includes(`v${vAntes + 1}`) && busquedaLog.texto.includes("R300"), busquedaLog.texto.slice(0, 300));
  const rango = await llamar("get_log", { desde: vAntes + 1, hasta: vAntes + 2 });
  check("get_log(desde, hasta) por versión", rango.texto.includes("2 entradas completas"), rango.texto.slice(0, 200));

  console.log("\n— Herramientas de intervals contra el stub");
  const wellness = await llamar("get_wellness", { days: 10 });
  check("get_wellness devuelve tabla con CTL y fases", wellness.texto.includes("CTL") && wellness.texto.includes("prof/lig/REM"), wellness.texto);
  const sinDeclarar = await llamar("set_wellness", { date: "hoy", campos: { dolor_tobillo: 4 } });
  check(
    "set_wellness rechaza un campo del diario sin declarar",
    sinDeclarar.texto.startsWith("Error:") &&
      sinDeclarar.texto.includes("no está declarado en el diario"),
    sinDeclarar.texto,
  );
  const escrito = await llamar("set_wellness", {
    date: "hoy", fatiga: 3, lesion: 2, comentarios: "Tobillo molesta al apoyar",
    definir: [
      { campo: "Dolor del tobillo", etiqueta: "tobillo", tipo: "numero", minimo: 0, maximo: 10, descripcion: "0 nada, 10 insoportable" },
      { campo: "sintomas", etiqueta: "sínt", tipo: "si_no" },
    ],
    campos: { "Dolor del tobillo": 4, sintomas: true },
  });
  check(
    "set_wellness declara, escribe en intervals y en el diario a la vez",
    escrito.texto.includes("En intervals.icu · bienestar del") &&
      escrito.texto.includes("fatigue") &&
      escrito.texto.includes("dolor_del_tobillo (0-10)") &&
      escrito.texto.includes("En el diario de la app · "),
    escrito.texto,
  );
  const fueraDeEscala = await llamar("set_wellness", { date: "hoy", campos: { dolor_del_tobillo: 44 } });
  check(
    "set_wellness valida la escala declarada del campo",
    fueraDeEscala.texto.startsWith("Error:") && fueraDeEscala.texto.includes("va de 0 a 10"),
    fueraDeEscala.texto,
  );
  const escritoVacio = await llamar("set_wellness", { date: "2026-01-16" });
  check(
    "set_wellness sin campos no escribe nada",
    escritoVacio.texto.startsWith("Error:") && escritoVacio.texto.includes("Nada que escribir"),
    escritoVacio.texto,
  );
  const bienestarConDiario = await llamar("get_wellness", { days: 14 });
  check(
    "get_wellness pega las columnas del diario a la tabla y explica su escala",
    bienestarConDiario.texto.includes("tobillo") &&
      bienestarConDiario.texto.includes("Diario de la app") &&
      bienestarConDiario.texto.includes("0 nada, 10 insoportable"),
    bienestarConDiario.texto,
  );
  const acts = await llamar("get_activities", { days: 30 });
  check("get_activities agrega totales por deporte", acts.texto.includes("Totales por deporte"), acts.texto);
  const detalle = await llamar("get_activity", { activity_id: "i1001" });
  check("get_activity muestra intervalos", detalle.texto.includes("Intervalos"), detalle.texto);
  check(
    "get_activity trae desacople, eficiencia y clima",
    detalle.texto.includes("Desacople aeróbico 4.2 %") &&
      detalle.texto.includes("factor de eficiencia 1.83") &&
      detalle.texto.includes("29.4 °C") &&
      detalle.texto.includes("sensación 34.1 °C"),
    detalle.texto,
  );
  check(
    "get_activity da subida por vuelta y bajada derivada de la altitud",
    detalle.texto.includes("subida") && detalle.texto.includes("bajada") &&
      detalle.texto.includes("NO la publica la API"),
    detalle.texto,
  );
  const series = await llamar("get_activity_streams", { activity_id: "i1001", cada_segundos: 120 });
  check(
    "get_activity_streams remuestrea en tramos con pendiente y desnivel",
    series.texto.includes("remuestreadas cada 120 s") &&
      series.texto.includes("pend%") &&
      series.texto.includes("Desnivel del tramo"),
    series.texto,
  );
  const seriesVuelta = await llamar("get_activity_streams", { activity_id: "i1001", vuelta: 2, cada_metros: 100 });
  check(
    "get_activity_streams recorta a una vuelta y remuestrea por metros",
    seriesVuelta.texto.includes("vuelta 2 · 1000 m") &&
      seriesVuelta.texto.includes("remuestreadas cada 100 m"),
    seriesVuelta.texto,
  );
  const seriesMal = await llamar("get_activity_streams", { activity_id: "i1001", cada_segundos: 10, cada_metros: 25 });
  check(
    "get_activity_streams rechaza las dos resoluciones a la vez",
    seriesMal.texto.startsWith("Error:") && seriesMal.texto.includes("no los dos"),
    seriesMal.texto,
  );
  const seriesVueltaMal = await llamar("get_activity_streams", { activity_id: "i1001", vuelta: 9 });
  check(
    "get_activity_streams avisa si la vuelta no existe",
    seriesVueltaMal.texto.includes("no tiene la vuelta 9"),
    seriesVueltaMal.texto,
  );
  const busqueda = await llamar("search_activities", { sport: "Run", min_km: 12, sort: "distancia", limit: 5 });
  check(
    "search_activities filtra, ordena y describe los filtros aplicados",
    busqueda.texto.includes("Filtros: deporte Run · distancia ≥ 12 km") &&
      busqueda.texto.includes("orden por distancia") &&
      busqueda.texto.includes("Totales por deporte"),
    busqueda.texto,
  );
  const sinNada = await llamar("search_activities", { min_km: 9999 });
  check(
    "search_activities dice cuando nada cumple en vez de devolver una tabla vacía",
    sinNada.texto.includes("Ninguna actividad cumple todos los filtros"),
    sinNada.texto,
  );
  const ordenMal = await llamar("search_activities", { sort: "pulsaciones" });
  check(
    "search_activities rechaza un orden desconocido",
    ordenMal.texto.startsWith("Error:") && ordenMal.texto.includes("Valores admitidos"),
    ordenMal.texto,
  );
  const records = await llamar("get_records", { days: 120 });
  check(
    "get_records da las cuatro secciones con id y fecha",
    records.texto.includes("a) FC máxima registrada en actividades") &&
      records.texto.includes("b) Mejor FC media sostenida") &&
      records.texto.includes("c) Mejores marcas por distancia · Run") &&
      records.texto.includes("d) Curva de ritmo · Run"),
    records.texto,
  );
  check(
    "get_records avisa de las ventanas más largas que el rango pedido",
    records.texto.includes("365 días") && records.texto.includes("NO son el máximo de esa ventana"),
    records.texto,
  );
  const semanal = await llamar("get_weekly_summary", { weeks: 4 });
  check("get_weekly_summary con fila TOTAL", semanal.texto.includes("TOTAL"), semanal.texto);
  const rachas = await llamar("get_streaks", { days: 30 });
  check(
    "get_streaks devuelve tabla, calendario y advertencia",
    rachas.texto.includes("movimiento") &&
      rachas.texto.includes("Calendario (lunes→domingo") &&
      rachas.texto.includes("nunca uses la racha"),
    rachas.texto,
  );
  const eventos = await llamar("list_events", { oldest: "2099-01-01", newest: "2099-01-10", full_notes: true });
  check("list_events lee la zona 2099 (legado)", eventos.texto.includes("[SYS/CONTRATO]"), eventos.texto);
  const entreno = await llamar("create_workout", {
    date: "2099-06-01",
    sport: "correr",
    name: "Series e2e",
    steps: [
      { section: "Calentamiento", steps: [{ duration: "12m", zone: "Z2", zone_kind: "hr", label: "Suave" }] },
      { section: "Series", repeat: 5, steps: [{ distance: "1km", pace_pct: [103, 107], label: "Ritmo de diez kilómetros" }] },
    ],
  });
  check("create_workout crea y confirma pasos", entreno.texto.includes("Entreno creado") && entreno.texto.includes("pasos interpretados"), entreno.texto);
  const borrar = await llamar("delete_event", { event_id: "2" });
  check("delete_event sin confirm no borra", borrar.texto.includes("NO se ha borrado nada"), borrar.texto);
  const ajustes = await llamar("get_athlete_settings");
  check("get_athlete_settings lee LTHR y zonas", ajustes.texto.includes("LTHR 193") && ajustes.texto.includes("Zonas FC"), ajustes.texto);
  const previaAjuste = await llamar("update_athlete_settings", { sport: "Run", fields: { lthr: 191 } });
  check("update_athlete_settings sin confirm es vista previa", previaAjuste.texto.includes("NO se ha cambiado nada"), previaAjuste.texto);

  console.log("\n— API web restante");
  const apiContrato = await fetch(`${BASE}/app/api/contract`, { headers: { Cookie: cookie } }).then((r) => r.json());
  // El panel y el MCP leen la MISMA versión: la última fue la baja automática
  // de R200, que subió uno sobre el commit que la creó.
  check(
    "API /contract devuelve versión y reglas",
    apiContrato.version === vUltimo && Array.isArray(apiContrato.reglas),
    `esperaba v${vUltimo} · ${JSON.stringify(apiContrato).slice(0, 160)}`,
  );
  // El panel vive del histórico de Garmin (D1) y del calendario de Garmin. Aquí
  // no hay Garmin enlazado: tiene que responder igual y decir qué no leyó.
  const apiHoy = await fetch(`${BASE}/app/api/hoy`, { headers: { Cookie: cookie } });
  const hoyJson = await apiHoy.json();
  check(
    "API /hoy responde sin Garmin y dice que el calendario no se leyó",
    apiHoy.status === 200 && Array.isArray(hoyJson.agenda) && typeof hoyJson.agendaError === "string" &&
      "cobertura" in hoyJson && "bandas" in hoyJson,
    JSON.stringify(hoyJson).slice(0, 300),
  );
  const apiSemana = await fetch(`${BASE}/app/api/semana?lunes=2026-11-04`, { headers: { Cookie: cookie } }).then((r) => r.json());
  check(
    "API /semana devuelve siete días desde el lunes",
    apiSemana.lunes === "2026-11-02" && apiSemana.dias?.length === 7,
    JSON.stringify(apiSemana).slice(0, 200),
  );
  const apiProgreso = await fetch(`${BASE}/app/api/progreso?dias=28`, { headers: { Cookie: cookie } }).then((r) => r.json());
  check(
    "API /progreso da una fila de carga por día",
    apiProgreso.carga?.length === 28 && Array.isArray(apiProgreso.semanas) && Array.isArray(apiProgreso.marcas),
    JSON.stringify(apiProgreso).slice(0, 200),
  );
  const apiWellness = await fetch(`${BASE}/app/api/wellness?days=30`, { headers: { Cookie: cookie } });
  check("la API ya no sirve el bienestar de intervals", apiWellness.status === 404, String(apiWellness.status));
  // Diario: el panel solo lo enseña; se escribe hablando con el entrenador.
  const apiDiario = await fetch(`${BASE}/app/api/diario?days=30`, { headers: { Cookie: cookie } }).then((r) => r.json());
  check(
    "API /diario devuelve los campos declarados y los días con registro",
    Array.isArray(apiDiario.campos) &&
      apiDiario.campos.some((c) => c.campo === "dolor_del_tobillo" && c.maximo === 10) &&
      apiDiario.dias[apiDiario.hoy] && apiDiario.dias[apiDiario.hoy].dolor_del_tobillo === 4,
    JSON.stringify(apiDiario).slice(0, 300),
  );
  const apiMaterial = await fetch(`${BASE}/app/api/material`, { headers: { Cookie: cookie } }).then((r) => r.json());
  check(
    "API /material devuelve el inventario y sus categorías",
    apiMaterial.articulos.length === 3 &&
      apiMaterial.categorias.some((c) => c.etiqueta === "Running" && c.disponibles === 1 && c.retirados === 1),
    JSON.stringify(apiMaterial.categorias),
  );
  // El panel es de solo lectura: ni el diario, ni el material, ni el contrato
  // se escriben desde la web. Una cookie robada no reescribe nada.
  for (const ruta of ["/app/api/diario", "/app/api/material", "/app/api/commit"]) {
    const r = await fetch(`${BASE}${ruta}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mensaje: "intento", valores: { dolor_del_tobillo: 1 }, accion: "añadir", categoria: "x", nombre: "y" }),
    });
    check(`POST ${ruta} ya no existe en el panel`, r.status === 404, String(r.status));
  }
  const apiRachas = await fetch(`${BASE}/app/api/rachas?dias=30`, { headers: { Cookie: cookie } }).then((r) => r.json());
  check(
    "API /rachas cuenta sobre el histórico de Garmin y avisa sin calendario",
    apiRachas.rachas?.dias?.length === 30 && apiRachas.calendarioLeido === false &&
      apiRachas.rachas.umbrales.minSegundos === 900,
    JSON.stringify(apiRachas).slice(0, 200),
  );
  const apiStreaks = await fetch(`${BASE}/app/api/streaks?days=30`, { headers: { Cookie: cookie } });
  check("la API ya no sirve las rachas de intervals", apiStreaks.status === 404, String(apiStreaks.status));
  const logPagina = await fetch(`${BASE}/app/api/log?limit=2`, { headers: { Cookie: cookie } }).then((r) => r.json());
  const logSiguiente = await fetch(`${BASE}/app/api/log?limit=2&antes_id=${logPagina.entradas[1].id}`, { headers: { Cookie: cookie } }).then((r) => r.json());
  check(
    "API /log pagina por id sin repetir entradas",
    logSiguiente.entradas.length === 2 && logSiguiente.entradas[0].id < logPagina.entradas[1].id,
    JSON.stringify(logSiguiente.entradas.map((e) => e.id)),
  );

  const cron = await fetch(`${BASE}/__scheduled?cron=0+8+*+*+*`);
  check("el cron de rachas responde", cron.status === 200, String(cron.status));

  const sinCookie = await fetch(`${BASE}/app/api/contract`);
  check("API sin cookie → 401", sinCookie.status === 401);
  // Página pública: la vista previa calcula con el stub y pasa la lista blanca.
  // Sin Garmin enlazado el cumplimiento no se actualiza, pero el resto sí.
  const previa = await fetch(`${BASE}/app/api/publico`, { headers: { Cookie: cookie } }).then((r) => r.json());
  check(
    "API /publico calcula un JSON que pasa la lista blanca",
    previa.errores?.length === 0 && previa.publico?.version === 1 && previa.publicado === false,
    JSON.stringify(previa).slice(0, 400),
  );
  // El stub vive en la fecha real; antes de la T0 no hay días que leer de
  // Garmin y no se le llama. Después, sin cuenta enlazada, lo diría en avisos.
  check(
    "el cumplimiento no se inventa: sin días que leer, ni se toca Garmin ni se fecha",
    previa.publico?.cumplimiento?.hasta === null &&
      (previa.diagnostico?.leidoDesde === null ||
        previa.avisos?.some((a) => /Cumplimiento sin actualizar/.test(a))),
    JSON.stringify({ avisos: previa.avisos, diag: previa.diagnostico?.leidoDesde }),
  );
  const publicada = await fetch(`${BASE}/app/api/publico/publicar`, { method: "POST", headers: { Cookie: cookie } });
  const cuerpoPublicada = await publicada.json();
  check("POST /publico/publicar escribe en KV", publicada.status === 200 && cuerpoPublicada.publicado === true, JSON.stringify(cuerpoPublicada.avisos));
  const plan = await llamar("set_plan_publico", {});
  check("set_plan_publico enseña temporadas y día D", /Día D: 2027-08-21/.test(plan.texto ?? JSON.stringify(plan)), JSON.stringify(plan).slice(0, 300));


  // Garmin en el panel: la página pide credenciales de Garmin y el endpoint
  // toca el token guardado. Nada de esto puede quedar fuera del login.
  const garminSinCookie = await fetch(`${BASE}/app/garmin`, { redirect: "manual" });
  check(
    "la página de Garmin sin cookie → login",
    garminSinCookie.status === 302 && garminSinCookie.headers.get("location") === "/login",
    `${garminSinCookie.status} → ${garminSinCookie.headers.get("location")}`,
  );
  for (const [ruta, cuerpo] of [
    ["/app/garmin/enlazar", JSON.stringify({ email: "a@b.c", password: "x" })],
    ["/app/garmin/desenlazar", null],
    ["/app/garmin/eco", null],
  ]) {
    const sinCookie = await fetch(`${BASE}${ruta}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: cuerpo,
      redirect: "manual",
    });
    check(
      `POST ${ruta} sin cookie no hace nada`,
      sinCookie.status === 302 || sinCookie.status === 401,
      String(sinCookie.status),
    );
  }

  // Y con sesión: el estado dice «sin enlazar» en vez de reventar.
  const estadoGarmin = await fetch(`${BASE}/app/garmin/estado`, { headers: { Cookie: cookie } });
  const estadoJson = await estadoGarmin.json();
  check(
    "estado de Garmin sin cuenta enlazada → {enlazada:false}",
    estadoGarmin.status === 200 && estadoJson.enlazada === false,
    `${estadoGarmin.status} ${JSON.stringify(estadoJson)}`,
  );

  console.log(`\nResultado: ${total - fallos}/${total} comprobaciones correctas.`);
  limpiar();
  await esperar(500);
  process.exit(fallos ? 1 : 0);
}

main().catch((exc) => {
  console.error("Fallo del e2e:", exc);
  process.exit(1);
});
