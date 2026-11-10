/**
 * Verificación contra el Worker DESPLEGADO (cuenta real de intervals.icu).
 * Solo lectura por defecto; con --commit añade una entrada de log de prueba.
 *
 * Uso:
 *   SMOKE_URL=https://TU-WORKER.workers.dev SMOKE_SECRET=TU-MCP_SECRET_PATH node scripts/smoke.mjs
 *   … añade --commit para probar también la escritura del contrato.
 */

const BASE = process.env.SMOKE_URL;
const SECRET = process.env.SMOKE_SECRET;
if (!BASE || !SECRET) {
  console.error("Define SMOKE_URL (https://…workers.dev) y SMOKE_SECRET (MCP_SECRET_PATH).");
  process.exit(1);
}
const MCP = `${BASE.replace(/\/$/, "")}/${SECRET}/mcp`;
const escribir = process.argv.includes("--commit");

let fallos = 0;
function check(nombre, ok, extra) {
  console.log(`${ok ? "✓" : "✗"} ${nombre}${!ok && extra ? ` → ${String(extra).slice(0, 300)}` : ""}`);
  if (!ok) fallos += 1;
}

let id = 0;
async function rpc(method, params) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params || {} }),
  });
  return res.json();
}
async function llamar(nombre, args) {
  const r = await rpc("tools/call", { name: nombre, arguments: args || {} });
  return r?.result?.content?.[0]?.text ?? JSON.stringify(r);
}

const salud = await fetch(`${BASE}/healthz`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
check("healthz", salud.status === "ok", JSON.stringify(salud));

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
check("initialize", Boolean(init?.result?.protocolVersion), JSON.stringify(init));

const lista = await rpc("tools/list");
const nombres = (lista?.result?.tools || []).map((t) => t.name);
check("tools/list (15 herramientas)", nombres.length === 15, nombres.join(","));

const contrato = await llamar("get_contract");
check("get_contract", contrato.includes("[CONTRATO] v"), contrato);
console.log("\n----- CONTRATO ACTUAL -----\n" + contrato + "\n---------------------------\n");

const wellness = await llamar("get_wellness", { days: 7 });
check("get_wellness (cuenta real)", wellness.includes("Bienestar") || wellness.startsWith("Sin datos"), wellness);

const eventos = await llamar("list_events", { days_back: 3, days_ahead: 7 });
check("list_events", eventos.includes("Calendario"), eventos);

const ajustes = await llamar("get_athlete_settings");
check("get_athlete_settings", !ajustes.startsWith("Error"), ajustes);

if (escribir) {
  const commit = await llamar("contract_commit", { mensaje: "Prueba de humo: verificación del despliegue (sin cambios)." });
  check("contract_commit (solo log)", commit.includes("commit v"), commit);
  const log = await llamar("get_log", { limit: 3 });
  check("get_log refleja el commit", log.includes("Prueba de humo"), log);
}

console.log(fallos ? `\n${fallos} comprobaciones fallaron.` : "\nTodo correcto.");
process.exit(fallos ? 1 : 0);
