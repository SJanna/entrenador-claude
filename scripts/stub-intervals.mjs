/**
 * API falsa de intervals.icu para probar el Worker sin tocar la cuenta real.
 * Port del stub_intervals.py del proyecto original: mismas rutas, Basic auth
 * y códigos de error (401, 404, 429), más la zona 2099 con notas [SYS/*].
 *
 * Uso:  node scripts/stub-intervals.mjs [puerto]   (por defecto 8999)
 */

import http from "node:http";

const PORT = parseInt(process.argv[2] || "8999", 10);
const VALID_KEY = "clave-de-prueba";
const VALID_ATHLETE = "i1";

function hoyIso(offsetDias = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDias);
  return d.toISOString().slice(0, 10);
}

function authOk(req) {
  const header = req.headers.authorization || "";
  if (!header.toLowerCase().startsWith("basic ")) return false;
  try {
    const decoded = Buffer.from(header.split(" ")[1], "base64").toString();
    const idx = decoded.indexOf(":");
    return decoded.slice(0, idx) === "API_KEY" && decoded.slice(idx + 1) === VALID_KEY;
  } catch {
    return false;
  }
}

function actividad(offset, deporte, fecha) {
  return {
    id: `i${1000 + offset}`,
    start_date_local: `${fecha}T07:${String(30 + (offset % 20)).padStart(2, "0")}:00`,
    name: `Sesión de ${deporte} ${offset}`,
    type: deporte,
    moving_time: 2400 + offset * 120,
    elapsed_time: 2500 + offset * 120,
    distance: 8000 + offset * 900,
    total_elevation_gain: 60 + offset * 12,
    average_heartrate: 138 + (offset % 12),
    max_heartrate: 165 + (offset % 10),
    average_speed: 3.2 + (offset % 5) * 0.1,
    gap: 3.35 + (offset % 5) * 0.1,
    icu_training_load: 55 + offset * 3,
    icu_rpe: 4 + (offset % 3),
  };
}

// Bienestar escrito por set_wellness, y los campos que "existen" en la cuenta:
// cualquier otro se descarta en silencio, igual que hace intervals.icu con un
// campo personalizado que no está definido.
const bienestarEscrito = new Map();
const CAMPOS_BIENESTAR_CONOCIDOS = new Set([
  "fatigue", "stress", "mood", "motivation", "soreness", "injury", "sleepQuality",
  "comments", "dolor_tobillo",
]);

// Estado mutable de eventos (misma semilla que el stub original + zona 2099 rica).
const store = new Map();
let nextId = 900000;
function seed() {
  store.set(1, {
    id: 1,
    start_date_local: `${hoyIso(0)}T00:00:00`,
    category: "WORKOUT",
    type: "Run",
    name: "Series 5x1000",
    description: "Series 5x\n- 1km 105%",
    moving_time: 3600,
    icu_training_load: 78,
    workout_doc: { steps: [{ a: 1 }, { b: 2 }] },
  });
  store.set(2, {
    id: 2,
    start_date_local: `${hoyIso(3)}T00:00:00`,
    category: "NOTE",
    name: "[NOTA] Viaje",
    description: "[NOTA] Tres días fuera, solo carrera suave.",
  });
  store.set(3, {
    id: 3,
    start_date_local: "2099-01-01T00:00:00",
    category: "NOTE",
    name: "[SYS/CONTRATO] v7",
    description:
      "[SYS/CONTRATO] v7 · 2026-08-01\n" +
      "R001 fuerza-ubicación | vence nunca | Toda sesión de fuerza lleva (parque) o (casa) en el título\n" +
      "R018 carrera-sustituye | vence 2026-11-30 | Una carrera dura sustituye el día de calidad de su semana\n" +
      "--- DISPARADORES ---\n" +
      "2026-08-15 → Recordatorio inscripción Corre con Un Norte",
  });
  store.set(4, {
    id: 4,
    start_date_local: "2099-01-02T00:00:00",
    category: "NOTE",
    name: "[SYS/ESTADO] v7",
    description: "[SYS/ESTADO] v7\nnivel_tobillo: 1\nbloque: base con calidad\nLTHR: 193 (provisional)",
  });
  store.set(5, {
    id: 5,
    start_date_local: "2099-01-03T00:00:00",
    category: "NOTE",
    name: "[SYS/PENDIENTES]",
    description: "[SYS/PENDIENTES]\n- Retest LTHR con banda corregida\n- Reconfigurar zonas tras retest",
  });
  store.set(6, {
    id: 6,
    start_date_local: `${hoyIso(-10)}T00:00:00`,
    category: "NOTE",
    name: "[LOG] acuerdo de prueba",
    description: "[LOG] Se acordó la regla R018 (carrera sustituye calidad).",
  });
  store.set(7, {
    id: 7,
    start_date_local: hoyIso(112) <= "2026-11-29" ? "2026-11-29T00:00:00" : `${hoyIso(112)}T00:00:00`,
    category: "RACE_A",
    type: "Run",
    name: "Trail de la Sierra",
    description: "25.5K +1299m",
  });
}
seed();

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(text);
}

