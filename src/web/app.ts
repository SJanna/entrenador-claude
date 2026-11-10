/**
 * Panel «zancada»: SPA autocontenida, móvil primero y a dos columnas en
 * escritorio. Identidad en estilo.ts.
 *
 * Todo sale de Garmin (histórico en D1 y calendario), del contrato, del diario
 * y del material. El panel solo pinta: los cálculos viven en panelDatos.ts y
 * son los mismos que lee el entrenador.
 *
 * El JavaScript va en un String.raw: sin comillas invertidas ni "${" dentro, y
 * sin la etiqueta de cierre del script (los tests lo vigilan).
 */

import { COLORES, CSS_BASE } from "./estilo";

const CSS_PANEL = `
body { padding-bottom: calc(76px + env(safe-area-inset-bottom)); }
header.hud {
  position: sticky; top: 0; z-index: 20; background: var(--arena);
  border-bottom: 2px solid var(--tinta);
}
header.hud .fila {
  max-width: 1120px; margin: 0 auto; display: flex; align-items: center; gap: 12px;
  padding: 10px 16px;
}
header.hud .logo { font-family: Bungee, sans-serif; font-size: 20px; color: var(--mar); text-decoration: none; }
header.hud #fecha-hoy { margin-right: auto; }
header.hud #version-chip { display: none; }
#refrescar {
  min-height: 40px; min-width: 40px; padding: 0 10px; display: inline-flex; align-items: center; justify-content: center;
}
#refrescar[data-cargando="1"] svg { animation: gira 1s linear infinite; }
@keyframes gira { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { #refrescar[data-cargando="1"] svg { animation: none; } }
main#contenido {
  max-width: 1120px; margin: 0 auto; padding: 12px 16px 24px;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px;
}
.col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
nav#tabs {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
  border-top: 2px solid var(--tinta); background: var(--sup);
  display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
  padding: 6px 0 calc(8px + env(safe-area-inset-bottom));
}
nav#tabs a {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  min-height: 48px; text-decoration: none; color: var(--apagado);
  font-family: Silkscreen, monospace; font-size: 10px;
}
nav#tabs a[aria-current="page"] { color: var(--coral); }
@media (min-width: 900px) {
  body { padding-bottom: 0; }
  main#contenido { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; padding: 20px 24px 40px; }
  main#contenido.una { grid-template-columns: minmax(0, 720px); justify-content: center; }
  .col { gap: 16px; }
  header.hud { position: static; }
  nav#tabs {
    position: sticky; top: 0; bottom: auto; z-index: 19; border-top: 0;
    border-bottom: 2px solid var(--tinta); display: flex; justify-content: center; gap: 4px; padding: 0 16px;
  }
  nav#tabs a { flex-direction: row; gap: 8px; padding: 0 16px; font-size: 11px; min-height: 46px; }
  nav#tabs a[aria-current="page"] { box-shadow: inset 0 -4px 0 var(--coral); }
}
.titulo { font-family: Bungee, sans-serif; font-size: 15px; line-height: 1.2; }
.cifra-xl { font-family: Bungee, sans-serif; font-size: 64px; line-height: .9; }
.cifra-l { font-family: Bungee, sans-serif; font-size: 26px; line-height: 1; }
.cifra-m { font-family: Bungee, sans-serif; font-size: 20px; line-height: 1; }
.sub { font-size: 13px; color: var(--apagado); }
.fila-sep { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.xp { display: grid; gap: 3px; }
.xp i { height: 12px; border-radius: 2px; background: var(--dim); }
.xp i.on { background: var(--mar); }
.xp i.alerta { background: var(--coral); }
.rejilla2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.rejilla2 .tarjeta { gap: 4px; }
.ficha { border: 2px solid var(--tinta); border-radius: 12px; background: var(--sup); overflow: hidden; }
.ficha-cab {
  background: var(--negro); color: var(--sobre-negro); padding: 7px 12px;
  display: flex; justify-content: space-between; gap: 8px;
  font-family: Silkscreen, monospace; font-size: 10px; text-transform: uppercase;
}
.ficha-cuerpo { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.negra { background: var(--negro); color: var(--sobre-negro); border-color: var(--tinta); }
.negra .etq { color: var(--sol); }
.negra a { color: var(--enlace-negro); }
.coral { background: var(--coral); color: var(--crema); }
.coral .etq { color: var(--crema); }
.teclas { display: grid; gap: 4px; }
.teclas .tecla { padding: 0; min-height: 42px; font-size: 12px; }
.punto { width: 10px; height: 10px; border-radius: 2px; flex: none; display: inline-block; }
.dia { display: flex; gap: 12px; padding: 10px 12px; }
.dia.hoy { border-color: var(--coral); box-shadow: 0 0 0 1px var(--coral); }
.dia .num { width: 40px; display: flex; flex-direction: column; align-items: center; flex: none; }
.dia .lineas { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.linea { display: flex; justify-content: space-between; gap: 8px; font-size: 14px; }
.linea .nom { display: flex; align-items: center; gap: 8px; min-width: 0; }
.linea .nom span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.linea .val { color: var(--apagado); white-space: nowrap; }
.linea.plan { color: var(--apagado); }
.linea.plan .punto { background: transparent !important; border: 2px solid currentColor; }
.banda { position: relative; height: 12px; border: 2px solid var(--tinta); border-radius: 3px; background: var(--sup); }
.banda .zona { position: absolute; top: 0; bottom: 0; background: var(--dim); }
.banda .marca { position: absolute; top: -6px; width: 4px; height: 20px; background: var(--mar); margin-left: -2px; }
.banda .marca.alerta { background: var(--coral); }
.seg3, .seg4 { display: grid; gap: 6px; }
.seg3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.seg4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 440px) { .seg4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.seg3 .tecla, .seg4 .tecla { padding: 0 4px; min-height: 40px; font-size: 10px; }
.regla .cab { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.regla .cab .etq { font-size: 10px; }
.regla .id { color: var(--mar); }
.regla p { font-size: 14px; }
.regla details summary { cursor: pointer; font-size: 13px; color: var(--mar); list-style: none; }
.regla details summary::-webkit-details-marker { display: none; }
.regla .largo { font-size: 13px; color: var(--apagado); white-space: pre-wrap; margin-top: 6px; }
.lista-filas { padding: 0; overflow: hidden; gap: 0; }
.lista-filas > a, .lista-filas > .fila {
  min-height: 56px; padding: 8px 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px;
  text-decoration: none; color: var(--tinta); border-bottom: 2px solid var(--tinta);
}
.lista-filas > :last-child { border-bottom: 0; }
.vacio { font-size: 14px; color: var(--apagado); }
.error-caja {
  border: 2px solid var(--tinta); border-radius: 12px; background: var(--coral); color: var(--crema);
  padding: 10px 12px; font-size: 14px;
}
.cargando { font-family: Silkscreen, monospace; font-size: 11px; color: var(--apagado); padding: 8px 2px; }
.form { display: flex; flex-direction: column; gap: 8px; }
.form .doble { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
details.plegable > summary { cursor: pointer; list-style: none; }
details.plegable > summary::-webkit-details-marker { display: none; }
.mapa { display: grid; grid-template-columns: repeat(20, minmax(0, 1fr)); gap: 3px; }
.mapa i { aspect-ratio: 1; border-radius: 2px; background: var(--dim); }
.mapa i.activo { background: var(--mar); }
.mapa i.descanso { background: var(--sol); }
.mapa i.fallado { background: var(--coral); }
.mapa i.pendiente { background: transparent; border: 2px solid var(--dim); }
.svg-graf { width: 100%; height: auto; display: block; }
.leyenda { display: flex; flex-wrap: wrap; gap: 12px; font-family: Silkscreen, monospace; font-size: 10px; color: var(--apagado); }
.volver { align-self: flex-start; min-height: 40px; }
.ico { display: inline-flex; flex: none; line-height: 0; }
.dias-diario { display: grid; gap: 3px; }
.dia-diario { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 0; }
.celda {
  width: 100%; aspect-ratio: 1; border-radius: 3px; display: flex; align-items: center; justify-content: center;
  font-family: Bungee, sans-serif; font-size: 11px;
}
.celda.vacio { border: 2px dashed var(--dim); }
.celda.bien { background: var(--bien); color: var(--tinta); }
.celda.malo { background: var(--coral); color: var(--crema); }
.pix { display: block; }
nav#tabs a .pix { width: 20px; height: 20px; }
.nota { font-size: 12px; color: var(--apagado); line-height: 1.35; }
.heroe { border-width: 3px; }
.heroe .ficha-cab { background: var(--coral); color: var(--crema); }
.senales { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
@media (min-width: 520px) { .senales { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.senal {
  border: 2px solid var(--tinta); border-radius: 10px; background: var(--arena);
  padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; min-width: 0;
}
.senal.alerta { border-color: var(--coral); box-shadow: inset 0 0 0 1px var(--coral); }
.senal.alerta .cifra-m { color: var(--coral); }
.senal-cab { display: flex; align-items: center; gap: 6px; }
.senal-cab .etq { font-size: 10px; }
.consejo {
  display: flex; gap: 10px; align-items: flex-start; font-size: 13px;
  border: 2px dashed var(--coral); border-radius: 10px; padding: 8px 10px;
}
a.tarjeta { text-decoration: none; color: var(--tinta); }
.tarjeta.mini { gap: 4px; padding: 10px 12px; }
a.tarjeta.negra { color: var(--sobre-negro); }
a.tarjeta.coral { color: var(--crema); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

const SCRIPT = String.raw`
"use strict";
var S = {
  ruta: "hoy", sub: null,
  datos: {}, cargando: {}, errores: {},
  lunes: null, dias: 28, ctab: "reglas", busca: "", diarioFecha: null,
  logExtra: [], logFin: false
};

var DIAS_C = ["DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"];
var MESES_C = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];

