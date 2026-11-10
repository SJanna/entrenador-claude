/**
 * Cliente HTTP de intervals.icu: Basic auth, timeouts y un reintento.
 * Todo error de red o de la API se convierte en `IntervalsError` con un mensaje
 * legible en español. Port fiel de client.py sobre fetch de Workers.
 */

import { ConfigError, type AppConfig } from "../env";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_SLEEP_MS = 10_000;
const RETRY_BACKOFF_MS = 2_000;
const REQUEST_TIMEOUT_MS = 60_000;

export class IntervalsError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

type Json = unknown;
export type JsonRecord = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class IntervalsClient {
  constructor(private config: AppConfig) {
    if (!config.intervals) {
      throw new ConfigError(
        "intervals.icu no está configurado en esta instalación (funciona solo con Garmin). " +
          "Para activarlo: INTERVALS_ATHLETE_ID en wrangler.jsonc y " +
          "`npx wrangler secret put INTERVALS_API_KEY`.",
      );
    }
  }

  private authHeader(): string {
    return "Basic " + btoa(`API_KEY:${this.config.apiKey}`);
  }

  async request(
    method: string,
    path: string,
    opts: { params?: Record<string, unknown>; json?: Json; what?: string } = {},
  ): Promise<Json> {
    const what = opts.what || "el recurso";
    const url = new URL(this.config.baseUrl.replace(/\/$/, "") + path);
    for (const [key, value] of Object.entries(opts.params || {})) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }

    const init: RequestInit = {
      method,
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        ...(opts.json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    };

    let lastError: string | null = null;
    for (const attempt of [1, 2]) {
      let response: Response | null = null;
      try {
        response = await fetch(url.toString(), {
          ...init,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (exc) {
        const isTimeout = exc instanceof DOMException && exc.name === "TimeoutError";
        lastError = isTimeout
          ? `intervals.icu no respondió a tiempo al pedir ${what} (límite ${REQUEST_TIMEOUT_MS / 1000} s).`
          : `No se pudo conectar con intervals.icu al pedir ${what}: ${String(exc)}.`;
      }

      if (response) {
        if (RETRYABLE_STATUS.has(response.status) && attempt === 1) {
          await sleep(this.retryDelayMs(response));
          continue;
        }
        return await this.handle(response, what);
      }

      if (attempt === 1) await sleep(RETRY_BACKOFF_MS);
    }

    throw new IntervalsError(`${lastError} Se reintentó una vez sin éxito.`);
  }

  private retryDelayMs(response: Response): number {
    const retryAfter = parseFloat(response.headers.get("Retry-After") || "");
    if (Number.isFinite(retryAfter)) return Math.min(retryAfter * 1000, MAX_RETRY_SLEEP_MS);
    return RETRY_BACKOFF_MS;
  }

  private async handle(response: Response, what: string): Promise<Json> {
    const status = response.status;
    const athlete = this.config.athleteId;

    if (status === 401) {
      throw new IntervalsError(
        "intervals.icu rechazó las credenciales (HTTP 401). Revisa el secreto " +
          "INTERVALS_API_KEY: debe ser la clave de Settings → Developer Settings, " +
          "usada como contraseña con el usuario 'API_KEY'.",
        status,
      );
    }
    if (status === 403) {
      throw new IntervalsError(
        `Sin permiso para ${what} (HTTP 403). La clave es válida pero no da acceso ` +
          `al atleta ${athlete}; comprueba INTERVALS_ATHLETE_ID.`,
        status,
      );
    }
    if (status === 404) {
      throw new IntervalsError(
        `No existe ${what} (HTTP 404). Si es el atleta, revisa que ` +
          `INTERVALS_ATHLETE_ID (${athlete}) sea correcto.`,
        status,
      );
    }
    if (status === 422) {
      throw new IntervalsError(
        `intervals.icu no aceptó los datos enviados para ${what} (HTTP 422): ` +
          `${await this.snippet(response)}`,
        status,
      );
    }
    if (status === 429) {
      throw new IntervalsError(
        "Límite de peticiones de intervals.icu alcanzado (HTTP 429). Espera un " +
          "minuto y vuelve a pedirlo, o reduce el rango de días.",
        status,
      );
    }
    if (status >= 500 && status < 600) {
      throw new IntervalsError(
        `intervals.icu está fallando ahora mismo (HTTP ${status}) al pedir ${what}. ` +
          "Inténtalo de nuevo en unos minutos.",
        status,
      );
    }
    if (status >= 400) {
      throw new IntervalsError(
        `Error HTTP ${status} al pedir ${what}: ${await this.snippet(response)}`,
        status,
      );
    }

    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new IntervalsError(
        `intervals.icu devolvió una respuesta que no es JSON al pedir ${what}: ` +
          `${text.trim().replaceAll("\n", " ").slice(0, 300)}`,
      );
    }
  }

  private async snippet(response: Response, limit = 300): Promise<string> {
    const text = ((await response.text()) || "").trim().replaceAll("\n", " ");
    if (!text) return "(sin cuerpo de respuesta)";
    return text.slice(0, limit) + (text.length > limit ? "…" : "");
  }

  // --- Endpoints usados (API v1) ---

  async wellness(oldest: string, newest: string): Promise<JsonRecord[]> {
    const data = await this.request("GET", `/athlete/${this.config.athleteId}/wellness`, {
      params: { oldest, newest },
      what: "los datos de bienestar",
    });
    return Array.isArray(data) ? (data as JsonRecord[]) : [];
  }

  /**
   * Actividades del rango. `fields` recorta la respuesta a esas columnas: pedir
   * solo lo necesario es lo que hace viable barrer años de historial en una
   * sola petición (get_records).
   */
  async activities(
    oldest: string,
    newest: string,
    limit = 200,
    fields?: string[],
  ): Promise<JsonRecord[]> {
    const data = await this.request("GET", `/athlete/${this.config.athleteId}/activities`, {
      params: {
        oldest,
        newest,
        limit,
        fields: fields && fields.length ? fields.join(",") : null,
      },
      what: "la lista de actividades",
    });
    return Array.isArray(data) ? (data as JsonRecord[]) : [];
  }

  async activityHrCurves(
    oldest: string,
    newest: string,
    secs: number[],
    sport?: string | null,
  ): Promise<JsonRecord> {
    const data = await this.request(
      "GET",
      `/athlete/${this.config.athleteId}/activity-hr-curves`,
      {
        params: {
          oldest,
          newest,
          secs: secs.map((s) => String(Math.trunc(s))).join(","),
          type: sport ?? null,
        },
        what: "las curvas de frecuencia cardiaca",
      },
    );
    return data && typeof data === "object" && !Array.isArray(data) ? (data as JsonRecord) : {};
  }

  async activityPaceCurves(
    oldest: string,
    newest: string,
    distances: number[],
    opts: { gap?: boolean; sport?: string | null } = {},
  ): Promise<JsonRecord> {
    const data = await this.request(
      "GET",
      `/athlete/${this.config.athleteId}/activity-pace-curves`,
      {
        params: {
          oldest,
          newest,
          distances: distances.map((d) => String(d)).join(","),
          gap: opts.gap ?? false,
          type: opts.sport ?? null,
        },
        what:
          "las curvas de ritmo" + (opts.gap ? " ajustado por pendiente (GAP)" : ""),
      },
    );
    return data && typeof data === "object" && !Array.isArray(data) ? (data as JsonRecord) : {};
  }

  async activity(activityId: string): Promise<JsonRecord> {
    const data = await this.request("GET", `/activity/${activityId}`, {
      what: `la actividad ${activityId}`,
    });
    return data && typeof data === "object" && !Array.isArray(data) ? (data as JsonRecord) : {};
  }

  async activityIntervals(activityId: string): Promise<JsonRecord[]> {
    const data = await this.request("GET", `/activity/${activityId}/intervals`, {
      what: `los intervalos de la actividad ${activityId}`,
    });
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const record = data as JsonRecord;
      const intervals = record.icu_intervals ?? record.intervals ?? [];
      return Array.isArray(intervals) ? (intervals as JsonRecord[]) : [];
    }
    return Array.isArray(data) ? (data as JsonRecord[]) : [];
  }

  /**
   * Series punto a punto. `types` va como lista separada por comas y sin
   * `includeDefaults`: pedir solo lo que se va a leer mantiene la respuesta
   * pequeña, que en una tirada larga es la diferencia entre 60 KB y medio mega.
   */
  async activityStreams(activityId: string, types: string[]): Promise<unknown> {
    return this.request("GET", `/activity/${activityId}/streams`, {
      params: { types: types.join(","), includeDefaults: false },
      what: `las series de la actividad ${activityId}`,
    });
  }

  async events(oldest: string, newest: string): Promise<JsonRecord[]> {
    const data = await this.request("GET", `/athlete/${this.config.athleteId}/events`, {
      params: { oldest, newest },
      what: "el calendario",
    });
    return Array.isArray(data) ? (data as JsonRecord[]) : [];
  }

  async event(eventId: string | number): Promise<JsonRecord> {
    const data = await this.request(
      "GET",
      `/athlete/${this.config.athleteId}/events/${eventId}`,
      { what: `el evento ${eventId} del calendario` },
    );
    return data && typeof data === "object" && !Array.isArray(data) ? (data as JsonRecord) : {};
  }

  async createEvent(payload: JsonRecord): Promise<JsonRecord> {
    const data = await this.request("POST", `/athlete/${this.config.athleteId}/events`, {
      json: payload,
      what: "la creación del evento en el calendario",
    });
    return data && typeof data === "object" && !Array.isArray(data) ? (data as JsonRecord) : {};
  }

  async updateEvent(eventId: string | number, payload: JsonRecord): Promise<JsonRecord> {
    const data = await this.request(
      "PUT",
      `/athlete/${this.config.athleteId}/events/${eventId}`,
      { json: payload, what: `la actualización del evento ${eventId}` },
    );
    return data && typeof data === "object" && !Array.isArray(data) ? (data as JsonRecord) : {};
  }

  async deleteEvent(eventId: string | number): Promise<void> {
    await this.request("DELETE", `/athlete/${this.config.athleteId}/events/${eventId}`, {
      what: `el borrado del evento ${eventId}`,
    });
  }

  /** Crea o actualiza el bienestar de un día. El cuerpo es parcial: solo lo que cambia. */
  async updateWellness(date: string, payload: JsonRecord): Promise<JsonRecord> {
    const data = await this.request(
      "PUT",
      `/athlete/${this.config.athleteId}/wellness/${date}`,
      { json: payload, what: `el bienestar del ${date}` },
    );
    return data && typeof data === "object" && !Array.isArray(data) ? (data as JsonRecord) : {};
  }

  async athleteProfile(): Promise<JsonRecord> {
    const data = await this.request("GET", `/athlete/${this.config.athleteId}`, {
      what: "el perfil del atleta",
    });
    return data && typeof data === "object" && !Array.isArray(data) ? (data as JsonRecord) : {};
  }

  async sportSettings(): Promise<JsonRecord[]> {
    const data = await this.request("GET", `/athlete/${this.config.athleteId}/sport-settings`, {
      what: "los ajustes por deporte",
    });
    return Array.isArray(data) ? (data as JsonRecord[]) : [];
  }

  async updateSportSettings(settingsId: string | number, payload: JsonRecord): Promise<JsonRecord> {
    const data = await this.request(
      "PUT",
      `/athlete/${this.config.athleteId}/sport-settings/${settingsId}`,
      { json: payload, what: `los ajustes de deporte ${settingsId}` },
    );
    return data && typeof data === "object" && !Array.isArray(data) ? (data as JsonRecord) : {};
  }
}