async function cuerpo(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (!authOk(req)) return json(res, 401, { error: "Unauthorized" });

  let match;

  // PUT /api/v1/athlete/{a}/wellness/{fecha} — cuerpo parcial. Como intervals.icu,
  // solo guarda los campos que conoce: lo demás se descarta sin avisar.
  if ((match = path.match(/^\/api\/v1\/athlete\/([^/]+)\/wellness\/(\d{4}-\d{2}-\d{2})$/))) {
    if (match[1] !== VALID_ATHLETE) return json(res, 404, { error: "Athlete not found" });
    const fecha = match[2];
    const guardado = bienestarEscrito.get(fecha) || { id: fecha, ctl: 51.0, atl: 44.0 };
    if (req.method === "PUT") {
      const payload = await cuerpo(req);
      for (const [clave, valor] of Object.entries(payload)) {
        if (CAMPOS_BIENESTAR_CONOCIDOS.has(clave)) guardado[clave] = valor;
      }
      bienestarEscrito.set(fecha, guardado);
    }
    return json(res, 200, guardado);
  }

  // /api/v1/athlete/{a}/wellness
  if ((match = path.match(/^\/api\/v1\/athlete\/([^/]+)\/wellness$/))) {
    if (match[1] !== VALID_ATHLETE) return json(res, 404, { error: "Athlete not found" });
    const oldest = url.searchParams.get("oldest");
    const newest = url.searchParams.get("newest");
    const out = [];
    let day = oldest;
    let index = 0;
    while (day <= newest && index < 400) {
      index += 1;
      if (bienestarEscrito.has(day)) {
        out.push(bienestarEscrito.get(day));
      } else if (index === 2) {
        out.push({ id: day, ctl: 51.0, atl: 44.0 });
      } else {
        out.push({
          id: day,
          ctl: 50.0 + index * 0.4,
          atl: 43.0 + index * 0.9,
          weight: 81.4 - index * 0.05,
          restingHR: 47 + (index % 3),
          hrv: 66 + (index % 7),
          sleepSecs: 25200 + (index % 4) * 900,
          sleepScore: 78 + (index % 10),
          deepSleepSecs: 4200 + index * 30,
          lightSleepSecs: 15600,
          remSleepSecs: 5400,
          awakeSecs: 600,
          bodyBattery: 70 + (index % 20),
          readiness: 60 + (index % 25),
          steps: 9000 + index * 120,
        });
      }
      const p = day.split("-").map(Number);
      day = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1)).toISOString().slice(0, 10);
    }
    return json(res, 200, out);
  }

  // /api/v1/athlete/{a}/activities
  if ((match = path.match(/^\/api\/v1\/athlete\/([^/]+)\/activities$/))) {
    if (match[1] !== VALID_ATHLETE) return json(res, 404, { error: "Athlete not found" });
    const oldest = url.searchParams.get("oldest");
    const newest = url.searchParams.get("newest");
    const out = [];
    let day = newest;
    let offset = 0;
    while (day >= oldest && offset < 40) {
      const p = day.split("-").map(Number);
      const weekday = (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7;
      if ([0, 2, 4, 6].includes(weekday)) {
        out.push(actividad(offset, weekday !== 4 ? "Run" : "Ride", day));
        offset += 1;
      }
      day = new Date(Date.UTC(p[0], p[1] - 1, p[2] - 1)).toISOString().slice(0, 10);
    }
    return json(res, 200, out);
  }

  // Curvas por actividad: cada curva es una actividad y cada valor un punto del
  // eje (secs para FC, distances para ritmo), que es como las sirve intervals.
  if ((match = path.match(/^\/api\/v1\/athlete\/([^/]+)\/activity-(hr|pace)-curves$/))) {
    if (match[1] !== VALID_ATHLETE) return json(res, 404, { error: "Athlete not found" });
    const esFc = match[2] === "hr";
    const gap = url.searchParams.get("gap") === "true";
    const eje = (esFc ? url.searchParams.get("secs") : url.searchParams.get("distances") || "")
      .split(",")
      .filter(Boolean)
      .map(Number);
    const curva = (id, fecha, factor) => ({
      id,
      start_date_local: `${fecha}T06:00:00`,
      // FC: más ppm cuanto más corta la duración. Ritmo: segundos por distancia,
      // con el GAP un pelín más lento para que se distinga del ritmo llano.
      [esFc ? "bpm" : "secs"]: eje.map((punto) =>
        esFc
          ? Math.round(196 - Math.log10(punto) * factor)
          : punto > 12000 ? null : Math.round((punto / 3.2) * factor * (gap ? 1.02 : 1)),
      ),
    });
    return json(res, 200, {
      [esFc ? "secs" : "distances"]: eje,
      curves: [
        curva("i1001", hoyIso(-2), esFc ? 8 : 1.0),
        curva("i1002", hoyIso(-9), esFc ? 9 : 1.05),
      ],
    });
  }

  // /api/v1/activity/{id}(/intervals)
  if ((match = path.match(/^\/api\/v1\/activity\/([^/]+)$/))) {
    const id = match[1];
    if (id === "i429") return json(res, 429, { error: "Too many requests" });
    if (!id.startsWith("i10")) return json(res, 404, { error: "Not found" });
    const data = actividad(1, "Run", hoyIso(0));
    Object.assign(data, {
      id,
      description: "Rodaje con 4 progresivos al final.",
      lthr: 165,
      icu_ftp: 285,
      icu_intensity: 0.74,
      calories: 690,
      average_cadence: 172,
      icu_hr_zone_times: [900, 1500, 600, 240, 60],
      pace_zone_times: [{ id: "Z1", secs: 1200 }, { id: "Z2", secs: 1800 }],
      decoupling: 4.2,
      icu_efficiency_factor: 1.83,
      has_weather: true,
      average_weather_temp: 29.4,
      average_feels_like: 34.1,
      min_weather_temp: 27.8,
      max_weather_temp: 31.2,
      average_temp: 32.0,
    });
    return json(res, 200, data);
  }
  // /api/v1/activity/{id}/streams — 1110 muestras a 1 Hz con una loma en medio,
  // que es lo que hace falta para probar remuestreo, pendiente y desnivel.
  if ((match = path.match(/^\/api\/v1\/activity\/([^/]+)\/streams$/)) && req.method === "GET") {
    const n = 1110;
    const pedidos = (url.searchParams.get("types") || "").split(",").filter(Boolean);
    const todas = {
      time: Array.from({ length: n }, (_, i) => i),
      distance: Array.from({ length: n }, (_, i) => Math.round(i * 3.2 * 10) / 10),
      altitude: Array.from({ length: n }, (_, i) => 10 + Math.round(40 * Math.sin((Math.PI * i) / n) * 10) / 10),
      heartrate: Array.from({ length: n }, (_, i) => 120 + Math.round(50 * (i / n))),
      velocity_smooth: Array.from({ length: n }, () => 3.2),
      cadence: Array.from({ length: n }, () => 84),
      temp: Array.from({ length: n }, () => 31),
    };
    const tipos = pedidos.length ? pedidos : Object.keys(todas);
    const salida = tipos
      .filter((tipo) => todas[tipo])
      .map((tipo) => ({ type: tipo, data: todas[tipo], valueTypeIsArray: false, allNull: false }));
    return json(res, 200, salida);
  }
  if ((match = path.match(/^\/api\/v1\/activity\/([^/]+)\/intervals$/))) {
    return json(res, 200, {
      id: match[1],
      icu_intervals: [
        { label: "Calentamiento", type: "WARM_UP", moving_time: 900, distance: 2600, average_heartrate: 128, max_heartrate: 141, average_speed: 2.9, gap: 3.0, start_index: 0, end_index: 899, total_elevation_gain: 12, average_gradient: 0.005 },
        { label: "1000 m", type: "WORK", moving_time: 210, distance: 1000, average_heartrate: 168, max_heartrate: 176, average_speed: 4.76, gap: 4.8, start_index: 900, end_index: 1109, total_elevation_gain: 34, average_gradient: 0.034, decoupling: 2.1 },
      ],
    });
  }

  // /api/v1/athlete/{a}/events y /events/{id}
  if ((match = path.match(/^\/api\/v1\/athlete\/([^/]+)\/events$/))) {
    if (match[1] !== VALID_ATHLETE) return json(res, 404, { error: "Athlete not found" });
    if (req.method === "POST") {
      const payload = await cuerpo(req);
      const created = { ...payload, id: nextId++ };
      const description = payload.description || "";
      const steps = description.split("\n").filter((l) => l.startsWith("- ")).map((text) => ({ text }));
      created.workout_doc = { steps };
      created.moving_time = steps.length ? 3600 : null;
      created.icu_training_load = steps.length ? 72 : null;
      store.set(created.id, created);
      return json(res, 200, created);
    }
    const oldest = url.searchParams.get("oldest");
    const newest = url.searchParams.get("newest");
    const out = [...store.values()]
      .filter((e) => {
        const day = String(e.start_date_local || "").slice(0, 10);
        return day >= oldest && day <= newest;
      })
      .sort((a, b) => String(a.start_date_local).localeCompare(String(b.start_date_local)));
    return json(res, 200, out);
  }
  if ((match = path.match(/^\/api\/v1\/athlete\/([^/]+)\/events\/(\d+)$/))) {
    if (match[1] !== VALID_ATHLETE) return json(res, 404, { error: "Athlete not found" });
    const id = parseInt(match[2], 10);
    if (!store.has(id)) return json(res, 404, { error: "Event not found" });
    if (req.method === "GET") return json(res, 200, store.get(id));
    if (req.method === "PUT") {
      const payload = await cuerpo(req);
      store.set(id, { ...store.get(id), ...payload, id });
      return json(res, 200, store.get(id));
    }
    const removed = store.get(id);
    store.delete(id);
    return json(res, 200, { deleted: removed.id });
  }

  // /api/v1/athlete/{a} y sport-settings
  if ((match = path.match(/^\/api\/v1\/athlete\/([^/]+)\/sport-settings$/))) {
    if (match[1] !== VALID_ATHLETE) return json(res, 404, { error: "Athlete not found" });
    return json(res, 200, [
      { id: 11, types: ["Run"], lthr: 193, max_hr: 206, threshold_pace: 2.98, hr_zones: [154, 173, 183, 193, 206] },
      { id: 12, types: ["Ride", "VirtualRide"], lthr: 185, max_hr: 206, ftp: 220 },
    ]);
  }
  if ((match = path.match(/^\/api\/v1\/athlete\/([^/]+)$/))) {
    if (match[1] !== VALID_ATHLETE) return json(res, 404, { error: "Athlete not found" });
    return json(res, 200, { id: VALID_ATHLETE, name: "Atleta de prueba", weight: 84.2, timezone: "America/Bogota" });
  }

  json(res, 404, { error: `Ruta no contemplada en el stub: ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Stub de intervals.icu en http://127.0.0.1:${PORT}/api/v1 (clave: ${VALID_KEY}, atleta: ${VALID_ATHLETE})`);
});
