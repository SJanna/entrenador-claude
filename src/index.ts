/**
 * zancada: Worker único con tres caras.
 *  - /:secreto/mcp   → servidor MCP (streamable HTTP, stateless) para Claude.
 *  - /app            → panel web (login con contraseña + cookie firmada).
 *  - /healthz        → health check público.
 * La base de datos D1 guarda el contrato de entrenamiento: la app es la
 * fuente de verdad; intervals.icu guarda entrenos, actividades y bienestar.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./env";
import { ConfigError, configFromEnv, configParaEntrenador, timingSafeEqual, todayInTz } from "./env";
import { buildTools, serverInstructions } from "./tools/registry";
import { handleMcpRequest } from "./mcp/server";
import { apiApp } from "./web/api";
import {
  checkPassword,
  clearSessionCookie,
  createSessionCookie,
  verifySessionCookie,
} from "./web/auth";
import { loginPage } from "./web/login";
import { appPage } from "./web/app";
import { garminApp } from "./web/garmin";
import { fuenteWoff2 } from "./web/estilo";
import { IntervalsClient } from "./intervals/client";
import { sincronizarRachas } from "./streaks/servicio";
import { calcularPublico } from "./publico/servicio";
import { sincronizarHistorico, PRESUPUESTO_POR_DEFECTO } from "./historico/sincronizar";
import { HistoricoStore } from "./historico/store";
import { GarminCliente } from "./garmin/cliente";
import { GarminAlmacen } from "./garmin/almacen";

const app = new Hono<{ Bindings: Env }>();

app.onError((exc, c) => {
  if (exc instanceof ConfigError) {
    return c.json({ error: exc.message }, 500);
  }
  console.error("Error no capturado", exc);
  return c.json({ error: "Error interno. Revisa los logs del Worker." }, 500);
});

// ------------------------------------------------------------------ salud
//
// «Si las herramientas no están disponibles, dilo y no programes» (§3). Para
// poder cumplirlo hay que poder comprobarlo desde fuera, y un {status:"ok"} fijo
// respondía igual con la base caída. Ahora dice QUÉ despliegue está vivo y si la
// base contesta; si no contesta, responde 503 en vez de fingir que todo va bien.
app.get("/healthz", async (c) => {
  const despliegue = c.env.CF_VERSION_METADATA;
  const salida: Record<string, unknown> = { status: "ok", service: "zancada" };
  if (despliegue?.id) salida.version = despliegue.id;
  if (despliegue?.tag) salida.tag = despliegue.tag;
  if (despliegue?.timestamp) salida.desplegado = despliegue.timestamp;
  // Qué panel lleva este despliegue: si el navegador pide una ruta que este
  // número no conoce, el despliegue es más viejo que el panel.
  salida.panel = "zancada-2";

  try {
    const fila = await c.env.DB.prepare(
      "SELECT valor FROM meta WHERE clave = 'version'",
    ).first<{ valor: string }>();
    salida.contrato = `v${parseInt(fila?.valor ?? "0", 10) || 0}`;
    // Qué migración es la última aplicada: la 0006 estuvo semanas sin aplicar
    // en producción con el código ya desplegado, y nada lo decía.
    try {
      const mig = await c.env.DB.prepare(
        "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
      ).first<{ name: string }>();
      if (mig?.name) salida.esquema = mig.name;
    } catch {
      salida.esquema = "desconocido";
    }
    const conIntervals = Boolean(
      (c.env.INTERVALS_API_KEY || "").trim() && (c.env.INTERVALS_ATHLETE_ID || "").trim(),
    );
    salida.modulos = {
      intervals: conIntervals,
      intervals_en_entrenador:
        conIntervals && (c.env.INTERVALS_EN_ENTRENADOR || "").trim().toLowerCase() !== "no",
      publico: Boolean(c.env.PUBLICO),
    };
  } catch (exc) {
    salida.status = "sin base de datos";
    salida.error = exc instanceof Error ? exc.message : String(exc);
    return c.json(salida, 503);
  }
  return c.json(salida);
});

// ------------------------------------------------------------------ login
app.get("/login", async (c) => {
  if (await verifySessionCookie(c.req.header("Cookie"), c.env.SESSION_SECRET)) {
    return c.redirect("/app");
  }
  return c.html(loginPage(false));
});

app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const password = String(form["password"] ?? "");
  if (!c.env.APP_PASSWORD || !(await checkPassword(password, c.env.APP_PASSWORD))) {
    return c.html(loginPage(true), 401);
  }
  c.header("Set-Cookie", await createSessionCookie(c.env.SESSION_SECRET));
  return c.redirect("/app");
});

app.post("/logout", (c) => {
  c.header("Set-Cookie", clearSessionCookie());
  return c.redirect("/login");
});

// ------------------------------------------------------- panel (con login)
app.use("/app/*", async (c, next) => {
  if (!(await verifySessionCookie(c.req.header("Cookie"), c.env.SESSION_SECRET))) {
    if (c.req.path.startsWith("/app/api/")) {
      return c.json({ error: "Sesión caducada: vuelve a entrar." }, 401);
    }
    return c.redirect("/login");
  }
  await next();
});

app.get("/app", (c) => c.html(appPage()));
app.route("/app/api", apiApp());
// Sonda de viabilidad de Garmin: diagnóstico temporal, fuera de la API del panel.
app.route("/app/garmin", garminApp());

// ------------------------------------------------------------ endpoint MCP
/** ¿El secreto presentado es el bueno? Comparación en tiempo constante. */
function mcpAutorizado(env: Env, presentado: string): boolean {
  const expected = (env.MCP_SECRET_PATH || "").trim();
  return Boolean(expected) && timingSafeEqual(presentado, expected);
}

