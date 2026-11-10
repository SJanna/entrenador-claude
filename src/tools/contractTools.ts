/**
 * Herramientas MCP del contrato: la app (D1) es la fuente de verdad.
 * get_contract reemplaza la lectura de la zona 2099; contract_commit reemplaza
 * el protocolo manual de commit (log + snapshot + versión) con una operación atómica.
 *
 * LECTURA COMPACTA POR DEFECTO. El 03/09/2026 el contrato completo medía
 * 185.000 caracteres y dejó de caber en una lectura: el entrenador pasó a
 * buscar dentro con grep y se saltó reglas vigentes. Desde entonces
 * get_contract devuelve una línea por entrada (el `resumen`, o el principio
 * del texto recortado cuando aún no lo hay) y el detalle se pide aparte.
 * El ancho del recorte se calcula para que la vista entera quepa en
 * PRESUPUESTO_COMPACTO; cuantos más `resumen` haya, menos hace falta recortar.
 */

import { GUION_ARRANQUE } from "../contract/arranque";
import type {
  Carrera,
  ContractSnapshot,
  ContractStore,
  CommitInput,
  Disparador,
  EstadoEntry,
  LogEntry,
  Pendiente,
  Regla,
} from "../contract/store";
import {
  ContractError,
  DIAS_CADUCIDAD_PENDIENTE,
  formatoMiles,
  longitud,
  venceEsCondicion,
  venceLegible,
} from "../contract/store";
import type { MaterialStore } from "../material/store";
import { resumenMaterial } from "./materialTools";

/** Tope de la vista compacta: tiene que caber en una lectura, siempre. */
export const PRESUPUESTO_COMPACTO = 15_000;
/** El recorte de los textos sin `resumen` se mueve entre estos dos anchos. */
export const ANCHO_MIN = 60;
export const ANCHO_MAX = 300;
/** Un pendiente o una clave de estado sin tocar más de esto se marca ESTANCADO. */
export const DIAS_ESTANCADO = 60;
/** Con este margen o menos para caducar, el pendiente lo avisa en su línea. */
export const DIAS_AVISO_CADUCIDAD = 14;
/** Avisos de tamaño sobre el contrato completo. */
export const UMBRAL_AVISO_TOTAL = 60_000;
export const UMBRAL_AVISO_SECCION = 0.35;

export type Seccion =
  | "reglas"
  | "estado"
  | "pendientes"
  | "disparadores"
  | "condiciones"
  | "carreras"
  | "material";

const SECCIONES: Seccion[] = [
  "reglas", "estado", "pendientes", "disparadores", "condiciones", "carreras", "material",
];

export interface OpcionesVista {
  seccion?: Seccion | null;
  /** true = sección (o contrato) completa; string/número = una entrada por id. */
  detalle?: boolean | string | number | null;
  /** Líneas ya renderizadas del resumen de material (resumenMaterial). */
  material?: string[];
}

export function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const from = Date.UTC(fy!, fm! - 1, fd!);
  const to = Date.UTC(ty!, tm! - 1, td!);
  return Math.round((to - from) / 86_400_000);
}

/**
 * Recorta a `ancho` puntos de código, cortando por palabra si hay una cerca,
 * y deja marcado cuánto falta: «…[+1.842]». Sin ancho (null) no recorta.
 */
export function recortar(texto: string, ancho: number | null): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  if (ancho === null) return limpio;
  const total = longitud(limpio);
  if (total <= ancho) return limpio;
  const chars = [...limpio];
  let corte = ancho;
  for (let i = ancho; i > ancho - 20 && i > 0; i--) {
    if (chars[i] === " ") {
      corte = i;
      break;
    }
  }
  return `${chars.slice(0, corte).join("").trimEnd()} …[+${formatoMiles(total - corte)}]`;
}

function estaEstancado(ultimaFecha: string, hoy: string): number | null {
  const dias = daysBetween(ultimaFecha, hoy);
  return dias > DIAS_ESTANCADO ? dias : null;
}

// ------------------------------------------------------------ secciones

/**
 * Cada sección se renderiza con un `ancho` (null = completa). Los textos que
 * se recortan son los que no tienen `resumen`; un `resumen` va siempre entero.
 */
function lineasReglas(snap: ContractSnapshot, ancho: number | null): string[] {
  const out = [`REGLAS ACTIVAS (${snap.reglas.length}):`];
  if (!snap.reglas.length) return [...out, "(ninguna)"];
  for (const r of snap.reglas) {
    const cabecera = `${r.id}${Number(r.protegida ?? 0) === 1 ? " 🔒" : ""} ${r.tema} | vence ${venceLegible(r.vence)} | `;
    if (r.resumen) {
      out.push(cabecera + recortar(r.resumen, null));
      if (ancho === null) out.push(`    ↳ ${recortar(r.contenido, null)}`);
    } else {
      out.push(cabecera + recortar(r.contenido, ancho));
    }
  }
  return out;
}

