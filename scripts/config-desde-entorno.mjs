#!/usr/bin/env node
/**
 * Escribe wrangler.jsonc a partir de variables de entorno.
 *
 *   npm run config:entorno
 *
 * Para qué: wrangler.jsonc no se sube al repositorio (lleva los ids de TU base
 * de datos). En tu ordenador lo escribe el instalador; en Cloudflare Workers
 * Builds no hay nadie que lo escriba, así que el build lo genera con esto desde
 * las «variables de build» del proyecto. Los ids viven en Cloudflare, no en git.
 *
 * Variables:
 *   D1_DATABASE_ID          obligatoria: el id de tu base D1
 *   WORKER_NAME             nombre del Worker            (por defecto: el de la plantilla)
 *   D1_DATABASE_NAME        nombre de la base D1         (por defecto: el de la plantilla)
 *   KV_PUBLICO_ID           namespace KV de la página pública (opcional)
 *   INTERVALS_TZ            zona horaria IANA            (por defecto: la de la plantilla)
 *   INTERVALS_ATHLETE_ID    solo si usas intervals.icu   (opcional)
 *   INTERVALS_EN_ENTRENADOR "si" | "no"                  (por defecto: la de la plantilla)
 *
 * Sin D1_DATABASE_ID y con un wrangler.jsonc ya escrito, no toca nada: así
 * `npm run config:entorno` es inofensivo en un ordenador ya instalado.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

/** JSONC → objeto: quita comentarios (fuera de las cadenas) y comas finales. */
export function leerJsonc(texto) {
  let limpio = "";
  let enCadena = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enCadena) {
      limpio += c;
      if (c === "\\") limpio += texto[++i] ?? "";
      else if (c === '"') enCadena = false;
    } else if (c === '"') {
      enCadena = true;
      limpio += c;
    } else if (c === "/" && texto[i + 1] === "/") {
      while (i < texto.length && texto[i] !== "\n") i++;
      limpio += "\n";
    } else if (c === "/" && texto[i + 1] === "*") {
      i += 2;
      while (i < texto.length && !(texto[i] === "*" && texto[i + 1] === "/")) i++;
      i++;
    } else {
      limpio += c;
    }
  }
  return JSON.parse(limpio.replace(/,(\s*[}\]])/g, "$1"));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KV_ID = /^[0-9a-f]{32}$/i;
const NOMBRE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * La configuración de una instalación a partir de la plantilla y el entorno.
 * Lanza un error legible si falta algo o si un valor no tiene la forma esperada:
 * un build que falla aquí es mejor que un Worker desplegado contra otra base.
 */
export function configDesdeEntorno(env, plantilla) {
  const c = structuredClone(plantilla);
  const valor = (k) => (env[k] ?? "").trim();

  const dbId = valor("D1_DATABASE_ID");
  if (!dbId) throw new Error("Falta D1_DATABASE_ID (el id de tu base D1: npx wrangler d1 list).");
  if (!UUID.test(dbId)) throw new Error(`D1_DATABASE_ID no parece un id de D1: «${dbId}».`);

  const nombre = valor("WORKER_NAME") || c.name;
  if (!NOMBRE.test(nombre)) throw new Error(`WORKER_NAME no es un nombre de Worker válido: «${nombre}».`);
  c.name = nombre;

  const db = c.d1_databases?.[0];
  if (!db) throw new Error("La plantilla no tiene d1_databases.");
  db.database_id = dbId;
  db.database_name = valor("D1_DATABASE_NAME") || db.database_name;

  const kv = valor("KV_PUBLICO_ID");
  if (kv) {
    if (!KV_ID.test(kv)) throw new Error(`KV_PUBLICO_ID no parece un id de KV: «${kv}».`);
    c.kv_namespaces = [{ binding: "PUBLICO", id: kv }];
  } else {
    delete c.kv_namespaces;
  }

  c.vars = { ...(c.vars ?? {}) };
  for (const k of ["INTERVALS_TZ", "INTERVALS_ATHLETE_ID", "INTERVALS_EN_ENTRENADOR"]) {
    if (valor(k)) c.vars[k] = valor(k);
  }
  return c;
}

export function textoConfig(config) {
  return (
    "// Generado por scripts/config-desde-entorno.mjs a partir de wrangler.example.jsonc\n" +
    "// y de las variables de entorno. No se edita: se cambian las variables.\n" +
    JSON.stringify(config, null, "\t") +
    "\n"
  );
}

function main() {
  const destino = join(RAIZ, "wrangler.jsonc");
  if (!(process.env.D1_DATABASE_ID ?? "").trim() && existsSync(destino)) {
    console.log("wrangler.jsonc ya existe y no hay D1_DATABASE_ID: no se toca.");
    return;
  }
  const plantilla = leerJsonc(readFileSync(join(RAIZ, "wrangler.example.jsonc"), "utf8"));
  const config = configDesdeEntorno(process.env, plantilla);
  writeFileSync(destino, textoConfig(config));
  const kv = config.kv_namespaces ? "con página pública" : "sin página pública";
  console.log(`wrangler.jsonc escrito: Worker «${config.name}», D1 «${config.d1_databases[0].database_name}», ${kv}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (e) {
    console.error(`config:entorno: ${e.message}`);
    process.exit(1);
  }
}