var TABS = [
  { id: "hoy", nombre: "HOY" }, { id: "semana", nombre: "SEMANA" }, { id: "progreso", nombre: "PROGRESO" },
  { id: "contrato", nombre: "CONTRATO" }, { id: "mas", nombre: "MÁS" }
];

// ------------------------------------------------------------ iconos pixel
// Rejillas de 12×12, como las de la página pública: un «#» es un píxel lleno.
// Se pintan con currentColor y bordes nítidos, así que toman el color del texto.
var PIXEL = {
  hoy: [".....##.....", ".#...##...#.", "..#......#..", "....####....", "...######...", "##.######.##", "##.######.##", "...######...", "....####....", "..#......#..", ".#...##...#.", ".....##....."],
  semana: ["..#.....#...", "############", "#..#.....#.#", "############", "#..........#", "#.##.##.##.#", "#.##.##.##.#", "#..........#", "#.##.##....#", "#.##.##....#", "#..........#", "############"],
  progreso: ["............", ".........##.", ".........##.", ".....##..##.", ".....##..##.", ".##..##..##.", ".##..##..##.", ".##..##..##.", ".##..##..##.", ".##..##..##.", "############", "............"],
  contrato: [".#######....", ".#.....##...", ".#.....###..", ".#.......#..", ".#.#####.#..", ".#.......#..", ".#.#####.#..", ".#.......#..", ".#.###...#..", ".#.......#..", ".#########..", "............"],
  mas: ["............", "............", "............", "............", "............", ".##..##..##.", ".##..##..##.", "............", "............", "............", "............", "............"],
  sueno: [".....####...", "...###......", "..##........", ".##......#..", ".##.....###.", "##.......#..", "##..........", "##.......##.", ".##.....##..", ".###...###..", "..#######...", "....###....."],
  fc: ["............", ".###....###.", "#####..#####", "############", "############", "############", ".##########.", "..########..", "...######...", "....####....", ".....##.....", "............"],
  vfc: ["............", "......#.....", "......#.....", ".....#.#....", ".....#.#....", "##...#.#...#", ".#..#..#..##", "..##...#.#..", ".......##...", ".......#....", "............", "............"],
  bateria: ["............", "............", "##########..", "#........#..", "#.##.##..###", "#.##.##..###", "#.##.##..###", "#........#..", "##########..", "............", "............", "............"],
  rayo: ["......###...", ".....###....", "....###.....", "...###......", "..########..", ".......###..", "......###...", ".....###....", "....###.....", "...##.......", "..#.........", "............"],
  zapatilla: ["............", "............", "............", "...###......", "...#.##.....", "...#..###...", "..##....####", ".#.........#", "############", ".##.##.##.#.", "............", "............"],
  lapiz: [".........##.", "........####", ".......####.", "......####..", ".....####...", "....####....", "...####.....", "..####......", ".#.##.......", ".##.........", "###.........", "............"],
  candado: ["....####....", "...#....#...", "...#....#...", "...#....#...", "..########..", "..########..", "..###..###..", "..###..###..", "..###.####..", "..########..", "..########..", "............"],
  alerta: [".....##.....", "....####....", "....#..#....", "...##..##...", "...##..##...", "..###..###..", "..###..###..", ".##########.", ".####..####.", "############", "............", "............"],
  bandera: [".#..........", ".########...", ".#.##.##.#..", ".##.##.##...", ".#.##.##.#..", ".########...", ".#..........", ".#..........", ".#..........", ".#..........", "###.........", "............"],
  pesa: ["............", "............", ".##......##.", ".##......##.", "###......###", "############", "############", "###......###", ".##......##.", ".##......##.", "............", "............"],
  ola: ["............", "............", "............", "..##....##..", ".#..#..#..#.", "#....##....#", "............", "..##....##..", ".#..#..#..#.", "#....##....#", "............", "............"],
  check: ["............", "............", "..........##", ".........##.", "........##..", "##.....##...", ".##...##....", "..##.##.....", "...###......", "....#.......", "............", "............"]
};
function pix(nombre, tam) {
  var filas = PIXEL[nombre], d = "";
  for (var y = 0; y < filas.length; y++) {
    var x = 0;
    while (x < filas[y].length) {
      if (filas[y].charAt(x) !== "#") { x++; continue; }
      var ini = x;
      while (x < filas[y].length && filas[y].charAt(x) === "#") x++;
      d += "M" + ini + " " + y + "h" + (x - ini) + "v1h-" + (x - ini) + "z";
    }
  }
  var t = tam || 18;
  return '<svg class="pix" width="' + t + '" height="' + t + '" viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="' + d + '"></path></svg>';
}
function icono(nombre, tam, color) {
  return h("span", { class: "ico", style: color ? "color:" + color : null, html: pix(nombre, tam) });
}

