/**
 * Garmin en el panel: enlazar la cuenta, ver a quién está enlazada y soltarla.
 *
 * El enlace se hace UNA vez y a mano. No es pereza: entrar cuesta ~2 s, pasa
 * por la WAF de Garmin y las IPs de salida de Cloudflare son compartidas, así
 * que repetir el login es la forma más rápida de acabar limitados. A partir de
 * aquí se vive del `refresh_token`, y la contraseña no se guarda en ningún
 * sitio: se usa en la petición de enlace y se olvida.
 *
 * El eco sigue aquí como diagnóstico para cuando algo falle: distingue «Garmin
 * nos ha cerrado la puerta» de «nos hemos equivocado nosotros».
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { GarminAlmacen } from "../garmin/almacen";
import { GarminCliente, GarminError } from "../garmin/cliente";
import { sondaEco } from "../garmin/sonda";
import { COLORES, CSS_BASE } from "./estilo";

/** Los errores de Garmin ya están escritos para leerse; el resto, no. */
function fallo(exc: unknown): { error: string; codigo: string } {
  if (exc instanceof GarminError) return { error: exc.message, codigo: exc.codigo };
  return {
    error: exc instanceof Error ? exc.message : String(exc),
    codigo: "desconocido",
  };
}

export function garminApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const almacen = (env: Env): GarminAlmacen => new GarminAlmacen(env.DB, env.SESSION_SECRET);

  app.get("/", (c) => c.html(paginaGarmin()));

  app.get("/estado", async (c) => {
    try {
      return c.json((await almacen(c.env).estado()) ?? { enlazada: false });
    } catch (exc) {
      return c.json(fallo(exc), 500);
    }
  });

  app.post("/enlazar", async (c) => {
    let cuerpo: { email?: string; password?: string };
    try {
      cuerpo = (await c.req.json()) as typeof cuerpo;
    } catch {
      return c.json({ error: "El cuerpo debe ser JSON." }, 400);
    }
    const email = String(cuerpo.email ?? "").trim();
    const password = String(cuerpo.password ?? "");
    if (!email || !password) {
      return c.json({ error: "Faltan el correo o la contraseña de Garmin." }, 400);
    }
    try {
      const cliente = new GarminCliente(almacen(c.env));
      const { displayName } = await cliente.enlazar(email, password);
      return c.json({ enlazada: true, displayName });
    } catch (exc) {
      const detalle = fallo(exc);
      // 401 solo cuando la culpa es de las credenciales; lo demás no lo arregla
      // el atleta escribiendo mejor.
      return c.json(detalle, detalle.codigo === "credenciales" ? 401 : 502);
    }
  });

  app.post("/desenlazar", async (c) => {
    try {
      await almacen(c.env).borrar();
      return c.json({ enlazada: false });
    } catch (exc) {
      return c.json(fallo(exc), 500);
    }
  });

  app.post("/eco", async (c) => c.json(await sondaEco()));

  return app;
}