function lineasEstado(snap: ContractSnapshot, ancho: number | null): string[] {
  const out = ["ESTADO:"];
  if (!snap.estado.length) return [...out, "(vacío)"];
  for (const e of snap.estado) {
    const dias = estaEstancado(e.actualizado_en, snap.hoy);
    const marca = dias ? ` · ESTANCADO ${dias} días` : "";
    out.push(`${e.clave}: ${recortar(e.valor, ancho)}  (actualizado ${e.actualizado_en}${marca})`);
  }
  return out;
}

/**
 * Días que le quedan a un pendiente sin `vence` antes de caducar solo, o null
 * si aún falta mucho (o si tiene fecha propia, que manda sobre esto).
 *
 * Existe para que la caducidad no se lleve nada por sorpresa: primero se ve
 * venir en la línea del pendiente, y solo después se cierra.
 */
export function caducaEn(p: Pendiente, hoy: string): number | null {
  if (p.vence && !venceEsCondicion(p.vence)) return null;
  const restan = DIAS_CADUCIDAD_PENDIENTE - daysBetween(p.actualizado_en ?? p.creado_en, hoy);
  return restan <= DIAS_AVISO_CADUCIDAD ? Math.max(0, restan) : null;
}

function lineaPendiente(p: Pendiente, hoy: string, ancho: number | null): string[] {
  const ultima = p.actualizado_en ?? p.creado_en;
  const dias = estaEstancado(ultima, hoy);
  const restan = caducaEn(p, hoy);
  const meta = [
    `desde ${p.creado_en}`,
    p.actualizado_en && p.actualizado_en !== p.creado_en ? `tocado ${p.actualizado_en}` : null,
    p.vence ? `vence ${venceLegible(p.vence)}` : null,
    dias ? `ESTANCADO: sin modificar desde ${ultima}, ${dias} días` : null,
    restan !== null
      ? `⚠ CADUCA EN ${restan} DÍA${restan === 1 ? "" : "S"}: tócalo, ciérralo o ponle 'vence'`
      : null,
  ].filter(Boolean);
  const texto = p.resumen ? recortar(p.resumen, null) : recortar(p.texto, ancho);
  const lineas = [`#${p.id} ${texto}  (${meta.join(" · ")})`];
  if (p.resumen && ancho === null) lineas.push(`    ↳ ${recortar(p.texto, null)}`);
  return lineas;
}

function lineasPendientes(snap: ContractSnapshot, ancho: number | null): string[] {
  const out = [`PENDIENTES (${snap.pendientes.length}):`];
  if (!snap.pendientes.length) return [...out, "(ninguno)"];
  for (const p of snap.pendientes) out.push(...lineaPendiente(p, snap.hoy, ancho));
  return out;
}

function lineaDisparador(d: Disparador, ancho: number | null): string {
  return `#${d.id} ${d.fecha} → ${recortar(d.accion, ancho)}`;
}

function lineasDisparadores(snap: ContractSnapshot, ancho: number | null): string[] {
  const out: string[] = [];
  if (snap.disparadoresVencidos.length) {
    // Los vencidos van SIEMPRE enteros: hay que ejecutarlos ahora.
    out.push(
      `DISPARADORES VENCIDOS — ACTÚA SOBRE ELLOS (${snap.disparadoresVencidos.length}):`,
      ...snap.disparadoresVencidos.map((d) => lineaDisparador(d, null)),
      "(al atenderlos, ciérralos con contract_commit → disparadores: completar)",
      "",
    );
  }
  out.push(`DISPARADORES PRÓXIMOS (${snap.disparadores.length}):`);
  if (!snap.disparadores.length) out.push("(ninguno)");
  for (const d of snap.disparadores) out.push(lineaDisparador(d, ancho));
  return out;
}

function lineasCondiciones(snap: ContractSnapshot, ancho: number | null): string[] {
  const out = [`CONDICIONES ESPECIALES ACTIVAS (${snap.condiciones.length}):`];
  if (!snap.condiciones.length) return [...out, "(ninguna)"];
  for (const c of snap.condiciones) {
    const rango =
      c.desde || c.hasta ? ` [${c.desde ?? "…"} → ${c.hasta ?? "sin fecha de fin"}]` : "";
    out.push(`#${c.id}${rango} ${recortar(c.texto, ancho)}`);
  }
  return out;
}

function lineaCarrera(carrera: Carrera, snap: ContractSnapshot, ancho: number | null): string {
  const bits = [
    carrera.prioridad ? `[${carrera.prioridad}]` : null,
    carrera.nombre,
    carrera.fecha ?? "sin fecha",
    carrera.distancia_km ? `${carrera.distancia_km}km` : null,
    carrera.desnivel_m ? `+${carrera.desnivel_m}m` : null,
    carrera.estado,
  ].filter(Boolean);
  let line = `#${carrera.id} ` + bits.join(" · ");
  if (carrera.fecha && carrera.fecha >= snap.hoy) {
    line += ` · faltan ${daysBetween(snap.hoy, carrera.fecha)} días`;
  }
  const gemelas = snap.carreras.filter((c) => c.id !== carrera.id && c.fecha && c.fecha === carrera.fecha);
  if (gemelas.length) {
    line += ` · ⚠ misma fecha que ${gemelas.map((c) => `#${c.id}`).join(", ")} (¿ficha duplicada?)`;
  }
  if (carrera.notas) line += ` · ${recortar(carrera.notas, ancho)}`;
  return line;
}