// ------------------------------------------------------------ utilidades
/** Crea un nodo. text siempre escapa; html solo para marcado nuestro (iconos). */
function h(tag, attrs, hijos) {
  var n = document.createElement(tag);
  attrs = attrs || {};
  Object.keys(attrs).forEach(function (k) {
    var v = attrs[k];
    if (v === null || v === undefined || v === false) return;
    if (k === "text") n.textContent = String(v);
    else if (k === "html") n.innerHTML = v;
    else if (k === "class") n.className = v;
    else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  });
  (hijos || []).forEach(function (c) {
    if (c === null || c === undefined || c === false) return;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return n;
}

function num(v, dec) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return Number(v).toLocaleString("es-CO", { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
}
function partes(iso) { var p = iso.split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
function addDias(iso, n) { var d = partes(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function diasEntre(a, b) { return Math.round((partes(b) - partes(a)) / 86400000); }
function lunesDe(iso) { var d = partes(iso).getUTCDay(); return addDias(iso, -((d + 6) % 7)); }
function fechaCorta(iso) { var d = partes(iso); return DIAS_C[d.getUTCDay()] + " " + d.getUTCDate() + " " + MESES_C[d.getUTCMonth()]; }
function diaMes(iso) { var d = partes(iso); return d.getUTCDate() + " " + MESES_C[d.getUTCMonth()]; }
function fechaLarga(iso) { var d = partes(iso); return d.getUTCDate() + " " + MESES_C[d.getUTCMonth()] + " " + d.getUTCFullYear(); }
function duracion(seg) {
  if (!seg) return "—";
  var m = Math.round(seg / 60);
  if (m < 60) return m + " min";
  return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0") + " h";
}
function reloj(seg) {
  var s = Math.round(seg), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? hh + ":" + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0") : mm + ":" + String(ss).padStart(2, "0");
}
function ritmo(seg, m) {
  if (!seg || !m) return null;
  var pk = Math.round(seg * 1000 / m);
  return Math.floor(pk / 60) + ":" + String(pk % 60).padStart(2, "0");
}
function horasMin(seg) {
  if (!seg) return "—";
  var m = Math.round(seg / 60);
  return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0");
}

/** Cada deporte con su color fijo: el mismo en todas las pantallas. */
function claseDeporte(dep) {
  dep = String(dep || "").toLowerCase();
  if (/run|trail/.test(dep)) return { color: "var(--coral)", correr: true, icono: "zapatilla" };
  if (/swim|nata/.test(dep)) return { color: "var(--agua)", icono: "ola" };
  if (/cycl|bik|ride|bici/.test(dep)) return { color: "var(--mar)", icono: "zapatilla" };
  if (/strength|fitness|training|hiit|yoga|pilates|cardio|fuerza|breath/.test(dep)) return { color: "var(--fuerza)", icono: "pesa" };
  return { color: "var(--nada)", icono: "zapatilla" };
}
function nombreDeporte(dep) {
  var mapa = {
    running: "Carrera", trail_running: "Trail", treadmill_running: "Cinta", track_running: "Pista",
    lap_swimming: "Natación", open_water_swimming: "Aguas abiertas", walking: "Caminata", hiking: "Senderismo",
    cycling: "Bici", road_biking: "Bici de ruta", mountain_biking: "MTB", indoor_cycling: "Rodillo",
    strength_training: "Fuerza", fitness_equipment: "Gimnasio", yoga: "Yoga", hiit: "HIIT", padel: "Pádel"
  };
  dep = String(dep || "");
  return mapa[dep] || (dep ? dep.replace(/_/g, " ") : "Actividad");
}

async function api(ruta, opts) {
  var url = ruta.charAt(0) === "/" && ruta.indexOf("/app/") !== 0 ? "/app/api" + ruta : ruta;
  var res = await fetch(url, opts);
  if (res.status === 401) { location.href = "/login"; throw new Error("La sesión ha caducado."); }
  var json;
  try { json = await res.json(); } catch (e) {
    // Un 404 sin JSON es que el servidor no tiene esa ruta: casi siempre, un
    // despliegue más viejo que el panel. Se dice con la ruta, para poder mirarlo.
    throw new Error(url.split("?")[0] + " respondió " + res.status + (res.status === 404 ? ": el servidor no tiene esa ruta (¿falta desplegar la última versión?)." : " sin datos legibles."));
  }
  if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
  return json;
}
function post(ruta, cuerpo) {
  return api(ruta, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
}

/** Lee un bloque de datos y repinta. Sin parpadeo: lo viejo se queda mientras llega lo nuevo. */
async function carga(clave, ruta, fresh) {
  if (S.cargando[clave]) return;
  S.cargando[clave] = true;
  marcaRefresco();
  try {
    var sep = ruta.indexOf("?") >= 0 ? "&" : "?";
    S.datos[clave] = await api(ruta + (fresh ? sep + "fresh=1" : ""));
    delete S.errores[clave];
  } catch (e) {
    S.errores[clave] = e.message;
  } finally {
    S.cargando[clave] = false;
    marcaRefresco();
    pinta();
  }
}
function marcaRefresco() {
  var b = document.getElementById("refrescar");
  if (!b) return;
  var alguno = Object.keys(S.cargando).some(function (k) { return S.cargando[k]; });
  b.setAttribute("data-cargando", alguno ? "1" : "0");
}

/** Hueco de un bloque sin datos: distingue «aún viene» de «ha fallado». */
function hueco(clave, texto) {
  if (S.errores[clave]) return h("div", { class: "error-caja", role: "alert", text: "No se pudo cargar: " + S.errores[clave] });
  return h("div", { class: "cargando", text: texto || "CARGANDO…" });
}

function tarjeta(clase, hijos) { return h("section", { class: "tarjeta" + (clase ? " " + clase : "") }, hijos); }
function etq(texto, extra) { return h("span", { class: "etq", text: texto, style: extra || null }); }
function xp(total, encendidos, alerta) {
  var c = h("div", { class: "xp", style: "grid-template-columns:repeat(" + total + ",minmax(0,1fr))", "aria-hidden": "true" });
  for (var i = 0; i < total; i++) c.appendChild(h("i", { class: i < encendidos ? (alerta ? "on alerta" : "on") : "" }));
  return c;
}
function columnas(a, b) {
  var main = document.getElementById("contenido");
  main.className = b ? "" : "una";
  main.appendChild(h("div", { class: "col" }, a));
  if (b) main.appendChild(h("div", { class: "col" }, b));
}
function hoyISO() {
  var d = S.datos;
  return (d.hoy && d.hoy.hoy) || (d.contract && d.contract.hoy) || new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------- rutas y datos
function leerRuta() {
  var r = (location.hash || "#hoy").slice(1).split("/");
  S.ruta = TABS.some(function (t) { return t.id === r[0]; }) ? r[0] : "hoy";
  S.sub = r[1] || null;
}

function cargaVista(fresh) {
  var r = S.ruta;
  if (r === "hoy") {
    carga("hoy", "/hoy", fresh); carga("contract", "/contract", fresh);
  } else if (r === "semana") {
    var l = S.lunes || lunesDe(hoyISO());
    carga("semana:" + l, "/semana?lunes=" + l, fresh);
  } else if (r === "progreso") {
    carga("progreso:" + S.dias, "/progreso?dias=" + S.dias, fresh);
    carga("diario:" + S.dias, "/diario?days=" + S.dias, fresh);
  } else if (r === "contrato") {
    carga("contract", "/contract", fresh); carga("log", "/log?limit=30", fresh);
  } else if (r === "mas") {
    carga("garmin", "/app/garmin/estado", fresh);
    carga("rachas", "/rachas", fresh);
    if (S.sub === "material") carga("material", "/material", fresh);
    if (S.sub === "diario") carga("diario", "/diario?days=14", fresh);
    if (S.sub === "historial") carga("log", "/log?limit=30", fresh);
  }
}
function necesita(clave) { return !S.datos[clave] && !S.cargando[clave] && !S.errores[clave]; }

// --------------------------------------------------------------- pintado
function pintaTabs() {
  var nav = document.getElementById("tabs");
  nav.innerHTML = "";
  TABS.forEach(function (t) {
    nav.appendChild(h("a", {
      href: "#" + t.id, "aria-current": S.ruta === t.id ? "page" : null,
      html: pix(t.id, 20) + "<span>" + t.nombre + "</span>"
    }));
  });
}

function pinta() {
  var main = document.getElementById("contenido");
  var scroll = window.scrollY;
  main.innerHTML = "";
  var chip = document.getElementById("version-chip");
  if (S.datos.contract) chip.textContent = "v" + S.datos.contract.version;
  document.getElementById("fecha-hoy").textContent = fechaCorta(hoyISO());
  if (S.ruta === "hoy") vistaHoy();
  else if (S.ruta === "semana") vistaSemana();
  else if (S.ruta === "progreso") vistaProgreso();
  else if (S.ruta === "contrato") vistaContrato();
  else vistaMas();
  window.scrollTo(0, scroll);
}

// ------------------------------------------------------------------- HOY
function situa(v, b, alto) {
  // alto = true: pasarse por arriba es la señal (FC en reposo); false: por abajo (VFC).
  if (v === null || v === undefined || !b) return null;
  if (v > b.p90) return { texto: "Por encima de tu normal", alerta: alto };
  if (v < b.p10) return { texto: "Por debajo de tu normal", alerta: !alto };
  return { texto: "En tu normal", alerta: false };
}

var SENALES = {
  sueno: { nombre: "Sueño", icono: "sueno", color: "var(--mar)" },
  hrv: { nombre: "VFC", icono: "vfc", color: "var(--mar)" },
  fc: { nombre: "FC reposo", icono: "fc", color: "var(--coral)" },
  bateria: { nombre: "Batería", icono: "bateria", color: "var(--fuerza)" }
};

function senal(clave, valor, unidad, nota, alerta) {
  var s = SENALES[clave];
  return h("div", { class: "senal" + (alerta ? " alerta" : "") }, [
    h("div", { class: "senal-cab" }, [icono(s.icono, 16, alerta ? "var(--coral)" : s.color), etq(s.nombre)]),
    h("div", { style: "display:flex;align-items:baseline;gap:4px" }, [
      h("span", { class: "cifra-m", text: valor }), unidad ? etq(unidad, "font-size:10px") : null
    ]),
    nota ? h("span", { class: "nota", text: nota }) : null
  ]);
}

function nivelReadiness(n) {
  var mapa = { PRIME: "en su mejor punto", HIGH: "alta", MODERATE: "moderada", LOW: "baja", POOR: "muy baja" };
  return mapa[String(n).toUpperCase()] || String(n).toLowerCase().replace(/_/g, " ");
}

/**
 * La pantalla de la mañana responde, por este orden: qué toca hoy, si el
 * cuerpo acompaña (y qué hacer si no) y qué límite manda. Lo de contexto
 * (semana, cuenta atrás) va al final y en pequeño. El panel solo enseña: el
 * diario y los acuerdos se escriben hablando con el entrenador.
 */
function vistaHoy() {
  var d = S.datos.hoy, c = S.datos.contract;
  if (!d) { columnas([hueco("hoy", "LEYENDO GARMIN…")]); return; }
  var a = [tarjetaHoyToca(d), tarjetaSenales(d)];
  var b = [];
  var lim = tarjetaLimites(c);
  if (lim) b.push(lim);
  var av = avisosContrato(c);
  if (av) b.push(av);
  b.push(h("div", { class: "rejilla2" }, [tarjetaSemanaMini(d.semana), tarjetaCuentaAtras(c)].filter(Boolean)));
  if (!d.cobertura.cargaInicialCompleta) b.push(avisoCobertura(d.cobertura));
  columnas(a, b);
}

function tarjetaHoyToca(d) {
  var hoy = d.hoy;
  var deHoy = d.agenda.filter(function (p) { return p.fecha === hoy; });
  var pendHoy = deHoy.filter(function (p) { return !p.completado; });
  var manana = d.agenda.filter(function (p) { return p.fecha === addDias(hoy, 1); });
  var f = h("section", { class: "ficha heroe", "aria-label": "Lo de hoy" });
  f.appendChild(h("div", { class: "ficha-cab" }, [h("span", { text: "HOY TOCA · " + fechaCorta(hoy) }), h("span", { text: "GARMIN" })]));
  var cu = h("div", { class: "ficha-cuerpo" });
  if (d.agendaError) cu.appendChild(h("div", { class: "error-caja", text: "No se pudo leer el calendario de Garmin: " + d.agendaError }));
  if (pendHoy.length) {
    pendHoy.forEach(function (p) {
      cu.appendChild(h("div", { style: "display:flex;gap:12px;align-items:center" }, [
        icono(claseDeporte(p.deporte).icono, 36, claseDeporte(p.deporte).color),
        h("div", { style: "display:flex;flex-direction:column;gap:2px;min-width:0" }, [
          h("span", { class: "cifra-l", style: "font-size:24px", text: p.titulo.toUpperCase() }),
          h("span", { class: "sub", text: [nombreDeporte(p.deporte), p.segundos ? duracion(p.segundos) : null].filter(Boolean).join(" · ") })
        ])
      ]));
    });
    cu.appendChild(h("span", { class: "sub", text: "Cárgala desde el menú de entrenos del reloj: así sigue los pasos." }));
  } else if (d.hechas.length || deHoy.length) {
    cu.appendChild(h("div", { style: "display:flex;gap:10px;align-items:center" }, [icono("check", 28, "var(--mar)"), h("span", { class: "cifra-l", style: "font-size:24px", text: "HECHO" })]));
  } else if (!d.agendaError) {
    cu.appendChild(h("span", { class: "cifra-m", text: "NADA ESCRITO PARA HOY" }));
    cu.appendChild(h("span", { class: "sub", text: "Casi todos los días hay algo: pídele la sesión al entrenador, aunque sean 15 minutos suaves." }));
  }
  if (d.hechas.length) {
    cu.appendChild(etq("Ya hecho"));
    d.hechas.forEach(function (x) { cu.appendChild(lineaActividad(x)); });
  }
  if (manana.length) {
    cu.appendChild(h("div", { class: "fila-sep", style: "border-top:2px solid var(--dim);padding-top:8px" }, [
      etq("Mañana"), h("span", { style: "font-size:14px;text-align:right", text: manana.map(function (p) { return p.titulo; }).join(" · ") })
    ]));
  }
  f.appendChild(cu);
  return f;
}

function tarjetaSenales(d) {
  var w = d.bienestar, bd = d.bandas;
  var t = tarjeta("", [h("div", { class: "fila-sep" }, [
    h("span", { class: "titulo", text: "CÓMO AMANECISTE" }),
    w && !w.esHoy ? etq("DATO DEL " + diaMes(w.fecha), "color:var(--coral)") : etq("VS. TU NORMAL")
  ])]);
  if (!w) {
    t.appendChild(h("span", { class: "vacio", text: "Sin lectura de bienestar en los dos últimos días: sincroniza el reloj con la app de Garmin." }));
    return t;
  }
  // Disposición: el «training readiness» del reloj, tal cual.
  if (w.readiness !== null) {
    t.appendChild(h("div", { style: "display:flex;gap:10px;align-items:center" }, [
      icono("rayo", 22, w.readiness < 34 ? "var(--coral)" : "var(--sol)"),
      h("div", { style: "flex:1;display:flex;flex-direction:column;gap:4px" }, [
        h("div", { class: "fila-sep" }, [etq("Disposición"), h("span", { class: "bungee", style: "font-size:16px", text: w.readiness + "/100" })]),
        xp(10, Math.round(w.readiness / 10), w.readiness < 34),
        w.readiness_nivel ? h("span", { class: "nota", text: "Garmin la ve " + nivelReadiness(w.readiness_nivel) + "." }) : null
      ])
    ]));
  }
  var fc = situa(w.fc_reposo, bd.fc_reposo, true);
  var hv = situa(w.hrv, bd.hrv, false);
  var su = situa(w.sueno_seg !== null ? w.sueno_seg / 3600 : null, bd.sueno_h, false);
  t.appendChild(h("div", { class: "senales" }, [
    senal("sueno", horasMin(w.sueno_seg), "H", w.sueno_puntuacion !== null ? "Nota " + w.sueno_puntuacion : (su ? su.texto : null), su && su.alerta),
    senal("hrv", num(w.hrv), "MS", hv ? hv.texto : null, hv && hv.alerta),
    senal("fc", num(w.fc_reposo), "PPM", fc ? fc.texto : null, fc && fc.alerta),
    senal("bateria", num(w.body_battery), "%", "Máximo del día", false)
  ]));
  // Lo útil de una señal fuera de lo normal es qué hacer: primero, síntomas.
  var fuera = [];
  if (fc && fc.alerta) fuera.push("la FC en reposo alta");
  if (hv && hv.alerta) fuera.push("la VFC baja");
  if (fuera.length) {
    t.appendChild(h("div", { class: "consejo" }, [icono("alerta", 18, "var(--coral)"), h("span", {
      text: "Hoy tienes " + fuera.join(" y ") + " frente a tu normal. Antes de culpar al sueño o al calor: ¿algún síntoma (garganta, fiebre, malestar)? Si lo hay, la sesión se encoge."
    })]));
  } else if (fc || hv) {
    t.appendChild(h("span", { class: "nota", text: "Todo dentro de tu normal de " + bd.dias + " días." }));
  }
  return t;
}

function tarjetaSemanaMini(s) {
  return h("a", { class: "tarjeta mini", href: "#semana" }, [
    etq("Esta semana"),
    h("div", { style: "display:flex;align-items:baseline;gap:4px" }, [h("span", { class: "cifra-m", text: num(s.kmCarrera, 1) }), etq("KM", "font-size:10px")]),
    xp(7, s.diasActivos),
    h("span", { class: "nota", text: s.diasActivos + "/7 días activos" })
  ]);
}

function avisosContrato(c) {
  if (!c || !c.disparadoresVencidos.length) return null;
  var n = c.disparadoresVencidos.length;
  return h("a", { class: "tarjeta mini coral", href: "#contrato", onclick: function () { S.ctab = "pendientes"; } }, [
    h("div", { style: "display:flex;gap:8px;align-items:center" }, [icono("alerta", 16), etq(n === 1 ? "1 aviso del entrenador vencido" : n + " avisos del entrenador vencidos")]),
    h("span", { style: "font-size:14px", text: c.disparadoresVencidos[0].accion.slice(0, 110) + (c.disparadoresVencidos[0].accion.length > 110 ? "…" : "") })
  ]);
}

function avisoCobertura(cob) {
  return tarjeta("", [
    etq("Histórico en carga"),
    h("span", { class: "sub", text: "Garmin se lee poco a poco, cada hora. Hasta que termine, marcas y bandas son provisionales: " + cob.actividades + " actividades y " + cob.diasBienestar + " días de bienestar por ahora." })
  ]);
}

function lineaActividad(x) {
  var k = claseDeporte(x.deporte);
  var val;
  if (k.correr && x.distancia_m) val = num(x.distancia_m / 1000, 1) + " km · " + (ritmo(x.segundos, x.distancia_m) || "");
  else if (x.distancia_m && x.distancia_m > 300) val = num(x.distancia_m / 1000, 1) + " km · " + duracion(x.segundos);
  else val = duracion(x.segundos);
  var hijos = [h("div", { class: "linea" }, [
    h("span", { class: "nom" }, [h("i", { class: "punto", style: "background:" + k.color }), h("span", { text: x.nombre || nombreDeporte(x.deporte) })]),
    h("span", { class: "val", text: val })
  ])];
  if (x.desacople_pct !== null && x.desacople_pct !== undefined) {
    hijos.push(h("div", { class: "linea" }, [
      h("span", { class: "nom" }, [h("i", { class: "punto", style: "background:var(--mar)" }), h("span", { text: "Desacople " + num(x.desacople_pct, 1) + " %" })]),
      h("span", { class: "val", text: x.fc_media ? "FC " + Math.round(x.fc_media) : "" })
    ]));
  }
  return hijos.length === 1 ? hijos[0] : h("div", { style: "display:flex;flex-direction:column;gap:4px" }, hijos);
}

/** Las reglas protegidas y los niveles del estado: lo que manda sobre todo lo demás. */
function tarjetaLimites(c) {
  if (!c) return null;
  var prot = c.reglas.filter(function (r) { return Number(r.protegida) === 1; });
  var niveles = c.estado.filter(function (e) { return /^nivel_/.test(e.clave); });
  if (!prot.length && !niveles.length) return null;
  var t = tarjeta("", [h("div", { class: "fila-sep" }, [
    h("span", { style: "display:flex;gap:8px;align-items:center" }, [icono("candado", 16, "var(--coral)"), h("span", { class: "titulo", text: "LÍMITES" })]),
    etq("DOBLE LLAVE")
  ])]);
  niveles.forEach(function (e) {
    var m = /^\s*(\d+)/.exec(e.valor);
    var resto = (m ? e.valor.slice(m[0].length) : e.valor).trim();
    t.appendChild(h("div", { class: "fila-sep", style: "align-items:center" }, [
      etq(e.clave.replace(/^nivel_/, "").replace(/_/g, " ")),
      h("span", { class: "bungee", style: "font-size:18px", text: m ? "NIVEL " + m[1] : e.valor.slice(0, 24) })
    ]));
    if (resto) t.appendChild(h("span", { class: "nota", text: resto.length > 140 ? resto.slice(0, 140) + "…" : resto }));
  });
  if (prot.length) {
    t.appendChild(h("details", { class: "plegable" }, [
      h("summary", { class: "etq", style: "color:var(--mar)", text: prot.length === 1 ? "Ver la regla protegida" : "Ver las " + prot.length + " reglas protegidas" }),
      h("div", { style: "display:flex;flex-direction:column;gap:6px;margin-top:6px" }, prot.map(function (r) {
        return h("span", { class: "nota", text: r.id + " · " + (r.resumen || r.contenido.slice(0, 200)) });
      }))
    ]));
  }
  return t;
}

function tarjetaCuentaAtras(c) {
  if (!c) return null;
  var hoy = c.hoy;
  var futuras = c.carreras.filter(function (x) { return x.fecha && x.fecha >= hoy && !/descart|cancel|hecha|termin|complet/i.test(x.estado || ""); });
  if (!futuras.length) return null;
  futuras.sort(function (x, y) {
    var px = x.prioridad === "A" ? 0 : 1, py = y.prioridad === "A" ? 0 : 1;
    return px - py || x.fecha.localeCompare(y.fecha);
  });
  var x = futuras[0];
  return h("a", { class: "tarjeta mini negra", href: "#contrato", onclick: function () { S.ctab = "carreras"; }, title: x.nombre + " · " + fechaLarga(x.fecha) }, [
    h("div", { style: "display:flex;gap:6px;align-items:center" }, [icono("bandera", 14, "var(--sol)"), etq(x.prioridad ? "Objetivo " + x.prioridad : "Próxima")]),
    h("div", { style: "display:flex;align-items:baseline;gap:4px" }, [h("span", { class: "cifra-m", text: String(diasEntre(hoy, x.fecha)) }), etq("DÍAS", "font-size:10px;color:var(--sobre-negro)")]),
    h("span", { class: "nota", style: "color:var(--sobre-negro)", text: x.nombre })
  ]);
}

// ----------------------------------------------------------------- DIARIO
// Solo se enseña: lo apuntas hablando con el entrenador (diary_set).
function valorDiario(fecha, campo) {
  var dias = (S.datos.diario && S.datos.diario.dias) || {};
  var fila = dias[fecha];
  return fila && fila[campo] !== undefined ? fila[campo] : null;
}

function escalaDe(c) {
  return c.tipo === "si_no" ? "sí / no" : c.tipo === "texto" ? "texto libre" : "de " + (c.minimo === null ? "?" : c.minimo) + " a " + (c.maximo === null ? "?" : c.maximo);
}

/** Catorce días de un campo: un cuadro por día, vacío si no se apuntó. */
function tarjetaCampoDiario(campo, hoy, dias) {
  var t = tarjeta("", [
    h("div", { class: "fila-sep" }, [h("span", { class: "titulo", text: campo.etiqueta.toUpperCase() }), etq(escalaDe(campo))]),
    campo.descripcion ? h("span", { class: "nota", text: campo.descripcion }) : null
  ]);
  var minimo = campo.tipo === "si_no" ? 0 : (campo.minimo === null ? 0 : campo.minimo);
  var fechas = [];
  for (var i = dias - 1; i >= 0; i--) fechas.push(addDias(hoy, -i));
  if (campo.tipo === "texto") {
    var con = fechas.filter(function (f) { return valorDiario(f, campo.campo) !== null; }).reverse();
    if (!con.length) t.appendChild(h("span", { class: "vacio", text: "Nada apuntado en " + dias + " días." }));
    con.slice(0, 5).forEach(function (f) {
      t.appendChild(h("div", { class: "linea" }, [h("span", { text: String(valorDiario(f, campo.campo)) }), h("span", { class: "val", text: diaMes(f) })]));
    });
    return t;
  }
  var rejilla = h("div", { class: "dias-diario", style: "grid-template-columns:repeat(" + dias + ",minmax(0,1fr))" });
  var apuntados = 0, ultimo = null;
  fechas.forEach(function (f) {
    var v = valorDiario(f, campo.campo);
    var n = v === null ? null : Number(v);
    if (n !== null) { apuntados++; ultimo = { f: f, v: n }; }
    var clase = n === null ? "vacio" : n > minimo ? "malo" : "bien";
    rejilla.appendChild(h("div", { class: "dia-diario", title: f + ": " + (n === null ? "sin apuntar" : (campo.tipo === "si_no" ? (n ? "sí" : "no") : n)) }, [
      h("span", { class: "etq", style: "font-size:9px" + (f === hoy ? ";color:var(--coral)" : ""), text: DIAS_C[partes(f).getUTCDay()].charAt(0) }),
      h("span", { class: "celda " + clase, text: n === null ? "" : (campo.tipo === "si_no" ? (n ? "S" : "N") : String(n)) })
    ]));
  });
  t.appendChild(rejilla);
  t.appendChild(h("span", { class: "nota", text: apuntados + " de " + dias + " días apuntados" + (ultimo ? " · último: " + (campo.tipo === "si_no" ? (ultimo.v ? "sí" : "no") : ultimo.v) + " el " + diaMes(ultimo.f) : "") + "." }));
  return t;
}

// ---------------------------------------------------------------- SEMANA
function vistaSemana() {
  var l = S.lunes || lunesDe(hoyISO());
  var d = S.datos["semana:" + l];
  var nav = h("div", { class: "seg3", role: "group", "aria-label": "Cambiar de semana" }, [
    h("button", { class: "tecla", type: "button", text: "◀ ANTERIOR", onclick: function () { S.lunes = addDias(l, -7); cargaVista(); pinta(); } }),
    h("button", { class: "tecla", type: "button", text: "ESTA", "aria-pressed": l === lunesDe(hoyISO()) ? "true" : "false", onclick: function () { S.lunes = null; cargaVista(); pinta(); } }),
    h("button", { class: "tecla", type: "button", text: "SIGUIENTE ▶", onclick: function () { S.lunes = addDias(l, 7); cargaVista(); pinta(); } })
  ]);
  if (!d) { columnas([nav, hueco("semana:" + l, "LEYENDO LA SEMANA…")]); return; }
  var hoy = d.hoy;
  var resumen = tarjeta("", [
    etq("Semana " + diaMes(d.lunes) + " – " + diaMes(addDias(d.lunes, 6)) + " · corridos"),
    h("div", { style: "display:flex;align-items:baseline;gap:10px" }, [
      h("span", { class: "cifra-xl", text: num(d.kmCarrera, 1), style: "color:var(--coral)" }), h("span", { class: "cifra-m", text: "KM" })
    ]),
    xp(7, d.diasActivos),
    h("span", { class: "etq", text: d.diasActivos + "/7 DÍAS · " + duracion(d.segundos) + " · CARGA " + num(d.carga) })
  ]);
  var a = [nav, resumen], b = [];
  if (d.agendaError) a.push(h("div", { class: "error-caja", text: "Calendario de Garmin sin leer: lo programado no sale. " + d.agendaError }));
  d.dias.forEach(function (dia, i) {
    var p = partes(dia.fecha);
    var lineas = h("div", { class: "lineas" });
    dia.hechas.forEach(function (x) { lineas.appendChild(lineaActividad(x)); });
    dia.programado.forEach(function (x) {
      var pasado = dia.fecha < hoy;
      lineas.appendChild(h("div", { class: "linea plan" }, [
        h("span", { class: "nom" }, [h("i", { class: "punto", style: "color:" + claseDeporte(x.deporte).color }), h("span", { text: x.titulo })]),
        h("span", { class: "val", text: pasado ? "SIN HACER" : (x.segundos ? duracion(x.segundos) : "PROGRAMADA") })
      ]));
    });
    if (!dia.hechas.length && !dia.programado.length) lineas.appendChild(h("span", { class: "vacio", text: dia.fecha > hoy ? "Nada escrito todavía." : "Sin actividad." }));
    var tarj = h("article", { class: "tarjeta dia" + (dia.fecha === hoy ? " hoy" : ""), "aria-label": fechaCorta(dia.fecha) }, [
      h("div", { class: "num" }, [h("span", { class: "etq", style: "font-size:10px", text: DIAS_C[p.getUTCDay()] }), h("span", { class: "cifra-m", text: String(p.getUTCDate()) })]),
      lineas
    ]);
    (i < 4 ? a : b).push(tarj);
  });
  columnas(a, b);
}

// -------------------------------------------------------------- PROGRESO
function vistaProgreso() {
  var clave = "progreso:" + S.dias;
  var d = S.datos[clave];
  var selector = h("div", { class: "seg3", role: "group", "aria-label": "Periodo" }, [[28, "4 SEM"], [90, "3 MESES"], [365, "1 AÑO"]].map(function (o) {
    return h("button", { class: "tecla", type: "button", text: o[1], "aria-pressed": S.dias === o[0] ? "true" : "false", onclick: function () { S.dias = o[0]; cargaVista(); pinta(); } });
  }));
  if (!d) { columnas([selector, hueco(clave, "CALCULANDO…")]); return; }
  var a = [selector], b = [];
  a.push(graficaCarga(d));
  a.push(graficaKm(d));
  tarjetasDiario(d, S.datos["diario:" + S.dias]).forEach(function (t) { a.push(t); });
  b.push(tarjetaNormal(d));
  b.push(tarjetaMarcas(d));
  if (!d.cobertura.cargaInicialCompleta) b.push(avisoCobertura(d.cobertura));
  columnas(a, b);
}

function graficaCarga(d) {
  var W = 340, H = 130, P = 6;
  var serie = d.carga;
  var t = tarjeta("", [h("div", { class: "fila-sep" }, [h("span", { class: "titulo", text: "FORMA Y FATIGA" }), etq("ESCALA GARMIN")])]);
  if (serie.length < 2) { t.appendChild(h("span", { class: "vacio", text: "Aún no hay días suficientes." })); return t; }
  // Una línea no necesita el cero: el rango se ajusta a los datos para que se
  // lea la tendencia, y las dos cifras de los extremos lo dejan dicho.
  var max = 10, min = Infinity;
  serie.forEach(function (x) { max = Math.max(max, x.ctl, x.atl); min = Math.min(min, x.ctl, x.atl); });
  max = Math.ceil(max / 10) * 10;
  min = Math.max(0, Math.floor(min * 0.8 / 10) * 10);
  if (max - min < 20) min = Math.max(0, max - 20);
  function pts(campo) {
    return serie.map(function (x, i) {
      return (P + (W - 2 * P) * i / (serie.length - 1)).toFixed(1) + "," + (H - P - (H - 2 * P) * (x[campo] - min) / (max - min)).toFixed(1);
    }).join(" ");
  }
  var u = serie[serie.length - 1];
  var svg = '<svg class="svg-graf" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Forma ' + Math.round(u.ctl) + ", fatiga " + Math.round(u.atl) + '">' +
    '<line x1="0" y1="' + (H - 2) + '" x2="' + W + '" y2="' + (H - 2) + '" stroke="var(--tinta)" stroke-width="2"></line>' +
    '<polyline points="' + pts("atl") + '" fill="none" stroke="var(--coral)" stroke-width="2.5" stroke-dasharray="6 4" stroke-linejoin="round"></polyline>' +
    '<polyline points="' + pts("ctl") + '" fill="none" stroke="var(--mar)" stroke-width="4" stroke-linejoin="round"></polyline>' +
    '<text x="' + (W - 2) + '" y="12" text-anchor="end" font-family="Silkscreen,monospace" font-size="9" fill="var(--apagado)">' + max + "</text>" +
    '<text x="' + (W - 2) + '" y="' + (H - 6) + '" text-anchor="end" font-family="Silkscreen,monospace" font-size="9" fill="var(--apagado)">' + min + "</text></svg>";
  t.appendChild(h("div", { html: svg }));
  t.appendChild(h("div", { class: "leyenda" }, [
    h("span", { style: "color:var(--mar)", text: "■ FORMA " + Math.round(u.ctl) }),
    h("span", { style: "color:var(--coral)", text: "- - FATIGA " + Math.round(u.atl) }),
    h("span", { text: "FRESCURA " + (u.tsb >= 0 ? "+" : "") + Math.round(u.tsb) })
  ]));
  if (d.hoy < d.cargaFiableDesde) t.appendChild(h("span", { class: "sub", text: "Con menos de 6 semanas de histórico la forma sale más baja de lo real." }));
  return t;
}

/**
 * Cada campo del diario contra la carga del mismo día: lo que se busca es si
 * los días malos vienen después de días cargados. Un sí/no se cuenta, no se promedia.
 */
function tarjetasDiario(d, diario) {
  if (!diario || !diario.campos.length) return [];
  var porFecha = {};
  d.carga.forEach(function (x) { porFecha[x.fecha] = x.carga; });
  var salida = [];
  diario.campos.forEach(function (campo) {
    if (campo.tipo === "texto") return;
    var serie = d.carga.map(function (x) {
      var fila = diario.dias[x.fecha];
      var v = fila && fila[campo.campo] !== undefined ? Number(fila[campo.campo]) : null;
      return { fecha: x.fecha, v: v };
    });
    var con = serie.filter(function (x) { return x.v !== null; });
    if (!con.length) return;
    var minimo = campo.tipo === "si_no" ? 0 : (campo.minimo === null ? 0 : campo.minimo);
    var maximo = campo.tipo === "si_no" ? 1 : (campo.maximo === null ? Math.max.apply(null, con.map(function (x) { return x.v; })) : campo.maximo);
    var malos = con.filter(function (x) { return x.v > minimo; });
    var buenos = con.filter(function (x) { return x.v <= minimo; });
    // La carga que importa es la del día anterior: el dolor llega después.
    function cargaPrevia(lista) {
      var v = lista.map(function (x) { return porFecha[addDias(x.fecha, -1)]; }).filter(function (c) { return c !== undefined; });
      return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
    }
    var barras = h("div", { style: "display:grid;grid-template-columns:repeat(" + serie.length + ",minmax(0,1fr));gap:" + (serie.length > 60 ? 0 : 2) + "px;align-items:end;height:48px;border-bottom:2px solid var(--tinta)", "aria-hidden": "true" });
    serie.forEach(function (x) {
      var alto = x.v === null ? 0 : Math.max(3, Math.round(44 * (x.v - minimo) / Math.max(1, maximo - minimo)));
      barras.appendChild(h("i", { style: "display:block;height:" + (x.v === null ? 2 : alto) + "px;background:" + (x.v === null ? "transparent" : x.v > minimo ? "var(--coral)" : "var(--mar)"), title: x.fecha + ": " + (x.v === null ? "sin apuntar" : x.v) }));
    });
    var lectura = campo.tipo === "si_no"
      ? malos.length + " de " + con.length + " días dijeron que sí"
      : con.length + " registros · " + malos.length + " por encima de " + minimo;
    var cm = cargaPrevia(malos), cb = cargaPrevia(buenos);
    salida.push(tarjeta("", [
      h("div", { class: "fila-sep" }, [h("span", { class: "titulo", text: campo.etiqueta.toUpperCase() }), etq("DIARIO")]),
      barras,
      h("span", { class: "sub", text: lectura + (cm !== null && cb !== null && malos.length && buenos.length ? ". Carga del día anterior: " + Math.round(cm) + " en los días malos frente a " + Math.round(cb) + " en el resto." : ".") })
    ]));
  });
  return salida;
}

function graficaKm(d) {
  var t = tarjeta("", [h("span", { class: "titulo", text: "KM CORRIENDO POR SEMANA" })]);
  var s = d.semanas;
  if (!s.length) { t.appendChild(h("span", { class: "vacio", text: "Sin semanas en el periodo." })); return t; }
  var max = 1;
  s.forEach(function (x) { max = Math.max(max, x.kmCarrera); });
  var pocas = s.length <= 8;
  var cont = h("div", { style: "display:grid;grid-template-columns:repeat(" + s.length + ",minmax(0,1fr));gap:" + (pocas ? 10 : 2) + "px;align-items:end;height:120px;border-bottom:2px solid var(--tinta)", role: "img",
    "aria-label": "Km por semana: " + s.map(function (x) { return diaMes(x.lunes) + " " + num(x.kmCarrera, 1); }).join(", ") });
  var lunesHoy = lunesDe(d.hoy);
  s.forEach(function (x) {
    var alto = Math.max(2, Math.round(96 * x.kmCarrera / max));
    var actual = x.lunes === lunesHoy;
    cont.appendChild(h("div", { style: "display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0", title: diaMes(x.lunes) + ": " + num(x.kmCarrera, 1) + " km" }, [
      pocas ? h("span", { class: "bungee", style: "font-size:12px", text: num(x.kmCarrera, 1) }) : null,
      h("div", { style: "width:100%;height:" + alto + "px;background:" + (actual ? "var(--coral)" : "var(--dim)") + ";border:" + (pocas ? "2px solid var(--tinta)" : "0") + ";border-bottom:0;border-radius:" + (pocas ? "4px 4px 0 0" : "1px") })
    ]));
  });
  t.appendChild(cont);
  if (pocas) {
    t.appendChild(h("div", { style: "display:grid;grid-template-columns:repeat(" + s.length + ",minmax(0,1fr));gap:10px;text-align:center" }, s.map(function (x) {
      return etq(x.lunes === lunesHoy ? "ESTA" : diaMes(x.lunes), "font-size:10px");
    })));
  } else {
    t.appendChild(h("div", { class: "fila-sep" }, [etq(diaMes(s[0].lunes), "font-size:10px"), etq("MÁX " + num(max, 1) + " KM", "font-size:10px"), etq("ESTA", "font-size:10px")]));
  }
  return t;
}

function filaBanda(nombre, v, b, unidad, alto, dec) {
  var caja = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
  caja.appendChild(h("div", { class: "fila-sep" }, [h("span", { style: "font-size:14px", text: nombre }), h("span", { class: "bungee", style: "font-size:14px", text: v === null ? "—" : num(v, dec) + " " + unidad })]));
  if (!b) { caja.appendChild(h("span", { class: "sub", text: "Aún no hay días suficientes para tu normal." })); return caja; }
  var lo = Math.min(b.p10, v === null ? b.p10 : v), hi = Math.max(b.p90, v === null ? b.p90 : v);
  var pad = (hi - lo) * 0.35 || 1;
  lo -= pad; hi += pad;
  var pos = function (x) { return ((x - lo) / (hi - lo) * 100).toFixed(1) + "%"; };
  var s = situa(v, b, alto);
  var barra = h("div", { class: "banda", "aria-hidden": "true" }, [
    h("div", { class: "zona", style: "left:" + pos(b.p10) + ";width:calc(" + pos(b.p90) + " - " + pos(b.p10) + ")" }),
    v === null ? null : h("div", { class: "marca" + (s && s.alerta ? " alerta" : ""), style: "left:" + pos(v) })
  ]);
  caja.appendChild(barra);
  caja.appendChild(h("span", { class: "sub", text: "Normal " + num(b.p10, dec) + "–" + num(b.p90, dec) + " " + unidad + " · " + b.n + " días" + (s ? " · " + s.texto.toLowerCase() : "") }));
  return caja;
}

function tarjetaNormal(d) {
  return tarjeta("", [
    h("div", { class: "fila-sep" }, [h("span", { class: "titulo", text: "TU NORMAL" }), etq(d.bandas.dias + " DÍAS")]),
    filaBanda("FC en reposo", d.ultimo.fc_reposo, d.bandas.fc_reposo, "ppm", true, 0),
    filaBanda("VFC nocturna", d.ultimo.hrv, d.bandas.hrv, "ms", false, 0),
    filaBanda("Sueño", d.ultimo.sueno_h, d.bandas.sueno_h, "h", false, 1)
  ]);
}

function tarjetaMarcas(d) {
  var NOMBRES = { 400: "400 M", 800: "800 M", 1000: "1 KM", 1609: "MILLA", 3000: "3 KM", 5000: "5 KM", 10000: "10 KM", 21097: "MEDIA", 42195: "MARATÓN" };
  var t = tarjeta("", [h("div", { class: "fila-sep" }, [h("span", { class: "titulo", text: "MEJORES MARCAS" }), etq("TODO EL HISTÓRICO")])]);
  if (!d.marcas.length) { t.appendChild(h("span", { class: "vacio", text: "Aún no hay series de carrera leídas." })); return t; }
  t.appendChild(h("div", { class: "rejilla2" }, d.marcas.map(function (m) {
    return h("div", { class: "tarjeta", style: "gap:2px", title: (m.nombre || "") + " · " + fechaLarga(m.fecha) }, [
      etq(NOMBRES[m.distancia] || (m.distancia + " M")), h("span", { class: "cifra-m", text: reloj(m.segundos) }), h("span", { class: "sub", text: diaMes(m.fecha) + " " + m.fecha.slice(0, 4) })
    ]);
  })));
  return t;
}

// -------------------------------------------------------------- CONTRATO
function coincide(q) {
  var t = Array.prototype.slice.call(arguments, 1).join(" ").toLowerCase();
  return !q || t.indexOf(q) >= 0;
}

function tarjetaRegla(r) {
  var prot = Number(r.protegida) === 1;
  var cuerpo = [
    h("div", { class: "cab" }, [
      h("span", { class: "etq" }, [h("span", { class: "id", text: r.id }), " · " + r.tema.toUpperCase()]),
      h("span", { class: "etq", html: prot ? pix("candado", 11) + " PROTEGIDA" : null, text: prot ? null : (r.vence ? "VENCE " + fechaLarga(r.vence).toUpperCase() : "SIN VENCIMIENTO") })
    ]),
    h("p", { text: r.resumen || r.contenido })
  ];
  if (r.resumen && r.contenido && r.contenido !== r.resumen) {
    cuerpo.push(h("details", {}, [h("summary", { text: "Leer entera" }), h("div", { class: "largo", text: r.contenido })]));
  }
  return h("article", { class: "tarjeta regla", style: prot ? "border-color:var(--coral)" : null }, cuerpo);
}

function vistaContrato() {
  var c = S.datos.contract;
  if (!c) { columnas([hueco("contract", "LEYENDO EL CONTRATO…")]); return; }
  var q = S.busca.trim().toLowerCase();
  var a = [], b = [];
  if (c.bajasAutomaticas.length) {
    a.push(tarjeta("coral", [etq("Bajas automáticas hoy"), h("span", { style: "font-size:14px", text: c.bajasAutomaticas.map(function (r) { return r.id; }).join(", ") + ": vencidas, quedan en el historial." })]));
  }
  if (c.columnasAusentes && c.columnasAusentes.length) {
    a.push(h("div", { class: "error-caja", text: "Faltan migraciones en la base: " + c.columnasAusentes.join(", ") + ". Corre npm run db:migrate." }));
  }
  var busca = h("input", { id: "buscar", class: "campo", type: "search", placeholder: "Reglas, estado, carreras…", value: S.busca });
  busca.addEventListener("input", function () {
    S.busca = busca.value;
    pinta();
    var n = document.getElementById("buscar");
    if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  });
  a.push(h("label", { for: "buscar", style: "display:flex;flex-direction:column;gap:6px" }, [etq("Buscar"), busca]));

  var reglas = c.reglas.filter(function (r) { return coincide(q, r.id, r.tema, r.resumen || "", r.contenido); });
  var carreras = c.carreras.filter(function (x) { return coincide(q, x.nombre, x.notas || "", x.estado || ""); });
  var disp = c.disparadoresVencidos.concat(c.disparadores);
  var pend = c.pendientes.filter(function (p) { return coincide(q, p.texto, p.resumen || ""); });
  var dispF = disp.filter(function (x) { return coincide(q, x.accion, x.fecha); });
  var estado = c.estado.filter(function (e) { return coincide(q, e.clave, e.valor); });
  var cond = c.condiciones.filter(function (x) { return coincide(q, x.texto); });
  var tabs = [
    ["reglas", "REGLAS " + reglas.length], ["carreras", "CARRERAS " + carreras.length],
    ["pendientes", "PENDIENTES " + (pend.length + dispF.length)], ["estado", "ESTADO " + (estado.length + cond.length)]
  ];
  a.push(h("div", { class: "seg4", role: "tablist", "aria-label": "Secciones del contrato" }, tabs.map(function (t) {
    return h("button", { class: "tecla", type: "button", role: "tab", "aria-selected": S.ctab === t[0] ? "true" : "false", text: t[1], onclick: function () { S.ctab = t[0]; pinta(); } });
  })));

  var lista = [];
  if (S.ctab === "reglas") {
    reglas.slice().sort(function (x, y) { return (Number(y.protegida) || 0) - (Number(x.protegida) || 0) || x.id.localeCompare(y.id); })
      .forEach(function (r) { lista.push(tarjetaRegla(r)); });
    if (!reglas.length) lista.push(h("span", { class: "vacio", text: q ? "Ninguna regla coincide." : "Sin reglas todavía: las escribe el entrenador con cada acuerdo." }));
  } else if (S.ctab === "carreras") {
    carreras.forEach(function (x) {
      var datos = [x.fecha ? fechaLarga(x.fecha) : "sin fecha", x.distancia_km ? num(x.distancia_km, 1) + " km" : null, x.desnivel_m ? "+" + num(x.desnivel_m) + " m" : null, x.estado].filter(Boolean);
      lista.push(tarjeta("", [
        h("div", { class: "cab fila-sep" }, [etq((x.prioridad ? "OBJETIVO " + x.prioridad : "CARRERA")), x.fecha && x.fecha >= c.hoy ? etq(diasEntre(c.hoy, x.fecha) + " DÍAS", "color:var(--coral)") : null]),
        h("span", { class: "titulo", text: x.nombre.toUpperCase() }),
        h("span", { class: "sub", text: datos.join(" · ") }),
        x.resultado ? h("span", { style: "font-size:14px", text: "Resultado: " + x.resultado }) : null,
        x.notas ? h("span", { class: "sub", text: x.notas }) : null
      ]));
    });
    if (!carreras.length) lista.push(h("span", { class: "vacio", text: "Sin carreras." }));
  } else if (S.ctab === "pendientes") {
    dispF.forEach(function (x) {
      var vencido = x.fecha <= c.hoy;
      lista.push(tarjeta(vencido ? "" : "", [
        h("div", { class: "fila-sep" }, [etq((vencido ? "VENCIDO · " : "DISPARADOR · ") + fechaLarga(x.fecha).toUpperCase(), vencido ? "color:var(--coral)" : null), etq("#" + x.id)]),
        h("p", { style: "font-size:14px", text: x.accion })
      ]));
    });
    pend.forEach(function (p) {
      lista.push(tarjeta("", [
        h("div", { class: "fila-sep" }, [etq(p.vence ? "VENCE " + fechaLarga(p.vence).toUpperCase() : "PENDIENTE"), etq("#" + p.id)]),
        h("p", { style: "font-size:14px", text: p.resumen || p.texto })
      ]));
    });
    if (!pend.length && !dispF.length) lista.push(h("span", { class: "vacio", text: "Nada pendiente." }));
  } else {
    cond.forEach(function (x) {
      var rango = x.desde || x.hasta ? (x.desde ? diaMes(x.desde) : "…") + " → " + (x.hasta ? diaMes(x.hasta) : "sin fin") : "SIN FECHAS";
      lista.push(tarjeta("", [
        h("div", { class: "fila-sep" }, [etq("CONDICIÓN · " + rango), etq("#" + x.id)]),
        h("p", { style: "font-size:14px", text: x.texto })
      ]));
    });
    estado.forEach(function (e) {
      lista.push(h("article", { class: "tarjeta regla" }, [
        h("div", { class: "cab" }, [h("span", { class: "etq id", text: e.clave.replace(/_/g, " ").toUpperCase() }), etq(diaMes(e.actualizado_en.slice(0, 10)))]),
        h("p", { text: e.valor.length > 220 ? e.valor.slice(0, 220) + "…" : e.valor }),
        e.valor.length > 220 ? h("details", {}, [h("summary", { text: "Leer entero" }), h("div", { class: "largo", text: e.valor })]) : null
      ]));
    });
  }

  // En escritorio, la lista ocupa la columna derecha y el resumen la izquierda.
  var ultimo = (S.datos.log && S.datos.log.entradas && S.datos.log.entradas[0]) || null;
  var tarjUltimo = tarjeta("negra", [
    etq("Último cambio · v" + c.version + " · " + c.ultimoCommit),
    ultimo ? h("span", { style: "font-size:14px", text: ultimo.mensaje.split("\n")[0].slice(0, 220) }) : null,
    h("a", { href: "#mas/historial", text: "Abrir el historial" })
  ]);
  if (window.matchMedia("(min-width: 900px)").matches) { a.push(tarjUltimo); b = lista; }
  else { a = a.concat(lista); a.push(tarjUltimo); b = null; }
  columnas(a, b);
}

// ------------------------------------------------------------------- MÁS
function vistaMas() {
  if (S.sub === "material") return vistaMaterial();
  if (S.sub === "diario") return vistaDiarioCampos();
  if (S.sub === "historial") return vistaHistorial();
  if (S.sub === "constancia") return vistaConstancia();
  var a = [tarjetaGarmin()], b = [];
  var r = S.datos.rachas;
  var cons = r ? "Racha actual " + r.rachas.movimiento.actual + " días · mejor " + r.rachas.movimiento.mejor : "Días seguidos moviéndote";
  var c = S.datos.contract;
  b.push(h("nav", { class: "tarjeta lista-filas", "aria-label": "Más secciones" }, [
    filaEnlace("#mas/constancia", "CONSTANCIA", cons),
    filaEnlace("#mas/diario", "DIARIO", "Lo que le cuentas al entrenador, día a día"),
    filaEnlace("#mas/material", "MATERIAL", "Lo que tienes: el entrenador no cuenta con nada más"),
    filaEnlace("#mas/historial", "HISTORIAL", c ? "Todos los acuerdos hasta la v" + c.version : "Todos los acuerdos, del más reciente")
  ]));
  b.push(h("form", { method: "post", action: "/logout" }, [h("button", { class: "tecla", type: "submit", style: "width:100%;min-height:48px;color:var(--coral);font-family:Bungee,sans-serif;font-size:14px", text: "CERRAR SESIÓN" })]));
  b.push(h("span", { class: "etq", style: "text-align:center;font-size:10px", text: "ZANCADA" + (c ? " · CONTRATO V" + c.version : "") }));
  columnas(a, b);
}

function filaEnlace(href, titulo, sub) {
  return h("a", { href: href }, [
    h("span", { style: "display:flex;flex-direction:column;gap:2px;min-width:0" }, [h("span", { class: "bungee", style: "font-size:14px", text: titulo }), h("span", { class: "sub", text: sub })]),
    h("span", { class: "bungee", style: "font-size:16px", "aria-hidden": "true", text: "›" })
  ]);
}
function volver() { return h("a", { class: "tecla volver", href: "#mas", style: "display:inline-flex;align-items:center;text-decoration:none", text: "◀ MÁS" }); }

function tarjetaGarmin() {
  var g = S.datos.garmin, r = S.datos.rachas;
  var f = h("section", { class: "ficha", "aria-label": "Garmin Connect" });
  var enlazada = g && g.enlazada;
  f.appendChild(h("div", { class: "ficha-cab" }, [h("span", { text: "GARMIN CONNECT" }), h("span", { style: "color:" + (enlazada ? "var(--enlace-negro)" : "var(--sol)"), text: !g ? "…" : enlazada ? "ENLAZADA" : "SIN ENLAZAR" })]));
  var cu = h("div", { class: "ficha-cuerpo" });
  if (!g) cu.appendChild(hueco("garmin", "COMPROBANDO…"));
  else if (!enlazada) cu.appendChild(formGarmin());
  else {
    if (g.displayName) cu.appendChild(h("span", { class: "sub", text: "Cuenta: " + g.displayName }));
    if (r) {
      var cob = r.cobertura;
      var conSeries = cob.actividades - cob.detallesPendientes;
      cu.appendChild(h("div", { class: "fila-sep" }, [etq("ACTIVIDADES PROCESADAS"), h("span", { class: "etq", style: "color:var(--tinta)", text: conSeries + "/" + cob.actividades })]));
      cu.appendChild(xp(10, cob.actividades ? Math.round(10 * conSeries / cob.actividades) : 0));
      cu.appendChild(h("div", { class: "fila-sep" }, [etq("DÍAS DE BIENESTAR"), h("span", { class: "etq", style: "color:var(--tinta)", text: Math.min(cob.diasBienestar, 120) + "/120" })]));
      cu.appendChild(xp(10, Math.min(10, Math.round(cob.diasBienestar / 12))));
      cu.appendChild(h("span", { class: "sub", text: (cob.cargaInicialCompleta && !cob.detallesPendientes ? "Histórico al día." : "La carga sigue sola cada hora. Hasta que acabe, marcas y bandas son provisionales.") + (cob.ultimaSync ? " Última lectura: " + cob.ultimaSync.slice(0, 16).replace("T", " ") + " UTC." : "") }));
    }
    var desen = h("button", { class: "tecla", type: "button", text: "DESENLAZAR", style: "color:var(--coral)" });
    desen.addEventListener("click", async function () {
      if (!confirm("¿Desenlazar Garmin? El entrenador se queda sin datos hasta que vuelvas a enlazar.")) return;
      desen.disabled = true;
      try { await api("/app/garmin/desenlazar", { method: "POST" }); S.datos.garmin = null; carga("garmin", "/app/garmin/estado"); }
      catch (e) { alert(e.message); desen.disabled = false; }
    });
    cu.appendChild(h("details", { class: "plegable" }, [h("summary", { class: "etq", style: "color:var(--mar)", text: "Opciones de la cuenta" }), h("div", { style: "margin-top:8px;display:flex;gap:8px;flex-wrap:wrap" }, [desen, h("a", { class: "tecla", href: "/app/garmin", style: "display:inline-flex;align-items:center;text-decoration:none", text: "DIAGNÓSTICO" })])]));
  }
  f.appendChild(cu);
  return f;
}

function formGarmin() {
  var email = h("input", { class: "campo", type: "email", placeholder: "Correo de Garmin Connect", autocomplete: "off", "aria-label": "Correo de Garmin" });
  var clave = h("input", { class: "campo", type: "password", placeholder: "Contraseña de Garmin", autocomplete: "off", "aria-label": "Contraseña de Garmin" });
  var btn = h("button", { class: "tecla primaria", type: "button", text: "ENLAZAR" });
  var salida = h("div");
  btn.addEventListener("click", async function () {
    btn.disabled = true; salida.innerHTML = "";
    try {
      await post("/app/garmin/enlazar", { email: email.value, password: clave.value });
      carga("garmin", "/app/garmin/estado", true);
    } catch (e) {
      salida.appendChild(h("div", { class: "error-caja", text: e.message }));
      btn.disabled = false;
    }
  });
  return h("div", { class: "form" }, [
    h("span", { class: "sub", text: "Se enlaza una vez. La contraseña se usa para entrar y se olvida: no se guarda en ningún sitio." }),
    email, clave, btn, salida
  ]);
}

function vistaConstancia() {
  var r = S.datos.rachas;
  if (!r) { columnas([volver(), hueco("rachas", "CONTANDO DÍAS…")]); return; }
  var x = r.rachas;
  function caja(nombre, ra, unidad) {
    return tarjeta("", [etq(nombre), h("span", { class: "cifra-l", text: String(ra.actual) }), h("span", { class: "sub", text: unidad + " · mejor " + ra.mejor + (ra.pendiente ? " · hoy aún cuenta" : "") })]);
  }
  var a = [volver(), h("div", { class: "rejilla2" }, [
    caja("Moviéndote", x.movimiento, "días"), caja("Lo que tocaba", x.cumplimiento, "días"),
    caja("Durmiendo bien", x.sueno, "noches"), caja("Semanas cumplidas", x.semanal, "semanas")
  ])];
  if (x.aviso) a.push(tarjeta("coral", [etq("Ojo"), h("span", { style: "font-size:14px", text: x.aviso.texto })]));
  if (!r.calendarioLeido) a.push(h("div", { class: "error-caja", text: "Calendario de Garmin sin leer: el cumplimiento del plan y los descansos escritos no cuentan." }));
  var mapa = h("div", { class: "mapa", role: "img", "aria-label": "Últimos " + x.dias.length + " días" });
  x.dias.forEach(function (d) { mapa.appendChild(h("i", { class: d.estado, title: d.fecha + ": " + d.estado })); });
  var b = [tarjeta("", [
    h("div", { class: "fila-sep" }, [h("span", { class: "titulo", text: "ÚLTIMOS " + x.dias.length + " DÍAS" }), etq("DESDE " + diaMes(x.desde))]),
    mapa,
    h("div", { class: "leyenda" }, [
      h("span", { style: "color:var(--mar)", text: "■ ACTIVO" }), h("span", { style: "color:var(--sol)", text: "■ DESCANSO ESCRITO" }), h("span", { style: "color:var(--coral)", text: "■ PERDIDO" })
    ]),
    h("span", { class: "sub", text: "Un día vacío es un día perdido, no un descanso: el descanso cuenta solo si estaba escrito. Una racha nunca es razón para entrenar." })
  ])];
  columnas(a, b);
}

function vistaDiarioCampos() {
  var d = S.datos.diario;
  var a = [volver()], b = [];
  if (!d) { a.push(hueco("diario", "LEYENDO EL DIARIO…")); columnas(a); return; }
  a.push(tarjeta("", [
    h("span", { style: "display:flex;gap:8px;align-items:center" }, [icono("lapiz", 16, "var(--mar)"), h("span", { class: "titulo", text: "DIARIO" })]),
    h("span", { class: "sub", text: "Lo que le cuentas al entrenador, día a día, en las últimas dos semanas. Se apunta hablando con él; aquí solo se mira. Un cuadro vacío es un día sin registro, no un 0." })
  ]));
  if (!d.campos.length) a.push(h("span", { class: "vacio", text: "Aún no sigues nada: díselo al entrenador y él crea el campo con su escala." }));
  d.campos.forEach(function (c, i) { (i % 2 ? b : a).push(tarjetaCampoDiario(c, d.hoy, 14)); });
  columnas(a, b.length ? b : null);
}

function vistaMaterial() {
  var m = S.datos.material;
  var a = [volver()], b = [];
  if (!m) { a.push(hueco("material", "LEYENDO EL MATERIAL…")); columnas(a); return; }
  var porCat = {};
  m.articulos.forEach(function (x) { var k = x.categoriaEtiqueta || x.categoria; (porCat[k] = porCat[k] || []).push(x); });
  var activos = m.articulos.filter(function (x) { return x.estado !== "retirado"; }).length;
  a.push(tarjeta("", [
    h("span", { class: "titulo", text: "MATERIAL" }),
    h("span", { class: "sub", text: activos + " cosas disponibles en " + Object.keys(porCat).length + " categorías. Lo que no está aquí, no lo tienes: el entrenador no programa con ello. Para cambiarlo, díselo." })
  ]));
  Object.keys(porCat).sort().forEach(function (cat, i) {
    var lista = porCat[cat].slice().sort(function (x, y) { return (x.estado === "retirado") - (y.estado === "retirado"); });
    var t = tarjeta("", [etq(cat)]);
    lista.forEach(function (x) {
      var retirado = x.estado === "retirado";
      t.appendChild(h("div", { style: "display:flex;flex-direction:column;border-top:2px solid var(--dim);padding-top:8px" + (retirado ? ";opacity:.55" : "") }, [
        h("span", { style: "font-weight:600;font-size:14px", text: x.nombre + (retirado ? " (retirado)" : "") }),
        x.detalle ? h("span", { class: "sub", text: x.detalle }) : null
      ]));
    });
    (i % 2 ? b : a).push(t);
  });
  columnas(a, b);
}

function vistaHistorial() {
  var l = S.datos.log;
  var a = [volver()];
  if (!l) { a.push(hueco("log", "LEYENDO EL HISTORIAL…")); columnas(a); return; }
  var entradas = l.entradas.concat(S.logExtra);
  a.push(tarjeta("", [h("span", { class: "titulo", text: "HISTORIAL" }), h("span", { class: "sub", text: "Cada acuerdo queda aquí, del más reciente al más antiguo. No se edita ni se borra." })]));
  entradas.forEach(function (e) {
    a.push(h("article", { class: "tarjeta" }, [
      h("div", { class: "fila-sep" }, [etq(e.version ? "V" + e.version : "NOTA", "color:var(--mar)"), etq(fechaLarga(e.fecha).toUpperCase())]),
      h("p", { style: "font-size:14px;white-space:pre-wrap", text: e.mensaje })
    ]));
  });
  if (!S.logFin && entradas.length) {
    var mas = h("button", { class: "tecla", type: "button", text: "CARGAR MÁS" });
    mas.addEventListener("click", async function () {
      mas.disabled = true;
      try {
        var ult = entradas[entradas.length - 1];
        var r = await api("/log?limit=30&antes_id=" + encodeURIComponent(ult.id));
        if (!r.entradas.length) S.logFin = true;
        S.logExtra = S.logExtra.concat(r.entradas);
        pinta();
      } catch (e) { alert(e.message); mas.disabled = false; }
    });
    a.push(mas);
  }
  columnas(a);
}

// --------------------------------------------------------------- arranque
function irA() {
  leerRuta();
  pintaTabs();
  cargaVista(false);
  pinta();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", irA);
document.getElementById("refrescar").addEventListener("click", function () { cargaVista(true); });
var anchoEscritorio = window.matchMedia("(min-width: 900px)");
if (anchoEscritorio.addEventListener) anchoEscritorio.addEventListener("change", function () { pinta(); });
irA();
`;

export function appPage(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="${COLORES.arena}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="zancada">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icono.svg?v=2" type="image/svg+xml">
<link rel="preload" href="/fuentes/bungee.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fuentes/silkscreen.woff2" as="font" type="font/woff2" crossorigin>
<title>zancada</title>
<style>
${CSS_BASE}
${CSS_PANEL}
</style>
</head>
<body>
<header class="hud">
  <div class="pintas" aria-hidden="true"></div>
  <div class="fila">
    <a class="logo" href="#hoy">ZANCADA</a>
    <span class="etq" id="fecha-hoy"></span>
    <span class="etq" id="version-chip"></span>
    <button class="tecla" id="refrescar" type="button" aria-label="Volver a leer los datos">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"></path><path d="M21 3v5h-5"></path></svg>
    </button>
  </div>
</header>
<nav id="tabs" aria-label="Secciones"></nav>
<main id="contenido"></main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
