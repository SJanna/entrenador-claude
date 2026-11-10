/**
 * Formato compacto y métrico: texto tabulado en vez de JSON crudo.
 * Cada fila cabe en una línea y los ausentes son "—", para que un LLM lea el
 * periodo entero sin gastar contexto. Port fiel de format.py.
 */

export const DASH = "—";

// Deportes a pie (ritmo min/km) y de natación (ritmo min/100 m); el resto va en km/h.
const FOOT_SPORTS = new Set([
  "run",
  "virtualrun",
  "trailrun",
  "walk",
  "hike",
  "treadmill",
  "indoorrun",
]);
const SWIM_SPORTS = new Set(["swim", "openwaterswim", "pool_swim", "poolswim"]);

export function isFoot(sport: string | null | undefined): boolean {
  return FOOT_SPORTS.has((sport || "").toLowerCase().replaceAll(" ", ""));
}

export function isSwim(sport: string | null | undefined): boolean {
  return SWIM_SPORTS.has((sport || "").toLowerCase().replaceAll(" ", ""));
}

function asFinite(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(num) ? num : null;
}

/** Número redondeado, o "—" si no hay dato. */
export function num(value: unknown, digits = 0, suffix = ""): string {
  const val = asFinite(value);
  if (val === null) return DASH;
  const text = digits ? val.toFixed(digits) : Math.round(val).toFixed(0);
  return `${text}${suffix}`;
}

/** Segundos → h:mm:ss (o mm:ss si dura menos de una hora). */
export function duration(seconds: unknown, opts: { forceHours?: boolean } = {}): string {
  const val = asFinite(seconds);
  if (val === null) return DASH;
  const total = Math.round(val);
  if (total < 0) return DASH;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours || opts.forceHours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** Segundos → h:mm (para sueño y volúmenes semanales). */
export function hoursMinutes(seconds: unknown): string {
  const val = asFinite(seconds);
  if (val === null) return DASH;
  const total = Math.round(val);
  if (total <= 0) return DASH;
  const totalMinutes = Math.floor(total / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

export function km(meters: unknown, digits = 1): string {
  const val = asFinite(meters);
  if (val === null || val <= 0) return DASH;
  return `${(val / 1000).toFixed(digits)}km`;
}

export function elevation(meters: unknown): string {
  const val = asFinite(meters);
  if (val === null || val <= 0) return DASH;
  return `+${Math.round(val)}m`;
}

/** m/s → ritmo métrico: min/km a pie, min/100 m nadando, km/h en el resto. */
export function pace(speedMps: unknown, sport?: string | null): string {
  const speed = asFinite(speedMps);
  if (speed === null || speed <= 0) return DASH;

  if (isSwim(sport)) {
    const secs = Math.round(100.0 / speed);
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}/100m`;
  }
  if (isFoot(sport)) {
    const secs = 1000.0 / speed;
    if (secs > 3600) return DASH;
    const rounded = Math.round(secs);
    return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}/km`;
  }
  return `${(speed * 3.6).toFixed(1)}km/h`;
}

/** Tiempo y distancia de una marca → ritmo, sin pasar por m/s en el llamante. */
export function paceFromTime(seconds: unknown, meters: unknown, sport?: string | null): string {
  const secs = asFinite(seconds);
  const dist = asFinite(meters);
  if (secs === null || dist === null || secs <= 0 || dist <= 0) return DASH;
  return pace(dist / secs, sport);
}

/** Fecha ISO (con o sin hora) → YYYY-MM-DD. */
export function dateShort(value: unknown): string {
  if (!value) return DASH;
  return String(value).slice(0, 10);
}

export function clip(text: unknown, limit: number): string {
  if (text === null || text === undefined) return "";
  const value = String(text).split(/\s+/).join(" ").trim();
  if (value.length <= limit) return value;
  return value.slice(0, limit - 1) + "…";
}

type Record_ = Record<string, unknown>;

/** Primer valor no nulo entre `keys`; tolera variantes de mayúsculas/guiones. */
export function firstPresent(record: Record_, keys: Iterable<string>): unknown {
  for (const key of keys) {
    if (key in record && record[key] !== null && record[key] !== undefined) {
      return record[key];
    }
  }
  const normalized: Record_ = {};
  for (const [k, v] of Object.entries(record)) {
    normalized[k.toLowerCase().replaceAll("_", "")] = v;
  }
  for (const key of keys) {
    const candidate = normalized[key.toLowerCase().replaceAll("_", "")];
    if (candidate !== null && candidate !== undefined) return candidate;
  }
  return null;
}

/** Tabla de ancho fijo con dos espacios de separación y sin relleno final. */
export function table(headers: string[], rows: string[][], align?: string[]): string {
  if (!rows.length) return "";
  const columns = headers.length;
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    for (let i = 0; i < columns; i++) {
      const cell = row[i] ?? "";
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    }
  }
  const alignment = [...(align || [])];
  while (alignment.length < columns) alignment.push("l");

  const render = (cells: string[]): string => {
    const out: string[] = [];
    for (let i = 0; i < columns; i++) {
      const cell = cells[i] ?? "";
      const width = widths[i] ?? 0;
      out.push(alignment[i] === "r" ? cell.padStart(width) : cell.padEnd(width));
    }
    return out.join("  ").replace(/\s+$/, "");
  };

  return [render(headers), ...rows.map(render)].join("\n");
}

function asInt(value: unknown): number | null {
  const val = asFinite(value);
  return val === null ? null : Math.round(val);
}

/** Normaliza los distintos formatos de tiempo en zonas a [etiqueta, segundos]. */
export function zoneTimes(value: unknown): Array<[string, number]> {
  const result: Array<[string, number]> = [];
  if (!value) return result;

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const obj = item as Record_;
        const label = obj.id ?? obj.zone ?? obj.name ?? `Z${index + 1}`;
        const secs = asInt(obj.secs ?? obj.seconds ?? obj.time ?? obj.value);
        if (secs !== null) result.push([String(label), secs]);
      } else {
        const secs = asInt(item);
        if (secs !== null) result.push([`Z${index + 1}`, secs]);
      }
    });
    return result;
  }

  if (typeof value === "object") {
    for (const [key, secs] of Object.entries(value as Record_)) {
      const seconds = asInt(secs);
      if (seconds !== null) result.push([key, seconds]);
    }
  }
  return result;
}

/** Una línea "Zonas FC: Z1 12:00 · Z2 32:10 …" o null si no hay datos. */
export function zonesLine(label: string, value: unknown): string | null {
  const zones = zoneTimes(value).filter(([, secs]) => secs > 0);
  if (!zones.length) return null;
  return `${label}: ` + zones.map(([name, secs]) => `${name} ${duration(secs)}`).join(" · ");
}