function lineasCarreras(snap: ContractSnapshot, ancho: number | null): string[] {
  const out = [`CARRERAS Y OBJETIVOS CON FECHA (${snap.carreras.length}):`];
  if (!snap.carreras.length) return [...out, "(ninguna)"];
  for (const c of snap.carreras) out.push(lineaCarrera(c, snap, ancho));
  return out;
}

function lineasSeccion(
  seccion: Seccion,
  snap: ContractSnapshot,
  ancho: number | null,
  material: string[],
): string[] {
  switch (seccion) {
    case "reglas": return lineasReglas(snap, ancho);
    case "estado": return lineasEstado(snap, ancho);
    case "pendientes": return lineasPendientes(snap, ancho);
    case "disparadores": return lineasDisparadores(snap, ancho);
    case "condiciones": return lineasCondiciones(snap, ancho);
    case "carreras": return lineasCarreras(snap, ancho);
    case "material": return material.length ? material : ["MATERIAL DISPONIBLE: (sin datos)"];
  }
}

// ------------------------------------------------------------- cabecera y pie

function cabecera(snap: ContractSnapshot, vista: string): string[] {
  const out = [`[CONTRATO] v${snap.version} · último commit ${snap.ultimoCommit || "—"} · hoy ${snap.hoy} · ${vista}`];
  if (snap.columnasAusentes.length) {
    // El código puede desplegarse antes que su migración. Cuando pasa, el
    // contrato se lee igual: esto dice qué está apagado mientras tanto, para
    // que no parezca que el dato no existe cuando lo que falta es la columna.
    // Denso a propósito: es un aviso temporal y compite por el presupuesto de
    // la vista compacta con las entradas, que son lo que hay que leer.
    const apagado = [
      snap.columnasAusentes.some((c) => c.endsWith(".resumen")) ? "resúmenes" : null,
      snap.columnasAusentes.includes("pendientes.vence") ? "caducidad de pendientes" : null,
      snap.columnasAusentes.includes("pendientes.actualizado_en") ? "ESTANCADO de pendientes" : null,
    ].filter(Boolean);
    out.push(
      "",
      `⚠ ESQUEMA ATRASADO: faltan ${snap.columnasAusentes.join(", ")} (migración 0006). ` +
        `Sin ${apagado.join(" ni ")}; el resto del contrato se lee y se escribe con normalidad, ` +
        "así que se puede prescribir. Arréglalo con 'npm run db:migrate'; hasta entonces no " +
        "mandes 'resumen' ni 'vence' de pendientes en un commit, que se rechazan.",
    );
  }
  if (snap.bajasAutomaticas.length || snap.pendientesVencidosHoy.length) {
    const n = snap.bajasAutomaticas.length + snap.pendientesVencidosHoy.length;
    out.push(
      "",
      `BAJAS AUTOMÁTICAS REGISTRADAS HOY (${n}):`,
      ...snap.bajasAutomaticas.map(
        (r) => `  ${r.id} ${r.tema} · vencía ${r.vence} → retirada y anotada en el log`,
      ),
      ...snap.pendientesVencidosHoy.map(
        (p) => `  pendiente #${p.id} ${recortar(p.resumen ?? p.texto, 80)} · vencía ${p.vence} → cerrado como vencido y anotado en el log`,
      ),
    );
  }
  return out;
}

/** Tamaño del contrato COMPLETO por sección, se pida la vista que se pida. */
export function medirContrato(snap: ContractSnapshot, material: string[]): Record<string, number> {
  const tam: Record<string, number> = {};
  for (const s of SECCIONES) {
    tam[s] = lineasSeccion(s, snap, null, material).join("\n").length;
  }
  tam.total = Object.values(tam).reduce((a, b) => a + b, 0);
  return tam;
}

function pieTamano(tam: Record<string, number>, respuesta: number): string[] {
  const out: string[] = [];
  const avisos: string[] = [];
  if (tam.total! > UMBRAL_AVISO_TOTAL) {
    avisos.push(`el contrato completo mide ${formatoMiles(tam.total!)} caracteres, por encima de ${formatoMiles(UMBRAL_AVISO_TOTAL)}`);
  }
  for (const s of SECCIONES) {
    if (s === "material" || tam.total === 0) continue;
    const parte = tam[s]! / tam.total!;
    if (parte > UMBRAL_AVISO_SECCION && tam[s]! > 5_000) {
      avisos.push(`${s} ocupa el ${Math.round(parte * 100)}% del total`);
    }
  }
  if (avisos.length) {
    out.push(
      `⚠ TAMAÑO: ${avisos.join("; ")}. Poda en el próximo commit: lo narrativo va en 'mensaje' ` +
        "(al log, sin límite) y en el contrato solo queda el mandato; los pendientes y reglas " +
        "largos se comprimen con 'resumen' sin cambiar de id.",
    );
  }
  out.push(
    `[TAMAÑO] ${SECCIONES.map((s) => `${s} ${formatoMiles(tam[s]!)}`).join(" · ")} · ` +
      `total ${formatoMiles(tam.total!)} caracteres (contrato completo) · esta respuesta ${formatoMiles(respuesta)}`,
  );
  return out;
}

