/**
 * Las herramientas de Garmin vistas desde fuera: lo que el entrenador llama.
 *
 * Lo que se vigila: que peguen en el endpoint correcto con el cuerpo correcto
 * —un entreno mal formado no falla, llega raro al reloj—, que la respuesta diga
 * qué ha pasado de verdad (creado y programado no es lo mismo que creado), y
 * que los errores salgan como texto que el MCP marca como error, en vez de
 * reventar la llamada.
 */

import { describe, expect, it } from "vitest";
import type { GarminCliente } from "../src/garmin/cliente";
import { GarminError } from "../src/garmin/cliente";
import { GarminTools } from "../src/tools/garminTools";

interface Llamada {
  ruta: string;
  metodo: string;
  cuerpo: unknown;
}

/** Cliente de mentira: apunta lo que se le pide y responde el guion. */
function cliente(guion: Array<[RegExp, { estado?: number; cuerpo?: unknown; texto?: string }]>) {
  const llamadas: Llamada[] = [];
  const falso = {
    async api(ruta: string, init: RequestInit = {}) {
      llamadas.push({
        ruta,
        metodo: init.method ?? "GET",
        cuerpo: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      for (const [patron, respuesta] of guion) {
        if (patron.test(ruta)) {
          const estado = respuesta.estado ?? 200;
          // Un 204 no admite cuerpo, ni siquiera vacío: el constructor protesta.
          const cuerpo =
            estado === 204
              ? null
              : respuesta.cuerpo === undefined
                ? (respuesta.texto ?? "")
                : JSON.stringify(respuesta.cuerpo);
          return new Response(cuerpo, { status: estado });
        }
      }
      throw new Error(`Ruta sin guion: ${ruta}`);
    },
  };
  return { llamadas, tools: new GarminTools(falso as unknown as GarminCliente, () => "2026-09-16") };
}

const PASOS = [
  { label: "Calentamiento", duration: "10m", intensity: "warmup" },
  { repeat: 4, steps: [{ label: "Serie", distance: "1km", pace: "4:10/km" }] },
];

describe("crear entreno", () => {
  it("lo manda a /workout-service/workout y cuenta lo que ha hecho", async () => {
    const { llamadas, tools } = cliente([
      [/workouts\?/, { cuerpo: [] }],
      [/workout$/, { cuerpo: { workoutId: 987 } }],
    ]);
    const texto = await tools.crearEntreno({ name: "Series 4x1k", sport: "Run", steps: PASOS });

    const creacion = llamadas.find((l) => l.metodo === "POST")!;
    expect(creacion.ruta).toBe("/workout-service/workout");
    const enviado = creacion.cuerpo as Record<string, unknown>;
    expect(enviado.workoutName).toBe("Series 4x1k");
    expect(enviado.sportType).toMatchObject({ sportTypeKey: "running" });

    expect(texto).toContain("id 987");
    // Sin fecha no llega al reloj, y eso tiene que quedar dicho.
    expect(texto).toContain("sin fecha");
    expect(texto).not.toMatch(/^Error/);
  });

  it("con fecha, crea y programa en dos llamadas", async () => {
    const { llamadas, tools } = cliente([
      [/workouts\?/, { cuerpo: [] }],
      [/workout$/, { cuerpo: { workoutId: 555 } }],
      [/schedule/, { cuerpo: { workoutScheduleId: 1 } }],
    ]);
    const texto = await tools.crearEntreno({
      name: "Rodaje",
      sport: "Run",
      steps: [{ duration: "40m" }],
      date: "2026-09-20",
    });

    expect(llamadas.filter((l) => l.metodo === "POST").map((l) => l.ruta)).toEqual([
      "/workout-service/workout",
      "/workout-service/schedule/555",
    ]);
    expect(llamadas.find((l) => l.ruta.includes("schedule"))!.cuerpo).toEqual({
      date: "2026-09-20",
    });
    expect(texto).toContain("2026-09-20");
  });

  it('"hoy" se resuelve con la fecha del atleta, no con la del servidor', async () => {
    const { llamadas, tools } = cliente([
      [/workouts\?/, { cuerpo: [] }],
      [/workout$/, { cuerpo: { workoutId: 1 } }],
      [/schedule/, { cuerpo: {} }],
    ]);
    await tools.crearEntreno({ name: "x", sport: "Run", steps: [{ duration: "5m" }], date: "hoy" });
    expect(llamadas.find((l) => l.ruta.includes("schedule"))!.cuerpo).toEqual({
      date: "2026-09-16",
    });
  });

  it("un entreno mal escrito no sale del Worker", async () => {
    const { llamadas, tools } = cliente([]);
    const texto = await tools.crearEntreno({
      name: "Malo",
      sport: "Run",
      steps: [{ duration: "10m", target: "algo raro de intervals" }],
    });
    expect(texto).toMatch(/^Error/);
    expect(llamadas).toHaveLength(0);
  });

  it("sin el umbral que hace falta, no se escribe el entreno", async () => {
    // El guion no responde nada útil: Garmin no tiene umbrales guardados.
    const { llamadas, tools } = cliente([]);
    const texto = await tools.crearEntreno({
      name: "Series al 90%",
      sport: "Run",
      steps: [{ duration: "10m", hr_pct: 90 }],
    });
    expect(texto).toMatch(/^Error/);
    expect(texto).toContain("garmin_thresholds");
    expect(llamadas.some((l) => l.metodo === "POST")).toBe(false);
  });

  it("con umbrales, convierte y cuenta con cuál", async () => {
    const { llamadas, tools } = cliente([
      [/workouts\?/, { cuerpo: [] }],
      [/user-settings/, { cuerpo: { userData: { lactateThresholdHeartRate: 172 } } }],
      [/heartRateZones/, { cuerpo: {} }],
      [/biometric-service\/stats/, { cuerpo: [] }],
      [/workout$/, { cuerpo: { workoutId: 77 } }],
    ]);
    const texto = await tools.crearEntreno({
      name: "Umbral",
      sport: "Run",
      steps: [{ label: "Bloque", duration: "20m", hr_pct: [88, 92] }],
    });

    expect(texto).toContain("88-92 % de LTHR 172 ppm → 151-158 ppm");
    const enviado = llamadas.find((l) => l.ruta === "/workout-service/workout")!.cuerpo as {
      workoutSegments: Array<{ workoutSteps: Array<Record<string, unknown>> }>;
    };
    expect(enviado.workoutSegments[0]!.workoutSteps[0]).toMatchObject({
      targetType: { workoutTargetTypeKey: "heart.rate.zone" },
      targetValueOne: 151,
      targetValueTwo: 158,
    });
  });

  it("los umbrales solo se piden si hay algún porcentaje", async () => {
    const { llamadas, tools } = cliente([
      [/workouts\?/, { cuerpo: [] }],
      [/workout$/, { cuerpo: { workoutId: 1 } }],
    ]);
    await tools.crearEntreno({ name: "x", sport: "Run", steps: [{ duration: "5m", bpm: 140 }] });
    expect(llamadas.some((l) => l.ruta.includes("user-settings"))).toBe(false);
    expect(llamadas.some((l) => l.ruta.includes("biometric"))).toBe(false);
  });

  it("no duplica un entreno que ya existe con ese nombre", async () => {
    // Garmin no tiene clave de idempotencia: un reintento tras un timeout llega
    // con el mismo nombre y dejaría dos sesiones iguales en la biblioteca.
    const { llamadas, tools } = cliente([
      [/workouts\?/, { cuerpo: [{ workoutId: 300, workoutName: "Series 4x1k" }] }],
    ]);
    const texto = await tools.crearEntreno({ name: "Series 4x1k", sport: "Run", steps: PASOS });
    expect(texto).toContain("Ya existe");
    expect(texto).toContain("id 300");
    expect(texto).toContain("garmin_schedule_workout");
    expect(llamadas.every((l) => l.metodo !== "POST")).toBe(true);
  });

  it("con allow_duplicate no pregunta y crea", async () => {
    const { llamadas, tools } = cliente([
      [/workouts\?/, { cuerpo: [{ workoutId: 300, workoutName: "Series 4x1k" }] }],
      [/workout$/, { cuerpo: { workoutId: 301 } }],
    ]);
    const texto = await tools.crearEntreno({
      name: "Series 4x1k",
      sport: "Run",
      steps: PASOS,
      allow_duplicate: true,
    });
    expect(texto).toContain("id 301");
    expect(llamadas.some((l) => l.metodo === "POST")).toBe(true);
  });

  it("si la biblioteca no se puede leer, escribe igual en vez de bloquear", async () => {
    const { tools } = cliente([
      [/workouts\?/, { estado: 500 }],
      [/workout$/, { cuerpo: { workoutId: 9 } }],
    ]);
    expect(await tools.crearEntreno({ name: "x", sport: "Run", steps: [{ duration: "5m" }] }))
      .toContain("id 9");
  });

  it("también los busca dentro de las series", async () => {
    const { llamadas, tools } = cliente([
      [/workouts\?/, { cuerpo: [] }],
      [/user-settings/, { cuerpo: { functionalThresholdPower: 250 } }],
      [/heartRateZones/, { cuerpo: {} }],
      [/biometric-service\/stats/, { cuerpo: [] }],
      [/workout$/, { cuerpo: { workoutId: 2 } }],
    ]);
    const texto = await tools.crearEntreno({
      name: "Series",
      sport: "Ride",
      steps: [{ repeat: 3, steps: [{ duration: "5m", power_pct: 100 }] }],
    });
    expect(llamadas.some((l) => l.ruta.includes("user-settings"))).toBe(true);
    expect(texto).toContain("100 % de FTP 250 W → 250 W");
  });

  it("si Garmin no devuelve id, se dice en vez de fingir que fue bien", async () => {
    const { tools } = cliente([
      [/workouts\?/, { cuerpo: [] }],
      [/workout$/, { cuerpo: { mensaje: "ok" } }],
    ]);
    expect(await tools.crearEntreno({ name: "x", sport: "Run", steps: [{ duration: "5m" }] }))
      .toMatch(/^Error.*no devolvió su id/);
  });

  it("un error de Garmin llega legible, con su código", async () => {
    const { tools } = cliente([
      [/workouts\?/, { cuerpo: [] }],
      [/workout$/, { estado: 500, texto: "boom" }],
    ]);
    const texto = await tools.crearEntreno({ name: "x", sport: "Run", steps: [{ duration: "5m" }] });
    expect(texto).toMatch(/^Error/);
    expect(texto).toContain("500");
  });

  it("sin cuenta enlazada, manda al panel en vez de fallar en seco", async () => {
    const falso = {
      api: async () => {
        throw new GarminError("no_enlazada", "No hay ninguna cuenta de Garmin enlazada. Entra en /app/garmin.");
      },
    };
    const tools = new GarminTools(falso as unknown as GarminCliente, () => "2026-09-16");
    expect(await tools.crearEntreno({ name: "x", sport: "Run", steps: [{ duration: "5m" }] }))
      .toContain("/app/garmin");
  });
});

describe("programar, listar y borrar", () => {
  it("programa por id", async () => {
    const { llamadas, tools } = cliente([[/schedule/, { cuerpo: {} }]]);
    const texto = await tools.programarEntreno({ workout_id: 42, date: "2026-10-01" });
    expect(llamadas[0]).toMatchObject({ ruta: "/workout-service/schedule/42", metodo: "POST" });
    expect(texto).toContain("2026-10-01");
  });

  it("una fecha que no es fecha se rechaza antes de salir", async () => {
    const { llamadas, tools } = cliente([]);
    expect(await tools.programarEntreno({ workout_id: 42, date: "el martes" })).toMatch(/^Error/);
    expect(llamadas).toHaveLength(0);
  });

  it("lista la biblioteca con los ids a la vista", async () => {
    const { tools } = cliente([
      [
        /workouts\?/,
        {
          cuerpo: [
            {
              workoutId: 111,
              workoutName: "Series 4x1k",
              sportType: { sportTypeKey: "running" },
              estimatedDurationInSecs: 3600,
              updatedDate: "2026-09-15T10:00:00.0",
            },
          ],
        },
      ],
    ]);
    const texto = await tools.listarEntrenos({});
    expect(texto).toContain("111");
    expect(texto).toContain("Series 4x1k");
    expect(texto).toContain("1h00");
  });

  it("la biblioteca vacía se dice, no se finge", async () => {
    const { tools } = cliente([[/workouts\?/, { cuerpo: [] }]]);
    expect(await tools.listarEntrenos({})).toContain("No hay entrenos");
  });

  it("el límite se queda dentro de lo razonable", async () => {
    const { llamadas, tools } = cliente([[/workouts\?/, { cuerpo: [] }]]);
    await tools.listarEntrenos({ limit: 5000 });
    expect(llamadas[0]!.ruta).toContain("limit=50");
  });

  it("sin confirm no borra: dice qué entreno es", async () => {
    // delete_event de intervals exige confirm y aquí tampoco hay papelera: un
    // id equivocado se lleva por delante una sesión real.
    const { llamadas, tools } = cliente([
      [/workout\/42/, { cuerpo: { workoutId: 42, workoutName: "Series importantes" } }],
    ]);
    const texto = await tools.borrarEntreno({ workout_id: 42 });
    expect(texto).toContain("Sin borrar");
    expect(texto).toContain("Series importantes");
    expect(llamadas.every((l) => l.metodo !== "DELETE")).toBe(true);
  });

  it("con confirm borra", async () => {
    const { llamadas, tools } = cliente([[/workout\/42/, { estado: 204 }]]);
    const texto = await tools.borrarEntreno({ workout_id: 42, confirm: true });
    expect(llamadas[0]).toMatchObject({ ruta: "/workout-service/workout/42", metodo: "DELETE" });
    expect(texto).toContain("borrado");
  });

  it("borrar sin id no borra nada", async () => {
    const { llamadas, tools } = cliente([]);
    expect(await tools.borrarEntreno({})).toMatch(/^Error/);
    expect(llamadas).toHaveLength(0);
  });
});

describe("quitar una fecha del calendario", () => {
  const CITA = {
    workoutScheduleId: 1836565907,
    calendarDate: "2026-11-11",
    workout: { workoutId: 1704873617, workoutName: "Caminata 20 min (barrio)" },
  };

  it("sin confirm no quita nada: dice qué entreno y qué día", async () => {
    const { llamadas, tools } = cliente([[/schedule\/1836565907/, { cuerpo: CITA }]]);
    const texto = await tools.desprogramar({ schedule_id: 1836565907 });
    expect(texto).toContain("Sin quitar");
    expect(texto).toContain("«Caminata 20 min (barrio)» el 2026-11-11");
    expect(texto).toContain("entreno 1704873617");
    expect(llamadas.every((l) => l.metodo !== "DELETE")).toBe(true);
  });

  it("con confirm borra la programación, no el entreno", async () => {
    const { llamadas, tools } = cliente([[/schedule\/1836565907/, { cuerpo: CITA }]]);
    const texto = await tools.desprogramar({ schedule_id: 1836565907, confirm: true });
    const borrado = llamadas.find((l) => l.metodo === "DELETE");
    expect(borrado?.ruta).toBe("/workout-service/schedule/1836565907");
    expect(llamadas.some((l) => /workout\/1704873617/.test(l.ruta))).toBe(false);
    expect(texto).toContain("Quitado del calendario");
    expect(texto).toContain("sus otras fechas");
  });

  it("un id que no es de una programación no borra nada", async () => {
    const { llamadas, tools } = cliente([[/schedule\/999/, { cuerpo: { workoutId: 999 } }]]);
    const texto = await tools.desprogramar({ schedule_id: 999, confirm: true });
    expect(texto).toMatch(/^Error: Garmin no reconoce 999 como una programación/);
    expect(llamadas.every((l) => l.metodo !== "DELETE")).toBe(true);
  });

  it("sin id no sale a Garmin", async () => {
    const { llamadas, tools } = cliente([]);
    expect(await tools.desprogramar({})).toMatch(/^Error: Falta 'schedule_id'/);
    expect(llamadas).toHaveLength(0);
  });
});

describe("cambiar un entreno sin perder sus fechas", () => {
  const VIEJO = {
    workoutId: 1704873617,
    ownerId: 99,
    workoutName: "Caminata 20 min (barrio)",
    sportType: { sportTypeId: 9, sportTypeKey: "walking", displayOrder: 9 },
    author: { displayName: "x" },
    workoutSegments: [{ segmentOrder: 1, sportType: { sportTypeId: 9, sportTypeKey: "walking" }, workoutSteps: [{ type: "ExecutableStepDTO" }] }],
  };

  it("hace PUT sobre el mismo id, conserva el dueño y cuenta los pasos de antes y ahora", async () => {
    const { llamadas, tools } = cliente([[/workout\/1704873617$/, { cuerpo: VIEJO }]]);
    const texto = await tools.actualizarEntreno({
      workout_id: 1704873617,
      name: "Caminata 25 min (barrio)",
      sport: "Walk",
      steps: [
        { label: "Caminar", duration: "20m", intensity: "active" },
        { label: "Estirar", duration: "5m", intensity: "cooldown" },
      ],
    });
    const put = llamadas.find((l) => l.metodo === "PUT");
    expect(put?.ruta).toBe("/workout-service/workout/1704873617");
    expect(put?.cuerpo).toMatchObject({
      workoutId: 1704873617,
      ownerId: 99,
      author: { displayName: "x" },
      workoutName: "Caminata 25 min (barrio)",
      // El deporte se conserva tal como lo tenía Garmin, también en el segmento.
      sportType: { sportTypeKey: "walking" },
      workoutSegments: [{ sportType: { sportTypeKey: "walking" } }],
    });
    expect((put?.cuerpo as { workoutSegments: Array<{ workoutSteps: unknown[] }> }).workoutSegments[0]!.workoutSteps).toHaveLength(2);
    expect(llamadas.some((l) => l.metodo === "DELETE" || l.metodo === "POST")).toBe(false);
    expect(texto).toContain("«Caminata 20 min (barrio)» → «Caminata 25 min (barrio)»");
    expect(texto).toContain("Antes: 1 pasos escritos · ahora: 2 pasos escritos");
    expect(texto).toContain("todas sus fechas");
  });

  it("si Garmin pierde el deporte al guardar, lo dice", async () => {
    let guardado: unknown = VIEJO;
    const llamadas: string[] = [];
    const falso = {
      async api(ruta: string, init: RequestInit = {}) {
        llamadas.push(`${init.method ?? "GET"} ${ruta}`);
        if (init.method === "PUT") {
          guardado = { ...(JSON.parse(String(init.body)) as object), sportType: null };
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify(guardado), { status: 200 });
      },
    };
    const tools = new GarminTools(falso as unknown as GarminCliente, () => "2026-09-16");
    const texto = await tools.actualizarEntreno({
      workout_id: 1704873617, name: "Caminata", sport: "Walk", steps: [{ label: "Caminar", duration: "20m" }],
    });
    expect(texto).toMatch(/^⚠ Garmin guardó el entreno con deporte «ninguno» en vez de «walking»/);
  });

  it("un entreno mal escrito no toca el que hay", async () => {
    const { llamadas, tools } = cliente([[/workout\/5$/, { cuerpo: VIEJO }]]);
    const texto = await tools.actualizarEntreno({ workout_id: 5, name: "X", sport: "Run", steps: [] });
    expect(texto).toMatch(/^Error/);
    expect(llamadas.every((l) => l.metodo === "GET")).toBe(true);
  });

  it("sin id no sale a Garmin", async () => {
    const { llamadas, tools } = cliente([]);
    expect(await tools.actualizarEntreno({ name: "X", sport: "Run", steps: [] })).toMatch(/^Error: Falta 'workout_id'/);
    expect(llamadas).toHaveLength(0);
  });
});
