#!/usr/bin/env node
/**
 * Instalador para un atleta nuevo: de cero a un entrenador conectado a Claude.
 *
 *   npm run instalar            # instala en TU cuenta de Cloudflare
 *   npm run instalar -- --simular   # enseña lo que haría, sin tocar nada
 *
 * Qué hace, en orden:
 *   1. Comprueba que hay sesión en Cloudflare (wrangler login).
 *   2. Pregunta zona horaria y si quieres intervals.icu (opcional; Garmin manda).
 *   3. Crea la base D1 (o reutiliza la que ya exista con ese nombre).
 *   4. Escribe wrangler.jsonc para TU instalación (no se sube al repo; la plantilla es wrangler.example.jsonc).
 *   5. Aplica las migraciones a la base remota. Siempre ANTES del código.
 *   6. Despliega el Worker.
 *   7. Genera y sube los secretos (no quedan en el repo ni en disco).
 *   8. Te dice qué pegar en Claude y cómo enlazar Garmin.
 *
 * Sin dependencias: solo Node 20+ y wrangler (que ya trae el proyecto).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIMULAR = process.argv.includes("--simular");
const NOMBRE_DB = "zancada";

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function preguntar(texto, porDefecto = "") {
  if (SIMULAR && !process.stdin.isTTY) return porDefecto;
  const r = (await rl.question(`${texto}${porDefecto ? ` [${porDefecto}]` : ""}: `)).trim();
  return r || porDefecto;
}

function paso(n, texto) {
  console.log(`\n${n}. ${texto}`);
}

/** Ejecuta wrangler. En simulación solo lo enseña y devuelve `simulado`. */
function wrangler(args, { simulado = "", entrada, ci = false, soloStdout = false } = {}) {
  const mostrar = `npx wrangler ${args.join(" ")}`;
  if (SIMULAR) {
    console.log(`   $ ${mostrar}`);
    return simulado;
  }
  const r = spawnSync("npx", ["wrangler", ...args], {
    cwd: RAIZ,
    shell: process.platform === "win32", // npx es un .cmd en Windows
    encoding: "utf8",
    input: entrada,
    env: { ...process.env, ...(ci ? { CI: "1" } : {}), WRANGLER_SEND_METRICS: "false" },
  });
  if (r.status !== 0) {
    const salida = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const error = new Error(`Falló: ${mostrar}\n${salida.slice(-1500)}`);
    error.salida = salida;
    throw error;
  }
  return soloStdout ? (r.stdout ?? "") : `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

function aleatorio() {
  return randomBytes(32).toString("base64url");
}

/** wrangler.jsonc de una instalación nueva: sin ids de nadie más. */
function configuracion({ databaseId, tz, athleteId }) {
  const vars = { INTERVALS_TZ: tz };
  if (athleteId) vars.INTERVALS_ATHLETE_ID = athleteId;
  return `{
	// Generado por scripts/instalar.mjs. Servidor MCP del entrenador + panel web
	// + contrato en D1. Garmin es la fuente principal; intervals.icu es opcional.
	"name": "zancada",
	"main": "src/index.ts",
	"compatibility_date": "2026-07-01",
	"observability": { "enabled": true },
	"version_metadata": { "binding": "CF_VERSION_METADATA" },

	// Cada hora: el histórico de Garmin se llena por tandas. La ejecución de las
	// 08:00 UTC hace además lo diario (rachas).
	"triggers": { "crons": ["0 * * * *"] },

	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "${NOMBRE_DB}",
			"database_id": "${databaseId}",
			"migrations_dir": "migrations"
		}
	],

	// Secretos (los sube el instalador): MCP_SECRET_PATH, APP_PASSWORD,
	// SESSION_SECRET${athleteId ? " e INTERVALS_API_KEY" : ""}.
	"vars": ${JSON.stringify(vars, null, 2).replace(/\n/g, "\n\t")}
}
`;
}

async function main() {
  console.log("Instalador del entrenador (Garmin + contrato en Cloudflare)");
  if (SIMULAR) console.log("MODO SIMULACIÓN: no se toca nada; se enseñan los comandos.\n");

  paso(1, "Sesión de Cloudflare");
  try {
    const quien = wrangler(["whoami"], { simulado: "You are logged in (simulado)" });
    if (!/logged in/i.test(quien)) throw new Error("sin sesión");
    console.log("   Con sesión. (El plan gratuito de Workers y D1 sobra.)");
  } catch {
    console.log("   No hay sesión. Ejecuta `npx wrangler login`, entra en tu cuenta y vuelve a lanzar esto.");
    process.exit(1);
  }

  paso(2, "Preguntas");
  const tz = await preguntar("   Zona horaria (IANA)", Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Bogota");
  const conIntervals = /^s/i.test(await preguntar("   ¿Conectar también intervals.icu? Es opcional (s/n)", "n"));
  let athleteId = "";
  let intervalsKey = "";
  if (conIntervals) {
    athleteId = await preguntar("   Id de atleta de intervals.icu (i123456)");
    intervalsKey = await preguntar("   API key de intervals.icu (Settings → Developer Settings)");
    if (!/^i?\d+$/.test(athleteId) || !intervalsKey) {
      console.log("   Faltan datos de intervals: se instala solo con Garmin (se puede añadir luego).");
      athleteId = "";
      intervalsKey = "";
    } else if (!athleteId.startsWith("i")) {
      athleteId = `i${athleteId}`;
    }
  }
  const password = await preguntar("   Contraseña para el panel web (vacío = genero una)", "");

  paso(3, `Base de datos D1 «${NOMBRE_DB}»`);
  try {
    wrangler(["d1", "create", NOMBRE_DB]);
  } catch (exc) {
    if (!/already exists/i.test(exc.salida ?? "")) throw exc;
    console.log("   Ya existía: se reutiliza.");
  }
  const lista = wrangler(["d1", "list", "--json"], {
    soloStdout: true,
    simulado: JSON.stringify([{ name: NOMBRE_DB, uuid: "00000000-0000-0000-0000-000000000000" }]),
  });
  const db = JSON.parse(lista.slice(lista.indexOf("["))).find((d) => d.name === NOMBRE_DB);
  if (!db?.uuid) throw new Error("No encuentro el id de la base recién creada en `wrangler d1 list`.");
  console.log(`   database_id ${db.uuid}`);

  paso(4, "wrangler.jsonc para tu instalación");
  // Si el fichero ya apunta a OTRA base, es una instalación viva (la de quien te
  // pasó el repo, o la tuya): no se pisa sin preguntar.
  const actual = existsSync(join(RAIZ, "wrangler.jsonc")) ? readFileSync(join(RAIZ, "wrangler.jsonc"), "utf8") : "";
  const idActual = (actual.match(/"database_id":\s*"([^"]+)"/) ?? [])[1];
  if (idActual && idActual !== db.uuid && !SIMULAR) {
    const ok = await preguntar(
      `   wrangler.jsonc apunta a otra base (${idActual}). Si este repo es de otra persona, es lo ` +
        "normal y hay que sobrescribirlo. ¿Sobrescribir? (s/n)",
      "n",
    );
    if (!/^s/i.test(ok)) {
      console.log("   No se toca. Nada más que hacer.");
      process.exit(0);
    }
  }
  const contenido = configuracion({ databaseId: db.uuid, tz, athleteId });
  if (SIMULAR) console.log(contenido.replace(/^/gm, "   | "));
  else writeFileSync(join(RAIZ, "wrangler.jsonc"), contenido);

  paso(5, "Migraciones (antes que el código, siempre)");
  wrangler(["d1", "migrations", "apply", NOMBRE_DB, "--remote"], { ci: true });

  paso(6, "Despliegue");
  const salidaDeploy = wrangler(["deploy"], { simulado: "https://zancada.tu-subdominio.workers.dev" });
  const url = (salidaDeploy.match(/https:\/\/[^\s]+\.workers\.dev/) ?? [])[0];
  if (!url) throw new Error("El despliegue no dio una URL de workers.dev. Mira la salida de `npx wrangler deploy`.");

  paso(7, "Secretos");
  const secretos = {
    MCP_SECRET_PATH: aleatorio(),
    SESSION_SECRET: aleatorio(),
    APP_PASSWORD: password || randomBytes(9).toString("base64url"),
    ...(intervalsKey ? { INTERVALS_API_KEY: intervalsKey } : {}),
  };
  // Fichero temporal fuera del repo, borrado en cuanto se sube.
  const dir = mkdtempSync(join(tmpdir(), "entrenador-"));
  const fichero = join(dir, "secretos.json");
  try {
    if (!SIMULAR) writeFileSync(fichero, JSON.stringify(secretos), { mode: 0o600 });
    wrangler(["secret", "bulk", fichero]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`
