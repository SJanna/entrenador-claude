/**
 * Importador: lee el sistema antiguo del calendario de intervals.icu
 * (zona 2099 + notas [LOG]/[NOTA]/[REVISAR] + carreras) y lo convierte en
 * datos estructurados para D1. Dos fases: vista previa → aplicar.
 */

import type { IntervalsClient, JsonRecord } from "../intervals/client";
import type { ContractStore, CommitInput } from "../contract/store";

const RULE_RE = /^(R\d+)\s+(.*?)\s*\|\s*vence\s+(\S+)\s*\|\s*(.*)$/;
const TRIGGER_RE = /^(\d{4}-\d{2}-\d{2})\s*(?:→|->)\s*(.+)$/;
const STATE_RE = /^([\wáéíóúñÁÉÍÓÚÑ_.\- ]{1,60}):\s*(.+)$/;
const VERSION_RE = /\[SYS\/CONTRATO\]\s*v(\d+)/i;

export interface ImportPreview {
  version: number | null;
  reglas: Array<{ id: string; tema: string; vence: string | null; contenido: string }>;
  disparadores: Array<{ fecha: string; accion: string }>;
  estado: Array<{ clave: string; valor: string }>;
  pendientes: string[];
  logs: Array<{ fecha: string; texto: string }>;
  condiciones: Array<{ desde: string; texto: string }>;
  carreras: Array<{
    nombre: string;
    fecha: string | null;
    prioridad: string | null;
    eventId: string;
  }>;
  noInterpretado: Array<{ origen: string; linea: string }>;
  crudos: Array<{ nota: string; fecha: string; texto: string }>;
}

function cleanLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[-•*]\s+/, "").trim())
    .filter(Boolean);
}

export function parseContratoNote(text: string, preview: ImportPreview): void {
  const versionMatch = VERSION_RE.exec(text);
  if (versionMatch) preview.version = parseInt(versionMatch[1]!, 10);

  let inTriggers = false;
  for (const line of cleanLines(text)) {
    if (/^---.*DISPARADORES.*---$/i.test(line) || /^DISPARADORES\b/i.test(line)) {
      inTriggers = true;
      continue;
    }
    if (/^\[SYS\/CONTRATO\]/i.test(line) || /^---/.test(line)) continue;

    if (inTriggers) {
      const match = TRIGGER_RE.exec(line);
      if (match) {
        preview.disparadores.push({ fecha: match[1]!, accion: match[2]!.trim() });
      } else {
        preview.noInterpretado.push({ origen: "[SYS/CONTRATO] disparadores", linea: line });
      }
      continue;
    }

    const rule = RULE_RE.exec(line);
    if (rule) {
      const vence = rule[3]!.toLowerCase() === "nunca" ? null : rule[3]!;
      preview.reglas.push({
        id: rule[1]!.toUpperCase(),
        tema: rule[2]!.trim(),
        vence,
        contenido: rule[4]!.trim(),
      });
    } else {
      preview.noInterpretado.push({ origen: "[SYS/CONTRATO]", linea: line });
    }
  }
}

export function parseEstadoNote(text: string, preview: ImportPreview): void {
  for (const line of cleanLines(text)) {
    if (/^\[SYS\/ESTADO\]/i.test(line) || /^---/.test(line)) continue;
    const match = STATE_RE.exec(line);
    if (match) {
      preview.estado.push({ clave: match[1]!.trim(), valor: match[2]!.trim() });
    } else {
      preview.noInterpretado.push({ origen: "[SYS/ESTADO]", linea: line });
    }
  }
}

export function parsePendientesNote(text: string, preview: ImportPreview): void {
  for (const line of cleanLines(text)) {
    if (/^\[SYS\/PENDIENTES\]/i.test(line) || /^---/.test(line)) continue;
    preview.pendientes.push(line);
  }
}

