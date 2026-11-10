/**
 * Capturas del panel «zancada» para revisión visual (no forma parte del CI).
 *
 * No levanta wrangler: empaqueta el Worker con esbuild, lo monta en Node sobre
 * un D1 de SQLite con datos de mentira (scripts/captura-datos.ts) y le pasa
 * cada petición del navegador. Así las pantallas salen llenas y el HTML, la
 * API y las tipografías son los de verdad.
 *
 * Uso: node scripts/captura.mjs [carpeta]   (por defecto /tmp/zancada)
 */

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const SALIDA = process.argv[2] || "/tmp/zancada";
mkdirSync(SALIDA, { recursive: true });

const bundle = `${SALIDA}/captura-datos.mjs`;
await build({
  entryPoints: ["scripts/captura-datos.ts"], bundle: true, platform: "node", format: "esm",
  outfile: bundle, external: ["node:*"], logLevel: "warning",
  // El apoyo de D1 busca las migraciones junto a sí mismo: se importa desde su sitio.
  plugins: [{
    name: "apoyo-d1-en-su-sitio",
    setup(b) {
      b.onResolve({ filter: /apoyo-d1\.mjs$/ }, () => ({ path: resolve("test/apoyo-d1.mjs"), external: true }));
    },
  }],
});
const { montar, PASSWORD } = await import(pathToFileURL(bundle).href);
const { fetchApp } = await montar();

// Un servidor HTTP mínimo delante del Worker: el navegador sigue redirecciones
// y cookies como contra el de verdad.
const servidor = createServer(async (req, res) => {
  const trozos = [];
  for await (const t of req) trozos.push(t);
  const cuerpo = trozos.length ? Buffer.concat(trozos) : undefined;
  const r = await fetchApp(new Request(`http://127.0.0.1:${PUERTO}${req.url}`, {
    method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : cuerpo, redirect: "manual",
  }));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
const PUERTO = 8799;
await new Promise((ok) => servidor.listen(PUERTO, "127.0.0.1", ok));
const BASE = `http://127.0.0.1:${PUERTO}`;
const browser = process.env.CHROMIUM_PATH
  ? await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
  : await chromium.launch({ channel: "chrome" });

const problemas = [];
async function contexto(viewport, etiqueta, esquema = "light") {
  const ctx = await browser.newContext({ viewport, colorScheme: esquema });
  const page = await ctx.newPage();
  page.on("pageerror", (exc) => problemas.push(`${etiqueta}: ${exc.message}`));
  page.on("console", (m) => { if (m.type() === "error") problemas.push(`${etiqueta} [console] ${m.text()}`); });
  return page;
}

async function entrar(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL(`${BASE}/app`), page.click('button[type="submit"]')]);
}

const RUTAS = ["hoy", "semana", "progreso", "contrato", "mas", "mas/constancia", "mas/material", "mas/historial", "mas/diario"];

for (const [nombre, viewport, esquema] of [["movil", { width: 390, height: 844 }, "light"], ["escritorio", { width: 1280, height: 900 }, "light"], ["noche", { width: 390, height: 844 }, "dark"]]) {
  const page = await contexto(viewport, nombre, esquema);
  await page.goto(`${BASE}/login`);
  await page.screenshot({ path: `${SALIDA}/${nombre}-login.png` });
  await entrar(page);
  for (const ruta of nombre === "noche" ? ["hoy", "progreso"] : RUTAS) {
    await page.goto(`${BASE}/app#${ruta}`);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SALIDA}/${nombre}-${ruta.replace("/", "-")}.png`, fullPage: true });
    console.log(`captura: ${SALIDA}/${nombre}-${ruta.replace("/", "-")}.png`);
  }
}

// El panel es de solo lectura: ninguna pantalla ofrece escribir.
const p = await contexto({ width: 390, height: 844 }, "solo-lectura");
await entrar(p);
for (const ruta of ["hoy", "contrato", "mas/diario", "mas/material"]) {
  await p.goto(`${BASE}/app#${ruta}`);
  await p.waitForTimeout(400);
  const escritura = await p.$$eval("button", (bs) => bs.map((b) => b.textContent.trim()).filter((t) => /HECHO|RESOLVER|CERRAR|AÑADIR|GUARDAR|CREAR|RETIRAR|^\d+$/.test(t)));
  if (escritura.length) problemas.push(`${ruta}: aún ofrece escribir (${escritura.join(", ")})`);
}

await browser.close();
servidor.close();
if (problemas.length) {
  console.error(`\n${problemas.length} problema(s):`);
  for (const x of problemas) console.error("  ✗ " + x);
  process.exit(1);
}
console.log("\nSin errores de JavaScript en el panel.");
