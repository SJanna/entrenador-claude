/**
 * Bindings del Worker y configuración derivada por petición.
 * Todo lo sensible llega como secreto de Cloudflare, nunca en el código.
 */

export interface Env {
  DB: D1Database;

  /**
   * Lo que lee la página pública: UN JSON ya filtrado (src/publico/). Opcional
   * para que el Worker no se caiga si aún no se ha creado el namespace; sin él
   * el cron calcula y guarda en D1, pero no publica.
   */
  PUBLICO?: KVNamespace;

  /** Identidad del despliegue vivo (wrangler.jsonc → version_metadata). */
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };

  // Secretos (wrangler secret put …)
  INTERVALS_API_KEY: string;
  MCP_SECRET_PATH: string;
  APP_PASSWORD: string;
  SESSION_SECRET: string;

  /**
   * "no" = el entrenador (MCP) no ve intervals.icu aunque esté configurado: ni
   * sus herramientas ni comparaciones. El panel y la página pública lo siguen
   * usando mientras no estén portados al histórico de Garmin.
   */
  INTERVALS_EN_ENTRENADOR?: string;
  /** Llamadas a Garmin por ejecución del cron del histórico (por defecto 18). */
  HISTORICO_PRESUPUESTO?: string;

  // Vars (wrangler.jsonc → vars)
  INTERVALS_ATHLETE_ID: string;
  INTERVALS_TZ?: string;
  INTERVALS_BASE_URL?: string;

  // Ajuste fino de campos de bienestar no documentados por la API.
  INTERVALS_FIELD_BODY_BATTERY?: string;
  INTERVALS_FIELD_READINESS?: string;
  INTERVALS_FIELD_SLEEP_DEEP?: string;
  INTERVALS_FIELD_SLEEP_LIGHT?: string;
  INTERVALS_FIELD_SLEEP_REM?: string;
  INTERVALS_FIELD_SLEEP_AWAKE?: string;
}

export class ConfigError extends Error {}

export interface AppConfig {
  /**
   * ¿Hay intervals.icu? Garmin es la fuente principal y el contrato vive en D1:
   * un atleta sin cuenta de intervals tiene un entrenador completo, solo le
   * faltan el histórico largo, CTL/ATL/TSB y el calendario de intervals.
   */
  intervals: boolean;
  apiKey: string;
  athleteId: string;
  baseUrl: string;
  tzName: string;
  fieldOverrides: Record<string, string>;
  /** Fecha de "hoy" (YYYY-MM-DD) en la zona horaria del atleta. */
  today(): string;
}

/** intervals.icu usa ids tipo `i123456`; aceptamos también el número suelto. */
export function normalizeAthleteId(raw: string): string {
  const value = (raw || "").trim();
  return /^\d+$/.test(value) ? `i${value}` : value;
}

/** YYYY-MM-DD de "ahora" en una zona horaria concreta (Intl, sin dependencias). */
export function todayInTz(tzName: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tzName,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** La configuración que ve el entrenador: sin intervals si así se pidió. */
export function configParaEntrenador(env: Env): AppConfig {
  const config = configFromEnv(env);
  return (env.INTERVALS_EN_ENTRENADOR || "").trim().toLowerCase() === "no"
    ? { ...config, intervals: false }
    : config;
}

export function configFromEnv(env: Env): AppConfig {
  // intervals.icu es opcional, pero a medias es un error: con una sola de las
  // dos piezas el atleta cree que lo tiene y cada lectura fallaría en silencio.
  const apiKey = (env.INTERVALS_API_KEY || "").trim();
  const athleteId = normalizeAthleteId(env.INTERVALS_ATHLETE_ID || "");
  if (apiKey && !athleteId) {
    throw new ConfigError(
      "Hay INTERVALS_API_KEY pero falta INTERVALS_ATHLETE_ID (formato i123456) en las " +
        "vars de wrangler.jsonc. Pon las dos, o quita la clave para funcionar solo con Garmin.",
    );
  }
  if (athleteId && !apiKey) {
    throw new ConfigError(
      "Hay INTERVALS_ATHLETE_ID pero falta el secreto INTERVALS_API_KEY " +
        "(`npx wrangler secret put INTERVALS_API_KEY`). Pon los dos, o quita el id " +
        "para funcionar solo con Garmin.",
    );
  }

  const overrides: Record<string, string> = {};
  const pairs: Array<[string, string | undefined]> = [
    ["body_battery", env.INTERVALS_FIELD_BODY_BATTERY],
    ["readiness", env.INTERVALS_FIELD_READINESS],
    ["sleep_deep", env.INTERVALS_FIELD_SLEEP_DEEP],
    ["sleep_light", env.INTERVALS_FIELD_SLEEP_LIGHT],
    ["sleep_rem", env.INTERVALS_FIELD_SLEEP_REM],
    ["sleep_awake", env.INTERVALS_FIELD_SLEEP_AWAKE],
  ];
  for (const [key, value] of pairs) {
    const clean = (value || "").trim();
    if (clean) overrides[key] = clean;
  }

  const tzName = (env.INTERVALS_TZ || "").trim() || "UTC";
  return {
    intervals: Boolean(apiKey && athleteId),
    apiKey,
    athleteId,
    baseUrl: (env.INTERVALS_BASE_URL || "").trim() || "https://intervals.icu/api/v1",
    tzName,
    fieldOverrides: overrides,
    today: () => todayInTz(tzName),
  };
}

/** Comparación en tiempo constante para secretos en URLs y contraseñas. */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  const length = Math.max(bufA.length, bufB.length, 1);
  let diff = bufA.length === bufB.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    diff |= (bufA[i % bufA.length] ?? 0) ^ (bufB[i % bufB.length] ?? 0);
  }
  return diff === 0;
}