export async function buildPreview(
  client: IntervalsClient,
  today: string,
): Promise<ImportPreview> {
  const preview: ImportPreview = {
    version: null,
    reglas: [],
    disparadores: [],
    estado: [],
    pendientes: [],
    logs: [],
    condiciones: [],
    carreras: [],
    noInterpretado: [],
    crudos: [],
  };

  // 1) Zona de sistema 2099.
  const sysEvents = await client.events("2099-01-01", "2099-01-31");
  for (const event of sysEvents) {
    const name = String(event.name ?? "");
    const body = String(event.description ?? "").trim();
    const fecha = String(event.start_date_local ?? "").slice(0, 10);
    if (!body) continue;
    preview.crudos.push({ nota: name || fecha, fecha, texto: body });
    const upperName = name.toUpperCase();
    const full = `${upperName}\n${body.toUpperCase()}`;
    if (upperName.includes("[SYS/CONTRATO]") || full.includes("[SYS/CONTRATO]")) {
      parseContratoNote(body, preview);
    } else if (upperName.includes("[SYS/ESTADO]") || full.includes("[SYS/ESTADO]")) {
      parseEstadoNote(body, preview);
    } else if (upperName.includes("[SYS/PENDIENTES]") || full.includes("[SYS/PENDIENTES]")) {
      parsePendientesNote(body, preview);
    }
    // [SYS/LOG] es un índice reconstruible: queda en `crudos` para auditoría.
  }

  // 2) Zona real: [LOG] y [NOTA] de los últimos 365 días, [REVISAR] y carreras futuras.
  const yearAgo = (() => {
    const [y, m, d] = today.split("-").map(Number);
    return new Date(Date.UTC(y! - 1, m! - 1, d!)).toISOString().slice(0, 10);
  })();
  const yearAhead = (() => {
    const [y, m, d] = today.split("-").map(Number);
    return new Date(Date.UTC(y! + 1, m! - 1, d!)).toISOString().slice(0, 10);
  })();
  const realEvents = await client.events(yearAgo, yearAhead);

  for (const event of realEvents) {
    const name = String(event.name ?? "");
    const upper = name.toUpperCase();
    const body = String(event.description ?? "").trim();
    const fecha = String(event.start_date_local ?? "").slice(0, 10);
    const category = String(event.category ?? "");

    if (category.startsWith("RACE")) {
      preview.carreras.push({
        nombre: name || "Carrera",
        fecha: fecha || null,
        prioridad: category.replace("RACE_", "") || null,
        eventId: String(event.id ?? ""),
      });
      continue;
    }
    if (category !== "NOTE") continue;

    const texto = body || name;
    if (upper.includes("[LOG]")) {
      preview.logs.push({ fecha, texto });
    } else if (upper.includes("[REVISAR]")) {
      const match = TRIGGER_RE.exec(texto.split("\n")[0] ?? "");
      preview.disparadores.push({
        fecha: match?.[1] ?? fecha,
        accion: (match?.[2] ?? texto.replace(/\[REVISAR\]/i, "").trim()).trim() || name,
      });
    } else if (upper.includes("[NOTA]")) {
      preview.condiciones.push({ desde: fecha, texto });
    }
  }

  // Dedupe de disparadores idénticos (pueden venir del snapshot Y de [REVISAR]).
  const seen = new Set<string>();
  preview.disparadores = preview.disparadores.filter((d) => {
    const key = `${d.fecha}|${d.accion}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  preview.logs.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return preview;
}

export interface ApplyOptions {
  incluirLogs: boolean;
  incluirCondiciones: boolean;
  incluirCarreras: boolean;
}

/**
 * Aplica la vista previa a D1. Los [LOG] históricos se insertan como entradas
 * de log (append-only, sin versión); el resto entra en un único commit.
 */
export async function applyImport(
  store: ContractStore,
  preview: ImportPreview,
  opts: ApplyOptions,
): Promise<{ version: number; resumen: string[] }> {
  // 0) La numeración de versiones continúa la del snapshot antiguo (v10 → v11).
  if (preview.version) {
    await store.ensureVersionFloor(preview.version);
  }

  // 1) Log histórico primero, en orden cronológico, sin bump de versión por entrada.
  if (opts.incluirLogs) {
    for (const entry of preview.logs) {
      await store.appendHistoricalLog(entry.fecha, entry.texto);
    }
  }

  // 2) Todo lo estructural en un commit atómico.
  const input: CommitInput = {
    mensaje:
      `Importación desde intervals.icu (zona 2099 + notas). ` +
      `Versión previa del snapshot: v${preview.version ?? "?"}. ` +
      `A partir de aquí la app es la fuente de verdad.`,
    reglas: preview.reglas.map((regla) => ({
      accion: "crear" as const,
      id: regla.id,
      tema: regla.tema,
      contenido: regla.contenido,
      vence: regla.vence,
    })),
    estado: Object.fromEntries(preview.estado.map((e) => [e.clave, e.valor])),
    pendientes: preview.pendientes.map((texto) => ({ accion: "añadir" as const, texto })),
    disparadores: preview.disparadores.map((d) => ({
      accion: "añadir" as const,
      fecha: d.fecha,
      accion_texto: d.accion,
    })),
    condiciones: opts.incluirCondiciones
      ? preview.condiciones.map((c) => ({
          accion: "añadir" as const,
          texto: c.texto,
          desde: c.desde,
        }))
      : [],
    carreras: opts.incluirCarreras
      ? preview.carreras.map((c) => ({
          accion: "añadir" as const,
          nombre: c.nombre,
          fecha: c.fecha,
          prioridad: c.prioridad,
          estado: "confirmada",
          notas: `importada de intervals (evento ${c.eventId})`,
        }))
      : [],
  };

  return store.commit(input);
}
