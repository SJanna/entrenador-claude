/**
 * API JSON del panel (tras login). Solo lectura: el contrato, el diario y el
 * material se escriben hablando con el entrenador, que pasa por el MCP. Así
 * una cookie robada no reescribe nada. Todo de Garmin (histórico en D1 y
 * calendario), del contrato, del diario y del material: intervals.icu no entra.
 * El panel pinta; el MCP usa las tablas de texto. Misma lógica, dos formatos.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { configFromEnv } from "../env";
import { ContractStore, ContractError } from "../contract/store";
import { buildPreview, applyImport, type ImportPreview } from "../contract/importer";
import { IntervalsClient } from "../intervals/client";
import { DiarioStore } from "../diario/store";
import { MaterialStore } from "../material/store";
import { addDays } from "../dates";
import { cacheado } from "../cache";
import { GarminAlmacen } from "../garmin/almacen";
import { GarminCliente, GarminError } from "../garmin/cliente";
import { leerCalendario } from "../garmin/calendario";
import { leerDia } from "../garmin/bienestar";
import { HistoricoStore } from "../historico/store";
import { datosHoy, datosProgreso, datosRachas, datosSemana, type FuentesPanel } from "./panelDatos";
import { calcularPublico } from "../publico/servicio";

/**
 * Cuánto vale reutilizar cada lectura de intervals. Corto a propósito: sirve
 * para abrir el panel dos veces seguidas o para que panel y MCP no dupliquen la
 * misma petición, no para servir datos de ayer. `?fresh=1` la salta.
 */
/** El calendario de Garmin se relee como mucho cada minuto; `?fresh=1` lo salta. */
const TTL_CALENDARIO_MS = 60_000;
/** El bienestar de hoy en vivo: seis llamadas a Garmin, así que como mucho cada 10 min. */
const TTL_BIENESTAR_MS = 10 * 60_000;

function clampInt(value: string | undefined, def: number, low: number, high: number): number {
  const parsed = parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return def;
  return Math.max(low, Math.min(high, parsed));
}

/** El panel manda `fresh=1` cuando el refresco es explícito del usuario. */
function esFresh(valor: string | undefined): boolean {
  return valor === "1" || valor === "true";
}

function errJson(exc: unknown): { error: string } {
  if (exc instanceof GarminError || exc instanceof ContractError) {
    return { error: exc.message };
  }
  return { error: exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc) };
}

/** Fuentes del panel: histórico de D1 y calendario de Garmin con caché corta. */
function fuentes(env: Env, fresh: boolean): FuentesPanel {
  const config = configFromEnv(env);
  const cliente = new GarminCliente(new GarminAlmacen(env.DB, env.SESSION_SECRET));
  return {
    store: new HistoricoStore(env.DB),
    hoy: config.today(),
    // Hoy a medias en D1 (el reloj sincronizó después del cron): se lee en
    // vivo, como mucho cada 10 minutos, y se guarda para el resto.
    bienestarEnVivo: (fecha) =>
      cacheado(`gbien:${fecha}`, TTL_BIENESTAR_MS, fresh, async () => leerDia(cliente, await cliente.atleta(), fecha)),
    calendario: (desde, hasta) =>
      cacheado(`gcal:${desde}:${hasta}`, TTL_CALENDARIO_MS, fresh, () =>
        leerCalendario(cliente, desde, hasta),
      ),
  };
}

const SIN_HISTORICO =
  "El histórico de Garmin todavía no existe en esta base (falta la migración 0010). " +
  "Aplica las migraciones: npm run db:migrate.";