/** Cierra cualquier vista con el pie [TAMAÑO], contando el propio pie. */
function conPie(lineas: string[], tam: Record<string, number>): string {
  const base = lineas.join("\n");
  // El pie cambia de longitud con su propio número: dos pasadas bastan.
  let pie = pieTamano(tam, base.length);
  let total = `${base}\n\n${pie.join("\n")}`;
  pie = pieTamano(tam, total.length);
  total = `${base}\n\n${pie.join("\n")}`;
  return total;
}

// ------------------------------------------------------------- vistas

function cuerpoCompacto(snap: ContractSnapshot, ancho: number, material: string[]): string[] {
  const out: string[] = [];
  for (const s of SECCIONES) out.push("", ...lineasSeccion(s, snap, ancho, material));
  return out;
}

/** A partir de cuántos pendientes parados hay que decirlo en voz alta. */
export const ESTANCADOS_AVISO = 5;
/** Disparadores en la MISMA fecha a partir de los cuales eso es una cola. */
export const APILADOS_AVISO = 3;

/**
 * Lo que la tabla de caracteres no cuenta.
 *
 * `[TAMAÑO]` mide el contrato COMPLETO, que casi nunca se lee entero. Lo que
 * encarece cada lectura es otra cosa: el NÚMERO de entradas, porque el
 * presupuesto de la vista compacta se reparte entre todas y el ancho baja para
 * que quepan. Con suficientes entradas, de una regla de 2.500 caracteres se
 * ven 70 y el contrato deja de gobernar: no porque falte, sino porque no se ve.
 *
 * Por eso aquí no se aconseja «podar» en abstracto, sino lo único que devuelve
 * ancho: cerrar entradas.
 */
export function saludContrato(snap: ContractSnapshot, ancho: number): string[] {
  const entradas =
    snap.reglas.length +
    snap.estado.length +
    snap.pendientes.length +
    snap.disparadores.length +
    snap.condiciones.length +
    snap.carreras.length;

  const estancados = snap.pendientes.filter((p) =>
    estaEstancado(p.actualizado_en ?? p.creado_en, snap.hoy),
  ).length;
  const porCaducar = snap.pendientes.filter((p) => caducaEn(p, snap.hoy) !== null).length;

  const porFecha = new Map<string, number>();
  for (const d of snap.disparadores) {
    porFecha.set(d.fecha, (porFecha.get(d.fecha) ?? 0) + 1);
  }
  let peorFecha = "";
  let peorCuenta = 0;
  for (const [fecha, cuenta] of porFecha) {
    if (cuenta > peorCuenta || (cuenta === peorCuenta && fecha < peorFecha)) {
      peorFecha = fecha;
      peorCuenta = cuenta;
    }
  }

  const avisos: string[] = [];
  if (ancho <= ANCHO_MIN + 20) {
    avisos.push(
      `El recorte está en ${ancho} caracteres por entrada, cerca del mínimo de ${ANCHO_MIN}: ` +
        "de las entradas largas ya casi no se ve nada. Comprimir textos NO devuelve ancho; " +
        "solo lo devuelve tener menos entradas.",
    );
  }
  if (estancados >= ESTANCADOS_AVISO) {
    avisos.push(
      `${estancados} de ${snap.pendientes.length} pendientes llevan más de ${DIAS_ESTANCADO} ` +
        "días sin tocarse. Ciérralos, fúndelos o ponles 'vence' para que caduquen solos: cada " +
        "uno cuesta una línea en todas las lecturas.",
    );
  }
  if (porCaducar) {
    avisos.push(
      `${porCaducar} pendiente${porCaducar === 1 ? "" : "s"} caduca${porCaducar === 1 ? "" : "n"} ` +
        `en menos de ${DIAS_AVISO_CADUCIDAD} días por inactividad y se cerrará` +
        `${porCaducar === 1 ? "" : "n"} solo${porCaducar === 1 ? "" : "s"}. Van marcados abajo: ` +
        "rescata los que sigan importando.",
    );
  }
  if (peorCuenta >= APILADOS_AVISO) {
    avisos.push(
      `${peorCuenta} disparadores caen el ${peorFecha}. Cuando llegue habrá que atenderlos ` +
        "todos antes de programar: si varios dicen lo mismo, fúndelos en uno ahora.",
    );
  }

  if (!avisos.length) return [];
  return [`⚠ SALUD (${entradas} entradas en el contrato):`, ...avisos.map((a) => `  · ${a}`)];
}