function despacharMcp(c: Context<{ Bindings: Env }>): Promise<Response> {
  const config = configParaEntrenador(c.env);
  return handleMcpRequest(c.req.raw, {
    name: "zancada",
    title: "Zancada · entrenador (Garmin + contrato)",
    version: "1.1.0",
    instructions: serverInstructions({
      intervals: config.intervals,
      publico: Boolean(c.env.PUBLICO),
    }),
    tools: buildTools(c.env, config, (p) => c.executionCtx.waitUntil(p)),
  });
}

/**
 * Forma preferida: el secreto viaja en `Authorization: Bearer …`.
 * La ruta con el secreto dentro (más abajo) sigue funcionando, pero deja el
 * secreto escrito en los logs del Worker, que registran la URL completa.
 */
app.post("/mcp", async (c) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!mcpAutorizado(c.env, token)) {
    return c.json({ error: "No autorizado." }, 401, {
      "WWW-Authenticate": 'Bearer realm="zancada"',
    });
  }
  return despacharMcp(c);
});

app.all("/mcp", (c) => new Response(null, { status: 405, headers: { Allow: "POST" } }));

app.post("/:secret/mcp", async (c) => {
  if (!mcpAutorizado(c.env, c.req.param("secret"))) return c.notFound();
  return despacharMcp(c);
});

app.all("/:secret/mcp", async (c) => {
  if (!mcpAutorizado(c.env, c.req.param("secret"))) return c.notFound();
  // GET/DELETE sobre el endpoint MCP en modo stateless.
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
});

// ------------------------------------------------------- instalable (PWA)
// Público a propósito: no lleva ningún dato, solo cómo abrir la app. Va fuera
// de /app porque el navegador pide el manifest sin la cookie de sesión.
// La Z de zancada en la rejilla de 12×12 de los iconos pixel: mar sobre arena,
// con el borde de tinta de las tarjetas.
const ICONO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<rect width="512" height="512" rx="112" fill="#F6EBD3"/>' +
  '<rect x="20" y="20" width="472" height="472" rx="96" fill="none" stroke="#1E1A14" stroke-width="24"/>' +
  '<g transform="translate(64 64) scale(32)" shape-rendering="crispEdges">' +
  '<path fill="#0E6F79" d="M2 2h8v1h-8zM2 3h8v1h-8zM7 4h2v1h-2zM6 5h2v1h-2zM5 6h2v1h-2zM4 7h2v1h-2zM3 8h2v1h-2zM2 9h8v1h-8zM2 10h8v1h-8z"/>' +
  '</g></svg>';