==================================================================
LISTO. Guarda esto en tu gestor de contraseñas (no se vuelve a enseñar):

  Panel web:   ${url}/app        contraseña: ${secretos.APP_PASSWORD}
  Conector MCP para Claude:
               ${url}/${secretos.MCP_SECRET_PATH}/mcp
  (Esa URL es una credencial: quien la tenga lee y escribe tu contrato.)

Siguientes pasos:
  1. Entra en ${url}/app y, en Más → Garmin Connect, enlaza tu cuenta de Garmin.
  2. En Claude: Ajustes → Conectores → Añadir conector personalizado → pega la URL del conector.
  3. Crea un proyecto en Claude («Entrenador»). En sus instrucciones pega
     entrenador/constitucion.md y, debajo, tu perfil (entrenador/perfil-plantilla.md rellenado).
  4. Primera conversación: «Hola, empecemos». El entrenador verá el contrato vacío y
     seguirá el guion de arranque. El histórico de Garmin se llena solo en uno o dos días.
==================================================================`);

  // Después de enseñar las credenciales: si esto falla, no se pierden.
  try {
    const salud = SIMULAR ? "simulado" : execFileSync("curl", ["-s", "--max-time", "15", `${url}/healthz`], { encoding: "utf8" });
    console.log(`\n/healthz → ${salud.trim()}`);
  } catch {
    console.log(`\nNo pude comprobar ${url}/healthz todavía (el dominio tarda unos minutos). Ábrelo en el navegador.`);
  }
}

main()
  .catch((exc) => {
    console.error(`\nError: ${exc.message}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