function notaCompacta(snap: ContractSnapshot, ancho: number): string[] {
  const sinResumen = {
    reglas: snap.reglas.filter((r) => !r.resumen).length,
    pendientes: snap.pendientes.filter((p) => !p.resumen).length,
  };
  const partes: string[] = [];
  if (sinResumen.reglas) partes.push(`${sinResumen.reglas} regla${sinResumen.reglas === 1 ? "" : "s"}`);
  if (sinResumen.pendientes) partes.push(`${sinResumen.pendientes} pendiente${sinResumen.pendientes === 1 ? "" : "s"}`);
  const out = [
    `Vista compacta: una línea por entrada; «…[+N]» = texto recortado, faltan N caracteres. ` +
      `Detalle: get_contract(detalle: "R001" | "#3" | "bloque") o get_contract(seccion: "pendientes", detalle: true).`,
  ];
  // Sin las columnas, pedir 'resumen' solo produce commits rechazados: el
  // aviso de la cabecera ya explica qué pasa y basta con eso.
  if (partes.length && !snap.columnasAusentes.some((c) => c.endsWith(".resumen"))) {
    out.push(
      `SIN 'resumen': ${partes.join(" y ")}; se muestran recortados a ${ancho} caracteres. ` +
        "Dales 'resumen' (el mandato operativo, ≤300) con contract_commit → reglas: modificar / " +
        "pendientes: actualizar, y dejarán de recortarse.",
    );
  }
  return out;
}

/**
 * Ancho de recorte: el mayor entre ANCHO_MIN y ANCHO_MAX con el que la vista
 * compacta entera cabe en el presupuesto. Binaria sobre el render, que es
 * barato (unas decenas de líneas).
 */