export function apiApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.onError((exc, c) => c.json(errJson(exc), 500));

  // ------------------------------------------------- datos de Garmin (D1)
  // Todo sale del histórico que llena el cron y del calendario de Garmin. Sin
  // la migración 0010 no hay histórico, y se dice en vez de pintar ceros.
  // Sin la migración 0010 no hay histórico, y se dice en vez de pintar ceros.
  // (Antes era un middleware con una ruta de expresión regular: según la
  // versión de Hono, rompía el enrutado de /semana y /progreso con un 404.)
  const sinHistorico = async (env: Env) => !(await new HistoricoStore(env.DB).disponible());

  app.get("/hoy", async (c) => {
    if (await sinHistorico(c.env)) return c.json({ error: SIN_HISTORICO }, 503);
    return c.json(await datosHoy(fuentes(c.env, esFresh(c.req.query("fresh")))));
  });

  app.get("/semana", async (c) => {
    if (await sinHistorico(c.env)) return c.json({ error: SIN_HISTORICO }, 503);
    const f = fuentes(c.env, esFresh(c.req.query("fresh")));
    const pedido = String(c.req.query("lunes") ?? "");
    const lunes = /^\d{4}-\d{2}-\d{2}$/.test(pedido) ? pedido : f.hoy;
    return c.json(await datosSemana(f, lunes));
  });

  app.get("/progreso", async (c) => {
    if (await sinHistorico(c.env)) return c.json({ error: SIN_HISTORICO }, 503);
    const dias = clampInt(c.req.query("dias"), 28, 7, 730);
    return c.json(await datosProgreso(fuentes(c.env, esFresh(c.req.query("fresh"))), dias));
  });

  app.get("/rachas", async (c) => {
    if (await sinHistorico(c.env)) return c.json({ error: SIN_HISTORICO }, 503);
    const dias = clampInt(c.req.query("dias"), 120, 14, 365);
    return c.json(await datosRachas(fuentes(c.env, esFresh(c.req.query("fresh"))), dias));
  });

  // ------------------------------------------------------ página pública
  // Vista previa del JSON público, detrás del login. GET calcula sin publicar
  // y añade el diagnóstico (con títulos de sesiones: por eso no es público);
  // POST calcula y publica en KV, igual que el cron.
  app.get("/publico", async (c) => {
    const resultado = await calcularPublico(c.env, configFromEnv(c.env), { publicar: false });
    return c.json(resultado);
  });

  app.post("/publico/publicar", async (c) => {
    const resultado = await calcularPublico(c.env, configFromEnv(c.env), { publicar: true });
    return c.json(resultado, resultado.publicado ? 200 : 409);
  });

  // --------------------------------------------------------------- diario
  // El diario subjetivo del atleta (dolor, síntomas…). El panel solo lo
  // enseña: se escribe hablando con el entrenador (diary_set).
  app.get("/diario", async (c) => {
    const config = configFromEnv(c.env);
    const store = new DiarioStore(c.env.DB);
    const days = clampInt(c.req.query("days"), 120, 1, 365);
    const newest = config.today();
    const oldest = addDays(newest, -(days - 1));
    const [campos, porDia] = await Promise.all([store.campos(), store.leer(oldest, newest)]);

    // El panel prefiere un valor plano por campo: ya sabe el tipo por 'campos'.
    const dias: Record<string, Record<string, number | string>> = {};
    for (const [fecha, valores] of porDia) {
      const fila: Record<string, number | string> = {};
      for (const [campo, valor] of valores) {
        if (valor.texto !== null) fila[campo] = valor.texto;
        else if (valor.valor !== null) fila[campo] = valor.valor;
      }
      dias[fecha] = fila;
    }
    return c.json({ oldest, newest, hoy: newest, campos, dias });
  });

  // -------------------------------------------------------------- material
  app.get("/material", async (c) => {
    const store = new MaterialStore(c.env.DB);
    const [articulos, categorias] = await Promise.all([
      store.listar({ incluirRetirados: true }),
      store.categorias(),
    ]);
    return c.json({ articulos, categorias });
  });

  // ------------------------------------------------------------- contrato
  app.get("/contract", async (c) => {
    const config = configFromEnv(c.env);
    const store = new ContractStore(c.env.DB, config.today);
    return c.json(await store.snapshot());
  });

  app.get("/log", async (c) => {
    const config = configFromEnv(c.env);
    const store = new ContractStore(c.env.DB, config.today);
    const limit = clampInt(c.req.query("limit"), 50, 1, 200);
    // antes_id pagina sin perder entradas del mismo día; antes_de (fecha) se mantiene.
    const antesId = parseInt(c.req.query("antes_id") ?? "", 10);
    if (Number.isFinite(antesId)) {
      return c.json({ entradas: await store.logAntesDeId(limit, antesId) });
    }
    return c.json({ entradas: await store.log(limit, c.req.query("antes_de") || undefined) });
  });

  // ---------------------------------------------------------- importación
  // Migración de una instalación antigua (contrato en la zona 2099 de
  // intervals.icu). El panel ya no la ofrece; queda para quien venga de ahí.
  app.post("/import/preview", async (c) => {
    const config = configFromEnv(c.env);
    if (!config.intervals) {
      return c.json({ error: "No hay intervals.icu configurado: no hay nada que importar." }, 404);
    }
    const client = new IntervalsClient(config);
    const preview = await buildPreview(client, config.today());
    return c.json(preview);
  });

  app.post("/import/apply", async (c) => {
    const config = configFromEnv(c.env);
    const store = new ContractStore(c.env.DB, config.today);
    let body: { preview?: ImportPreview; incluirLogs?: boolean; incluirCondiciones?: boolean; incluirCarreras?: boolean };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "El cuerpo debe ser JSON." }, 400);
    }
    if (!body.preview) {
      return c.json({ error: "Falta 'preview': llama antes a /import/preview y reenvía su resultado." }, 400);
    }
    const version = await store.version();
    if (version > 0) {
      return c.json(
        {
          error:
            `El contrato ya tiene datos (v${version}). La importación solo se aplica sobre ` +
            "una base vacía para no duplicar reglas.",
        },
        409,
      );
    }
    try {
      const result = await applyImport(store, body.preview, {
        incluirLogs: body.incluirLogs ?? true,
        incluirCondiciones: body.incluirCondiciones ?? true,
        incluirCarreras: body.incluirCarreras ?? true,
      });
      return c.json(result);
    } catch (exc) {
      return c.json(errJson(exc), exc instanceof ContractError ? 400 : 500);
    }
  });

  return app;
}