function paginaGarmin(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="${COLORES.arena}">
<link rel="icon" href="/icono.svg?v=2" type="image/svg+xml">
<title>Garmin · zancada</title>
<style>
${CSS_BASE}
  body { padding: 0 0 64px; }
  main { width: 100%; max-width: 620px; margin: 0 auto; padding: 20px 16px; display: grid; gap: 16px; }
  h1 { font-family: Bungee, sans-serif; font-weight: 400; font-size: 24px; color: var(--mar); }
  h2 { font-family: Bungee, sans-serif; font-weight: 400; font-size: 15px; }
  p.sub, p.nota { color: var(--apagado); font-size: 13px; line-height: 1.55; }
  .card {
    border: 2px solid var(--tinta); border-radius: 12px; background: var(--sup);
    padding: 16px; display: grid; gap: 12px;
  }
  input {
    min-height: 46px; padding: 0 12px; border-radius: 8px; width: 100%; font-size: 16px;
    background: var(--blanco); color: var(--tinta); border: 2px solid var(--tinta);
  }
  button {
    min-height: 46px; padding: 0 14px; border: 2px solid var(--tinta); border-radius: 8px;
    background: var(--coral); color: var(--crema); cursor: pointer;
    font-family: Bungee, sans-serif; font-size: 14px; box-shadow: 0 3px 0 var(--tinta);
  }
  button.suave { background: var(--sup); color: var(--tinta); font-family: Silkscreen, monospace; font-size: 11px; }
  button.riesgo { background: var(--sup); color: var(--coral); }
  button[disabled] { opacity: .5; cursor: progress; }
  .aviso { border: 2px solid var(--tinta); border-radius: 12px; padding: 12px; font-size: 14px; line-height: 1.55; }
  .bien { background: var(--bien); }
  .mal  { background: var(--coral); color: var(--crema); }
  .duda { background: var(--sol); color: #1E1A14; }
  .etiqueta { font-family: Silkscreen, monospace; text-transform: uppercase; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 7px 6px; border-bottom: 2px solid var(--dim); }
  th { color: var(--apagado); font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  code { color: var(--apagado); font-size: 11.5px; word-break: break-all; }
  details summary { cursor: pointer; color: var(--mar); font-size: 13px; }
</style>
</head>
<body>
<div class="pintas" aria-hidden="true"></div>
<main>
  <div>
    <h1>Garmin Connect</h1>
    <p class="sub">
      Enlaza tu cuenta una vez y la app hablará con Garmin directamente: es de
      donde salen todos los datos del panel y del entrenador. <a href="/app#mas">← Volver al panel</a>
    </p>
  </div>

  <div id="estado"></div>

  <section class="card" id="formulario">
    <h2>Enlazar la cuenta</h2>
    <p class="nota">
      Tu contraseña viaja de este Worker a Garmin y se olvida: <strong>no se guarda</strong>
      ni en la base de datos ni en los logs. Lo que se guarda es el token que Garmin
      devuelve, cifrado, y se renueva solo. Si tu cuenta pide segundo factor, dímelo:
      ese paso todavía no está implementado.
    </p>
    <input id="email" type="email" placeholder="Correo de Garmin Connect" autocomplete="off">
    <input id="password" type="password" placeholder="Contraseña de Garmin" autocomplete="off">
    <button id="enlazar">Enlazar</button>
  </section>

  <details class="card">
    <summary>Diagnóstico: ¿nos atiende Garmin?</summary>
    <p class="nota">
      Tres lecturas públicas, sin credenciales. Sirve para saber si un fallo es de
      Garmin —que nos haya cerrado la puerta o limitado por IP— o nuestro.
    </p>
    <button class="suave" id="eco">Lanzar eco</button>
    <div id="salidaEco"></div>
  </details>
</main>
<script>
const $ = (id) => document.getElementById(id);

function escapar(t) {
  return String(t).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function fecha(iso) {
  try { return new Date(iso).toLocaleString("es-ES"); } catch (e) { return iso; }
}

async function pintarEstado() {
  const r = await fetch("/app/garmin/estado");
  const datos = await r.json();
  if (datos.enlazada) {
    const caduca = datos.expiraEn > Date.now()
      ? "el token caduca en " + Math.round((datos.expiraEn - Date.now()) / 60000) + " min y se renueva solo"
      : "el token ha caducado y se renovará en la próxima llamada";
    $("estado").innerHTML =
      '<div class="aviso bien"><div class="etiqueta">Enlazada</div>' +
      '<p style="margin-top:6px">Cuenta <strong>' + escapar(datos.displayName || "(sin nombre)") + '</strong>, ' +
      'enlazada el ' + escapar(fecha(datos.enlazadoEn)) + '. ' + escapar(caduca) + '.</p>' +
      '<p style="margin-top:10px"><button class="riesgo" id="desenlazar">Desenlazar</button></p></div>';
    $("desenlazar").addEventListener("click", desenlazar);
    $("formulario").style.display = "none";
  } else {
    $("estado").innerHTML =
      '<div class="aviso duda"><div class="etiqueta">Sin enlazar</div>' +
      '<p style="margin-top:6px">Todavía no hay ninguna cuenta de Garmin enlazada.</p></div>';
    $("formulario").style.display = "";
  }
}

async function desenlazar() {
  if (!confirm("¿Soltar la cuenta de Garmin? Se borra el token guardado.")) return;
  await fetch("/app/garmin/desenlazar", { method: "POST" });
  await pintarEstado();
}

$("enlazar").addEventListener("click", async function (e) {
  const boton = e.target;
  boton.disabled = true;
  $("estado").innerHTML = '<div class="aviso duda">Entrando en Garmin… (tarda un par de segundos)</div>';
  try {
    const r = await fetch("/app/garmin/enlazar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: $("email").value, password: $("password").value }),
    });
    const datos = await r.json();
    if (!r.ok) {
      $("estado").innerHTML = '<div class="aviso mal"><div class="etiqueta">' +
        escapar(datos.codigo || "error") + '</div><p style="margin-top:6px">' +
        escapar(datos.error) + '</p></div>';
      return;
    }
    $("password").value = "";
    await pintarEstado();
  } catch (err) {
    $("estado").innerHTML = '<div class="aviso mal">No se pudo hablar con el Worker: ' + escapar(err) + '</div>';
  } finally {
    boton.disabled = false;
  }
});

$("eco").addEventListener("click", async function (e) {
  const boton = e.target;
  boton.disabled = true;
  $("salidaEco").innerHTML = '<p class="nota">Preguntando a Garmin…</p>';
  try {
    const r = await fetch("/app/garmin/eco", { method: "POST" });
    const datos = await r.json();
    const tono = datos.veredicto === "paso-libre" ? "bien"
      : (datos.veredicto === "bloqueado" || datos.veredicto === "limitado") ? "mal" : "duda";
    const filas = (datos.pasos || []).map(function (p) {
      return '<tr><td>' + escapar(p.paso) + '<br><code>' + escapar(p.url) + '</code></td>' +
             '<td class="num">' + (p.estado === null ? "—" : p.estado) + '</td>' +
             '<td class="num">' + p.ms + ' ms</td>' +
             '<td>' + escapar(p.detalle) + '</td></tr>';
    }).join("");
    $("salidaEco").innerHTML =
      '<div class="aviso ' + tono + '" style="margin-top:12px"><div class="etiqueta">' +
      escapar(datos.veredicto) + '</div><p style="margin-top:6px">' + escapar(datos.resumen) + '</p></div>' +
      '<table style="margin-top:12px"><thead><tr><th>Paso</th><th class="num">HTTP</th>' +
      '<th class="num">Tiempo</th><th>Lectura</th></tr></thead><tbody>' + filas + '</tbody></table>';
  } finally {
    boton.disabled = false;
  }
});

pintarEstado();
</script>
</body>
</html>`;
}