export function anchoCompacto(snap: ContractSnapshot, material: string[]): number {
  const tam = medirContrato(snap, material);
  const mide = (ancho: number) =>
    conPie(
      [
        ...cabecera(snap, "vista compacta"),
        ...notaCompacta(snap, ancho),
        ...saludContrato(snap, ancho),
        ...cuerpoCompacto(snap, ancho, material),
      ],
      tam,
    ).length;
  if (mide(ANCHO_MAX) <= PRESUPUESTO_COMPACTO) return ANCHO_MAX;
  let lo = ANCHO_MIN;
  let hi = ANCHO_MAX;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (mide(mid) <= PRESUPUESTO_COMPACTO) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function normalizarSeccion(value: unknown): Seccion | null {
  if (value === undefined || value === null || value === "") return null;
  const texto = String(value).trim().toLowerCase();
  const alias: Record<string, Seccion> = {
    regla: "reglas", reglas: "reglas",
    estado: "estado",
    pendiente: "pendientes", pendientes: "pendientes",
    disparador: "disparadores", disparadores: "disparadores",
    condicion: "condiciones", condición: "condiciones", condiciones: "condiciones",
    carrera: "carreras", carreras: "carreras",
    material: "material",
  };
  const s = alias[texto];
  if (!s) {
    throw new ContractError(
      `Sección desconocida: ${JSON.stringify(value)}. Usa ${SECCIONES.join(" | ")}.`,
    );
  }
  return s;
}

/** Vista de una sola entrada por id, entera. */
function vistaDetalle(
  snap: ContractSnapshot,
  seccion: Seccion | null,
  id: string,
  material: string[],
): string[] {
  const clave = id.trim();
  const out: string[] = [];
  const regla = /^R\d+$/i.test(clave) ? clave.toUpperCase() : null;
  const numero = /^#?(\d+)$/.exec(clave)?.[1];

  const buscarRegla = (): Regla | undefined => snap.reglas.find((r) => r.id === regla);
  const buscarEstado = (): EstadoEntry | undefined =>
    snap.estado.find((e) => e.clave.toLowerCase() === clave.toLowerCase());

  const encontrados: string[][] = [];
  if (regla && (!seccion || seccion === "reglas")) {
    const r = buscarRegla();
    if (r) {
      encontrados.push([
        `REGLA ${r.id}${Number(r.protegida ?? 0) === 1 ? " 🔒 PROTEGIDA (solo con cita textual del atleta)" : ""} ${r.tema} | vence ${venceLegible(r.vence)} | creada ${r.creada_en} (v${r.creada_version})`,
        r.resumen ? `resumen: ${r.resumen}` : "resumen: (sin resumen: dáselo con contract_commit → reglas: modificar)",
        `contenido: ${r.contenido}`,
      ]);
    }
  }
  if (numero !== undefined) {
    const n = Number(numero);
    if (!seccion || seccion === "pendientes") {
      const p = snap.pendientes.find((x) => x.id === n);
      if (p) {
        encontrados.push([
          `PENDIENTE #${p.id} · desde ${p.creado_en}${p.actualizado_en ? ` · actualizado ${p.actualizado_en}` : ""}${p.vence ? ` · vence ${venceLegible(p.vence)}` : ""}`,
          p.resumen ? `resumen: ${p.resumen}` : "resumen: (sin resumen: dáselo con contract_commit → pendientes: actualizar)",
          `texto: ${p.texto}`,
        ]);
      }
    }
    if (!seccion || seccion === "disparadores") {
      const d = [...snap.disparadoresVencidos, ...snap.disparadores].find((x) => x.id === n);
      if (d) encontrados.push([`DISPARADOR #${d.id} · ${d.fecha}${d.fecha <= snap.hoy ? " · VENCIDO" : ""}`, d.accion]);
    }
    if (!seccion || seccion === "carreras") {
      const c = snap.carreras.find((x) => x.id === n);
      if (c) encontrados.push([`CARRERA ${lineaCarrera(c, snap, null)}`, c.resultado ? `resultado: ${c.resultado}` : ""].filter(Boolean));
    }
    if (!seccion || seccion === "condiciones") {
      const c = snap.condiciones.find((x) => x.id === n);
      if (c) encontrados.push(...[lineasCondiciones({ ...snap, condiciones: [c] }, null).slice(1)].map((l) => ["CONDICIÓN " + l.join("\n")]));
    }
  }
  if (!regla && numero === undefined && (!seccion || seccion === "estado")) {
    const e = buscarEstado();
    if (e) {
      const dias = estaEstancado(e.actualizado_en, snap.hoy);
      encontrados.push([
        `ESTADO ${e.clave} · actualizado ${e.actualizado_en}${dias ? ` · ESTANCADO ${dias} días` : ""}`,
        e.valor,
      ]);
    }
  }
  if (seccion === "material") {
    encontrados.push(material);
  }

  if (!encontrados.length) {
    const donde = seccion ? `en ${seccion}` : "entre las reglas activas, pendientes abiertos, disparadores, carreras, condiciones ni claves de estado";
    throw new ContractError(
      `No hay ninguna entrada activa con id ${JSON.stringify(id)} ${donde}. ` +
        "Ids válidos: R001 (regla), 3 o #3 (pendiente/disparador/carrera/condición; " +
        "añade 'seccion' si el número es ambiguo) o el nombre de una clave de estado. " +
        "Lo retirado o resuelto vive en el log: get_log(buscar: ...).",
    );
  }
  for (const bloque of encontrados) out.push("", ...bloque);
  return out;
}

/**
 * Render principal. Sin opciones → vista compacta. Con `seccion` → solo esa
 * sección (compacta, o entera con detalle: true). Con `detalle` id → esa
 * entrada entera. `detalle: true` sin sección → contrato entero (como antes).
 * Todas las vistas terminan con la línea [TAMAÑO].
 */
export function renderContract(snap: ContractSnapshot, opts: OpcionesVista = {}): string {
  const material = opts.material ?? [];
  const seccion = normalizarSeccion(opts.seccion);
  const detalle = opts.detalle;
  const tam = medirContrato(snap, material);

  const esId = typeof detalle === "number" || (typeof detalle === "string" && detalle.trim() !== "" &&
    !["true", "false"].includes(detalle.trim().toLowerCase()));
  const completo = detalle === true || (typeof detalle === "string" && detalle.trim().toLowerCase() === "true");

  if (esId) {
    const lineas = [...cabecera(snap, `detalle de ${String(detalle).trim()}`), ...vistaDetalle(snap, seccion, String(detalle), material)];
    return conPie(lineas, tam);
  }
  if (seccion) {
    const ancho = completo ? null : anchoCompacto(snap, material);
    const lineas = [
      ...cabecera(snap, `sección ${seccion}${completo ? " completa" : " compacta"}`),
      "",
      ...lineasSeccion(seccion, snap, ancho, material),
    ];
    if (!completo) lineas.push("", `(entera: get_contract(seccion: "${seccion}", detalle: true))`);
    return conPie(lineas, tam);
  }
  if (completo) {
    const lineas = [...cabecera(snap, "contrato completo")];
    for (const s of SECCIONES) lineas.push("", ...lineasSeccion(s, snap, null, material));
    return conPie(lineas, tam);
  }
  const ancho = anchoCompacto(snap, material);
  const lineas = [
    ...cabecera(snap, "vista compacta"),
    ...notaCompacta(snap, ancho),
    ...saludContrato(snap, ancho),
    ...cuerpoCompacto(snap, ancho, material),
  ];
  // Atleta nuevo: el guion de la primera conversación, solo mientras siga en v0.
  if (snap.version === 0) lineas.push(...GUION_ARRANQUE.split("\n"));
  return conPie(lineas, tam);
}

// ------------------------------------------------------------- log

const ANCHO_INDICE_LOG = 80;
const INDICE_LOG_POR_DEFECTO = 40;

function resumenCambios(detalles: string | null): string {
  if (!detalles) return "";
  try {
    const det = JSON.parse(detalles) as Record<string, unknown>;
    if (det.tipo === "expiracion_automatica") return "baja automática";
    if (det.tipo === "importado_de_intervals") return "histórico importado";
    const parts: string[] = [];
    for (const [key, value] of Object.entries(det)) {
      if (Array.isArray(value) && value.length) parts.push(`${key} ${value.length}`);
      else if (value && typeof value === "object" && Object.keys(value).length) {
        parts.push(`${key} ${Object.keys(value).length}`);
      }
    }
    return parts.join(", ");
  } catch {
    return "";
  }
}

function etiquetaVersion(entry: LogEntry): string {
  return entry.version === null ? "hist." : `v${entry.version}`;
}

/** Una línea por entrada: versión, fecha, principio del mensaje y qué tocó. */
export function lineaIndiceLog(entry: LogEntry): string {
  const cambios = resumenCambios(entry.detalles);
  return `${etiquetaVersion(entry)} · ${entry.fecha} · ${recortar(entry.mensaje, ANCHO_INDICE_LOG)}${cambios ? ` [${cambios}]` : ""}`;
}

function textoCambio(seccion: string, cambio: unknown): string {
  if (!cambio || typeof cambio !== "object") return `${seccion}: ${JSON.stringify(cambio)}`;
  const c = cambio as Record<string, unknown>;
  const partes: string[] = [];
  for (const [k, v] of Object.entries(c)) {
    if (k === "accion" || v === undefined || v === null || v === "") continue;
    partes.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return `${seccion} · ${String(c.accion ?? "?")}${partes.length ? ` · ${partes.join(" · ")}` : ""}`;
}

/** Entrada completa: mensaje íntegro y cada cambio estructurado en su línea. */
export function lineasEntradaLog(entry: LogEntry): string[] {
  const out = [`${etiquetaVersion(entry)} · ${entry.fecha} · #${entry.id}`, `  ${entry.mensaje}`];
  if (!entry.detalles) return out;
  try {
    const det = JSON.parse(entry.detalles) as Record<string, unknown>;
    if (det.tipo === "expiracion_automatica") {
      const reglas = Array.isArray(det.reglas) ? det.reglas : [];
      const pend = Array.isArray(det.pendientes) ? det.pendientes : [];
      const bits = [
        reglas.length ? `reglas ${reglas.join(", ")}` : null,
        pend.length ? `pendientes ${pend.map((p) => `#${p}`).join(", ")}` : null,
      ].filter(Boolean);
      out.push(`  cambios → baja automática: ${bits.join(" · ")}`);
      return out;
    }
    if (det.tipo === "importado_de_intervals") return out;
    for (const [seccion, value] of Object.entries(det)) {
      if (Array.isArray(value)) {
        for (const cambio of value) out.push(`  · ${textoCambio(seccion, cambio)}`);
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out.push(`  · ${seccion} · ${k} = ${v === null ? "(borrada)" : String(v)}`);
        }
      }
    }
  } catch {
    out.push(`  detalles: ${entry.detalles}`);
  }
  return out;
}

export interface OpcionesLog {
  limit?: unknown;
  antes_de?: unknown;
  version?: unknown;
  desde?: unknown;
  hasta?: unknown;
  buscar?: unknown;
}

function fragmentoCoincidencia(entry: LogEntry, buscar: string): string | null {
  const texto = `${entry.mensaje}\n${entry.detalles ?? ""}`;
  const idx = texto.toLowerCase().indexOf(buscar.toLowerCase());
  if (idx < 0) return null;
  const desde = Math.max(0, idx - 60);
  const hasta = Math.min(texto.length, idx + buscar.length + 60);
  return `${desde > 0 ? "…" : ""}${texto.slice(desde, hasta).replace(/\s+/g, " ")}${hasta < texto.length ? "…" : ""}`;
}

export class ContractTools {
  constructor(
    private store: ContractStore,
    private material?: MaterialStore,
  ) {}

  private async guard(fn: () => Promise<string>, name: string): Promise<string> {
    try {
      return await fn();
    } catch (exc) {
      if (exc instanceof ContractError) return `Error: ${exc.message}`;
      console.error(`Fallo inesperado en ${name}`, exc);
      const message = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
      return `Error inesperado en ${name}: ${message}. Nada se ha escrito a medias: los commits son atómicos.`;
    }
  }

  /**
   * El contrato, más el resumen del material. Van juntos a propósito: sin
   * saber qué tiene el atleta, cualquier recomendación de material es supuesta,
   * y una herramienta aparte que hay que acordarse de llamar no lo garantiza.
   * Aquí caben en tres líneas y el detalle sigue estando en get_material.
   */
  getContract(seccion?: unknown, detalle?: unknown): Promise<string> {
    return this.guard(async () => {
      const snap = await this.store.snapshot();
      const material = this.material ? resumenMaterial(await this.material.listar()) : [];
      return renderContract(snap, {
        seccion: seccion as Seccion | null | undefined,
        detalle: detalle as OpcionesVista["detalle"],
        material,
      });
    }, "get_contract");
  }

  contractCommit(input: CommitInput): Promise<string> {
    return this.guard(async () => {
      const result = await this.store.commit(input);
      const lines = [
        `commit v${result.version} · ${input.mensaje}`,
      ];
      if (result.resumen.length) {
        lines.push("", "Cambios aplicados:", ...result.resumen.map((r) => `  ${r}`));
      } else {
        lines.push("", "(solo registro en el log, sin cambios estructurales)");
      }
      if (result.avisos.length) {
        lines.push("", "Avisos:", ...result.avisos.map((a) => `  ${a}`));
      }
      lines.push("", "Escrito de forma atómica: log + cambios + versión.");
      return lines.join("\n");
    }, "contract_commit");
  }

  /**
   * Lectura del log. Por defecto un ÍNDICE de una línea por entrada (el log
   * completo pasa de 129.000 caracteres y crece con cada commit); las entradas
   * enteras se piden por versión o por rango, y `buscar` filtra por texto.
   * Solo lectura: el log sigue siendo append-only.
   */
  getLog(opts: OpcionesLog = {}): Promise<string> {
    return this.guard(async () => {
      const limitParsed = parseInt(String(opts.limit ?? ""), 10);
      const limit = Number.isFinite(limitParsed) ? limitParsed : null;
      const antesDe = opts.antes_de ? String(opts.antes_de) : undefined;

      // --- Una versión, entera ---
      if (opts.version !== undefined && opts.version !== null && opts.version !== "") {
        const v = parseInt(String(opts.version).replace(/^v/i, ""), 10);
        if (!Number.isFinite(v)) throw new ContractError(`'version' debe ser un número (recibido ${JSON.stringify(opts.version)}).`);
        const entry = await this.store.logPorVersion(v);
        if (!entry) {
          return `No hay entrada de log con versión v${v}. Las entradas históricas importadas no tienen versión: búscalas por fecha con desde/hasta o por texto con buscar.`;
        }
        return [`Log del contrato · entrada completa`, "", ...lineasEntradaLog(entry)].join("\n");
      }

      // --- Rango (fechas o versiones), entradas enteras ---
      const hayRango = [opts.desde, opts.hasta].some((x) => x !== undefined && x !== null && x !== "");
      if (hayRango) {
        const entries = await this.store.logRango(opts.desde, opts.hasta, limit ?? 200);
        if (!entries.length) return "Ninguna entrada de log en ese rango.";
        const out = [
          `Log del contrato · ${entries.length} entradas completas (más reciente primero) · rango ${opts.desde ?? "inicio"} → ${opts.hasta ?? "hoy"}`,
        ];
        for (const entry of entries) out.push("", ...lineasEntradaLog(entry));
        if (entries.length >= (limit ?? 200)) out.push("", `(recortado a ${entries.length}; estrecha el rango o sube 'limit')`);
        return out.join("\n");
      }

      // --- Búsqueda por texto: índice con el fragmento que coincide ---
      const buscar = opts.buscar ? String(opts.buscar).trim() : "";
      if (buscar) {
        const entries = await this.store.logBuscar(buscar, limit ?? INDICE_LOG_POR_DEFECTO);
        if (!entries.length) return `Ninguna entrada del log contiene ${JSON.stringify(buscar)}.`;
        const out = [`Log del contrato · ${entries.length} entradas que contienen ${JSON.stringify(buscar)} (más reciente primero)`, ""];
        for (const entry of entries) {
          out.push(lineaIndiceLog(entry));
          const frag = fragmentoCoincidencia(entry, buscar);
          if (frag) out.push(`    ${frag}`);
        }
        out.push("", "Entrada entera: get_log(version: N). Rango: get_log(desde, hasta) con fechas o versiones.");
        return out.join("\n");
      }

      // --- Índice por defecto ---
      const n = limit ?? INDICE_LOG_POR_DEFECTO;
      const [entries, total] = await Promise.all([this.store.log(n, antesDe), this.store.logTotal()]);
      if (!entries.length) {
        return "El log está vacío. Cada contract_commit añade una entrada; nunca se borran.";
      }
      const out = [
        `Log del contrato · índice de ${entries.length} de ${total} entradas (más reciente primero) · append-only`,
        "",
        ...entries.map(lineaIndiceLog),
      ];
      const masAntigua = entries[entries.length - 1]!;
      const quedan = total - entries.length;
      out.push(
        "",
        `Entrada entera: get_log(version: ${entries[0]!.version ?? "N"}). Rango entero: get_log(desde: "2026-08-01", hasta: "2026-08-31") o get_log(desde: 120, hasta: 125). Buscar: get_log(buscar: "texto").` +
          (quedan > 0 ? ` Más antiguas (${quedan}): get_log(antes_de: "${masAntigua.fecha}", limit: ${n}).` : ""),
      );
      return out.join("\n");
    }, "get_log");
  }
}