// Tipografías de la identidad. Públicas (el login también las usa) y con caché
// larga: no cambian sin cambiar de nombre.
app.get("/fuentes/:nombre{[a-z]+\\.woff2}", (c) => {
  const bytes = fuenteWoff2(c.req.param("nombre").replace(/\.woff2$/, ""));
  if (!bytes) return c.notFound();
  return c.body(bytes, 200, {
    "Content-Type": "font/woff2",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});

app.get("/icono.svg", (c) =>
  c.body(ICONO_SVG, 200, {
    "Content-Type": "image/svg+xml",
    // Una hora: un icono nuevo tiene que verse el mismo día, no al siguiente.
    "Cache-Control": "max-age=3600",
  }),
);

app.get("/manifest.webmanifest", (c) =>
  c.json(
    {
      name: "zancada",
      short_name: "zancada",
      start_url: "/app",
      scope: "/",
      display: "standalone",
      background_color: "#F6EBD3",
      theme_color: "#F6EBD3",
      lang: "es",
      icons: [
        { src: "/icono.svg?v=2", sizes: "any", type: "image/svg+xml", purpose: "any" },
        { src: "/icono.svg?v=2", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      ],
    },
    200,
    { "Content-Type": "application/manifest+json", "Cache-Control": "max-age=86400" },
  ),
);

// ------------------------------------------------------------------- raíz
app.get("/", (c) => c.redirect("/app"));

/**
 * Cron nocturno: reescribe el resumen diario de los últimos días para que el
 * histórico de rachas siga creciendo aunque nadie abra el panel. Es un seguro:
 * cada lectura del panel o del MCP también persiste lo que trae en vivo.
 */
async function refrescarRachas(env: Env, cron: string): Promise<void> {
  try {
    const config = configFromEnv(env);
    if (!config.intervals) return; // las rachas salen de intervals: sin él no hay nada que refrescar
    const client = new IntervalsClient(config);
    const escritos = await sincronizarRachas(env.DB, client, config);
    console.log(`cron ${cron}: ${escritos} días de rachas actualizados.`);
  } catch (exc) {
    // Un fallo de intervals no debe reventar el cron: mañana se reintenta y,
    // mientras tanto, las lecturas siguen yendo en vivo.
    console.error("cron de rachas: no se pudo actualizar", exc);
  }
}

/**
 * Cron nocturno de la página pública: calcula los agregados y, si pasan la
 * lista blanca, los publica en KV. Si falla, la página sigue con lo de ayer.
 */
async function publicarProgreso(env: Env, cron: string): Promise<void> {
  try {
    if (!env.PUBLICO) return; // módulo opcional: sin KV no hay página pública
    const config = configFromEnv(env);
    if (!config.intervals) return;
    const r = await calcularPublico(env, config, { publicar: true });
    console.log(
      `cron ${cron}: página pública ${r.publicado ? "publicada" : "NO publicada"}` +
        (r.avisos.length ? ` · ${r.avisos.join(" · ")}` : ""),
    );
  } catch (exc) {
    console.error("cron de la página pública: no se pudo calcular", exc);
  }
}

/**
 * Cron horario del histórico de Garmin: cada ejecución gasta un presupuesto de
 * llamadas y deja apuntado por dónde va. Así la carga inicial se reparte en
 * horas sin pasar del límite de subpeticiones de un Worker ni enfadar a Garmin.
 */
async function sincronizarGarmin(env: Env, cron: string): Promise<void> {
  try {
    const store = new HistoricoStore(env.DB);
    if (!(await store.disponible())) return;
    // Sin configFromEnv a propósito: el histórico es de Garmin y no debe caerse
    // porque intervals esté mal configurado.
    const hoy = todayInTz((env.INTERVALS_TZ || "").trim() || "UTC");
    const cliente = new GarminCliente(new GarminAlmacen(env.DB, env.SESSION_SECRET));
    const presupuesto = Number(env.HISTORICO_PRESUPUESTO) || PRESUPUESTO_POR_DEFECTO;
    const r = await sincronizarHistorico(cliente, store, hoy, { presupuesto });
    console.log(
      `cron ${cron}: histórico Garmin · ${r.llamadas} llamadas · ${r.actividadesNuevas} actividades nuevas · ` +
        `${r.detalles} series · ${r.dias} días` + (r.parado ? ` · parada: ${r.parado}` : ""),
    );
  } catch (exc) {
    console.error("cron del histórico de Garmin: no se pudo sincronizar", exc);
  }
}

/** Las tareas diarias van en la ejecución de las 08:00 UTC (03:00 en Bogotá). */
const HORA_DIARIA_UTC = 8;

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // También con el cron diario antiguo ("0 8 * * *"), por si una instalación lo conserva.
    const diaria =
      event.cron === "0 8 * * *" || new Date(event.scheduledTime).getUTCHours() === HORA_DIARIA_UTC;
    // La ejecución diaria NO sincroniza el histórico: comparte el límite de
    // consultas de la invocación con rachas y página pública. Pierde una hora de 24.
    if (diaria) {
      // Independientes: que falle una no deja a las otras sin hacer.
      await Promise.all([refrescarRachas(env, event.cron), publicarProgreso(env, event.cron)]);
    } else {
      await sincronizarGarmin(env, event.cron);
    }
  },
} satisfies ExportedHandler<Env>;
