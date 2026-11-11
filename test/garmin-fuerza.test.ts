/**
 * Actividades y, sobre todo, series de fuerza.
 *
 * El peso es la trampa de este módulo: Garmin lo guarda en GRAMOS aunque la
 * unidad diga kilogramos. Equivocarse no da error, escribe una barra mil veces
 * más ligera —o mil veces más pesada— y el número sigue pareciendo un número.
 * Por eso la conversión está fijada en los dos sentidos.
 */

import { describe, expect, it } from "vitest";
import type { GarminCliente } from "../src/garmin/cliente";
import {
  formatearActividad,
  legible,
  leerActividad,
  listarActividades,
  normalizarSeries,
} from "../src/garmin/actividades";
import { construirEntreno, describirEntreno, EntrenoError } from "../src/garmin/entrenos";
import { GarminTools } from "../src/tools/garminTools";

function cliente(guion: Array<[RegExp, { estado?: number; cuerpo?: unknown }]>) {
  const rutas: string[] = [];
  const falso = {
    async api(ruta: string) {
      rutas.push(ruta);
      for (const [patron, respuesta] of guion) {
        if (patron.test(ruta)) {
          const estado = respuesta.estado ?? 200;
          return new Response(estado === 204 ? null : JSON.stringify(respuesta.cuerpo ?? null), {
            status: estado,
          });
        }
      }
      return new Response("", { status: 404 });
    },
  };
  return { rutas, falso: falso as unknown as GarminCliente };
}

const SERIES = {
  exerciseSets: [
    {
      setType: "ACTIVE",
      repetitionCount: 10,
      weight: 20000, // 20 kg en gramos
      duration: 45,
      exercises: [{ category: "ROW", name: "BARBELL_ROW", probability: 100 }],
    },
    { setType: "REST", duration: 90, exercises: [] },
    {
      setType: "ACTIVE",
      repetitionCount: 8,
      weight: 22500,
      duration: 40,
      exercises: [{ category: "ROW", name: "BARBELL_ROW" }],
    },
  ],
};

describe("series de fuerza", () => {
  it("el peso viene en gramos y sale en kilos", () => {
    const series = normalizarSeries(SERIES);
    expect(series[0]!.pesoKg).toBe(20);
    expect(series[2]!.pesoKg).toBe(22.5);
  });

  it("conserva el enum de Garmin además del nombre legible", () => {
    const [primera] = normalizarSeries(SERIES);
    expect(primera).toMatchObject({
      tipo: "ACTIVE",
      ejercicio: "Barbell row",
      categoria: "ROW",
      enum: "BARBELL_ROW",
      repeticiones: 10,
      segundos: 45,
    });
  });

  it("los descansos se reconocen como tales", () => {
    expect(normalizarSeries(SERIES)[1]).toMatchObject({ tipo: "REST", repeticiones: null });
  });

  it("sin ejercicio identificado no se inventa un nombre", () => {
    const series = normalizarSeries({ exerciseSets: [{ setType: "ACTIVE", repetitionCount: 5 }] });
    expect(series[0]).toMatchObject({ ejercicio: "—", categoria: null, enum: null, pesoKg: null });
  });

  it("los enums se leen sin guiones bajos", () => {
    expect(legible("BARBELL_BENCH_PRESS")).toBe("Barbell bench press");
    expect(legible("")).toBe("");
  });
});

describe("la actividad completa", () => {
  it("junta el detalle con sus series y suma el volumen", async () => {
    const { falso } = cliente([
      [
        /activity\/555$/,
        {
          cuerpo: {
            activityName: "Fuerza tren superior",
            activityTypeDTO: { typeKey: "strength_training" },
            summaryDTO: { startTimeLocal: "2026-09-15T18:30:00.0", duration: 2700, calories: 310 },
          },
        },
      ],
      [/exerciseSets/, { cuerpo: SERIES }],
    ]);
    const { actividad, series } = await leerActividad(falso, 555);
    const texto = formatearActividad(actividad, series, null);

    expect(texto).toContain("Fuerza tren superior");
    expect(texto).toContain("strength_training");
    expect(texto).toContain("2 series de trabajo");
    expect(texto).toContain("Barbell row");
    expect(texto).toContain("20 kg");
    expect(texto).toContain("ROW / BARBELL_ROW");
    // 10×20 + 8×22,5 = 380 kg.
    expect(texto).toContain("380 kg levantados");
  });

  it("una actividad sin series lo dice en vez de dejar la tabla vacía", async () => {
    const { falso } = cliente([
      [/activity\/1$/, { cuerpo: { activityName: "Rodaje", summaryDTO: { duration: 1800 } } }],
      [/exerciseSets/, { cuerpo: { exerciseSets: [] } }],
    ]);
    const { actividad, series, avisoSeries } = await leerActividad(falso, 1);
    expect(formatearActividad(actividad, series, avisoSeries)).toContain("no tiene series de fuerza ni vueltas");
  });

  it("un rodaje con entreno enseña sus vueltas, paso a paso", async () => {
    const { falso } = cliente([
      [/activity\/3$/, { cuerpo: { activityName: "Umbral 2x6", activityTypeDTO: { typeKey: "running" }, summaryDTO: { duration: 2400, distance: 7000 } } }],
      [/exerciseSets/, { cuerpo: { exerciseSets: [] } }],
      [
        /activity\/3\/splits/,
        {
          cuerpo: {
            lapDTOs: [
              { lapIndex: 1, intensityType: "WARMUP", wktStepIndex: 0, duration: 900, distance: 2400, averageSpeed: 2.667, averageHR: 140, maxHR: 152, averageRunCadence: 158, elevationGain: 3 },
              { lapIndex: 2, intensityType: "ACTIVE", wktStepIndex: 1, duration: 360, distance: 1240, averageSpeed: 3.444, avgGradeAdjustedSpeed: 3.5, averageHR: 181, maxHR: 186, averageRunCadence: 170, elevationGain: 1 },
              { lapIndex: 3, intensityType: "RECOVERY", wktStepIndex: 2, duration: 120, distance: 300, averageSpeed: 2.5, averageHR: 160, maxHR: 178, averageRunCadence: 150, elevationGain: 0 },
            ],
          },
        },
      ],
    ]);
    const r = await leerActividad(falso, 3);
    expect(r.vueltas).toHaveLength(3);
    expect(r.vueltas[1]).toMatchObject({ numero: 2, paso: 2, intensidad: "ACTIVE", fcMedia: 181 });
    const texto = formatearActividad(r.actividad, r.series, r.avisoSeries, r.vueltas, r.avisoVueltas);
    expect(texto).toContain("3 vueltas");
    expect(texto).toMatch(/2 +2 trabajo +6:00 +1\.24 +4:50 +4:46 +181\/186 +170/);
    expect(texto).toMatch(/calentam\./);
    expect(texto).toMatch(/recuper\./);
    expect(texto).not.toContain("no tiene series");
  });

  it("en bici la marcha va en km/h y nadando en /100 m", async () => {
    const { formatearVueltas } = await import("../src/garmin/actividades");
    const v = { numero: 1, intensidad: null, paso: null, segundos: 600, distanciaM: 5000, velocidad: 8.333, gap: null, fcMedia: 130, fcMax: 140, cadencia: 85, potencia: null, desnivelM: 10 };
    expect(formatearVueltas([v], "road_biking").join("\n")).toMatch(/km\/h[\s\S]*30\.0/);
    expect(formatearVueltas([{ ...v, velocidad: 0.8333 }], "lap_swimming").join("\n")).toMatch(/\/100m[\s\S]*2:00/);
  });

  it("si fallan las series, la actividad se enseña igual", async () => {
    const { falso } = cliente([
      [/activity\/2$/, { cuerpo: { activityName: "Fuerza", summaryDTO: { duration: 600 } } }],
      [/exerciseSets/, { estado: 500 }],
    ]);
    const { actividad, series, avisoSeries } = await leerActividad(falso, 2);
    const texto = formatearActividad(actividad, series, avisoSeries);
    expect(texto).toContain("«Fuerza»");
    expect(texto).toContain("No se pudieron leer las series");
  });
});

describe("la lista de actividades", () => {
  it("filtra por fecha y deporte si se le pide", async () => {
    const { rutas, falso } = cliente([[/activitylist/, { cuerpo: [] }]]);
    await listarActividades(falso, {
      limite: 5,
      desde: "2026-09-01",
      hasta: "2026-09-16",
      deporte: "strength_training",
    });
    expect(rutas[0]).toContain("limit=5");
    expect(rutas[0]).toContain("startDate=2026-09-01");
    expect(rutas[0]).toContain("activityType=strength_training");
  });

  it("el límite no se dispara", async () => {
    const { rutas, falso } = cliente([[/activitylist/, { cuerpo: [] }]]);
    const tools = new GarminTools(falso, () => "2026-09-16");
    await tools.actividades({ limit: 9999 });
    expect(rutas[0]).toContain("limit=50");
  });
});

describe("escribir fuerza", () => {
  const paso = (step: Record<string, unknown>) => {
    const { entreno } = construirEntreno({
      nombre: "Fuerza",
      deporte: "WeightTraining",
      pasos: [step],
    });
    return (entreno.workoutSegments[0]!.workoutSteps as Array<Record<string, unknown>>)[0]!;
  };

  it("las repeticiones son la condición de fin, no el tiempo", () => {
    expect(paso({ label: "Remo", category: "ROW", exercise: "BARBELL_ROW", reps: 10 })).toMatchObject({
      endCondition: { conditionTypeKey: "reps" },
      endConditionValue: 10,
      category: "ROW",
      exerciseName: "BARBELL_ROW",
    });
  });

  it("el peso de un paso va en kilos, tal cual", () => {
    // El 16/09/2026 se pidieron 8 kg, se escribieron 8000 «gramos» y el reloj
    // enseñó «8,000.0 kg». Ocho toneladas, y nada falló por el camino: el
    // factor 1000 de la unidad es su equivalencia en gramos, no un multiplicador.
    expect(paso({ category: "ROW", reps: 8, weight_kg: 22.5 })).toMatchObject({
      weightValue: 22.5,
      weightUnit: { unitKey: "kilogram" },
    });
    expect(paso({ category: "ROW", reps: 10, weight_kg: 8 }).weightValue).toBe(8);
  });

  it("un ejercicio sin categoría se rechaza: el reloj enseñaría un genérico", () => {
    expect(() => paso({ exercise: "BARBELL_ROW", reps: 10 })).toThrow(/necesita también 'category'/);
    expect(() => paso({ exercise: "BARBELL_ROW", reps: 10 })).toThrow(/garmin_activity/);
  });

  it("unas repeticiones o un peso imposibles no salen del Worker", () => {
    expect(() => paso({ category: "ROW", reps: 0 })).toThrow(EntrenoError);
    expect(() => paso({ category: "ROW", reps: 10, weight_kg: -5 })).toThrow(EntrenoError);
  });

  it("un paso de fuerza por tiempo sigue valiendo", () => {
    expect(paso({ category: "PLANK", duration: "45s" })).toMatchObject({
      endCondition: { conditionTypeKey: "time" },
      endConditionValue: 45,
      category: "PLANK",
    });
  });

  it("al releerlo se ven el ejercicio y el peso", () => {
    const { entreno } = construirEntreno({
      nombre: "Fuerza",
      deporte: "WeightTraining",
      pasos: [
        { label: "Remo invertido", category: "ROW", exercise: "BARBELL_ROW", reps: 10, weight_kg: 20 },
      ],
    });
    const texto = describirEntreno(entreno);
    expect(texto).toContain("10 reps");
    expect(texto).toContain("«Remo invertido»");
    expect(texto).toContain("[ROW / BARBELL_ROW]");
    expect(texto).toContain("20 kg");
    expect(texto).not.toContain("20000");
  });
});


/**
 * Lo que enseñó una sesión de terapia real: el reloj cuenta repeticiones aunque
 * no reconozca el movimiento, y Garmin lo llama UNKNOWN. Escribirlo tal cual lo
 * convierte en «Unknown», que se lee como el nombre de un ejercicio.
 */
describe("series que el reloj no supo identificar", () => {
  const TERAPIA = {
    exerciseSets: [
      { setType: "ACTIVE", repetitionCount: 15, duration: 40, exercises: [{ category: "UNKNOWN" }] },
      { setType: "ACTIVE", repetitionCount: 14, duration: 40, exercises: [{ category: "CURL" }] },
      { setType: "ACTIVE", repetitionCount: 3, duration: 30, exercises: [{ category: "UNKNOWN" }] },
    ],
  };

  it("UNKNOWN no es el nombre de un ejercicio: es un hueco", () => {
    expect(legible("UNKNOWN")).toBe("(sin identificar)");
    expect(normalizarSeries(TERAPIA)[0]!.ejercicio).toBe("(sin identificar)");
  });

  it("se dice cuántas quedaron sin identificar, y que las reps sí son reales", () => {
    const texto = formatearActividad(
      {
        id: 1, nombre: "Terapia", fecha: "2026-09-14", hora: "19:41", deporte: "strength_training",
        segundos: 753, distanciaM: null, fcMedia: 74, fcMax: 96, calorias: 22, desnivelM: null,
        efectoAerobico: null, efectoAnaerobico: null, carga: null, segundosMov: null,
      },
      normalizarSeries(TERAPIA),
      null,
    );
    expect(texto).toContain("2 de las 3 series salen «(sin identificar)»");
    expect(texto).toContain("repeticiones y los tiempos son reales");
  });
});

describe("avisos al releer un entreno", () => {
  it("un entreno de fuerza sin enums avisa de que el reloj pondrá genéricos", () => {
    // El caso real: los entrenos de fuerza que llegan desde intervals.icu traen
    // etiqueta pero ningún ejercicio del catálogo.
    const { entreno } = construirEntreno({
      nombre: "Colgado pasivo",
      deporte: "WeightTraining",
      pasos: [{ label: "Colgado pasivo con pies apoyados", duration: "20s" }],
    });
    const texto = describirEntreno(entreno);
    expect(texto).toContain("Ningún paso lleva ejercicio del catálogo");
    expect(texto).toContain("«--»");
    expect(texto).not.toContain("«(sin etiqueta)»:");
  });

  it("con enums no hay nada que avisar", () => {
    const { entreno } = construirEntreno({
      nombre: "Fuerza",
      deporte: "WeightTraining",
      pasos: [{ label: "Remo", category: "ROW", exercise: "BARBELL_ROW", reps: 10 }],
    });
    const texto = describirEntreno(entreno);
    expect(texto).not.toContain("Ningún paso lleva ejercicio");
    expect(texto).not.toContain("«(sin etiqueta)»:");
  });

  it("un correr sin etiquetas avisa de eso y no de los enums", () => {
    const { entreno } = construirEntreno({
      nombre: "Rodaje",
      deporte: "Run",
      pasos: [{ duration: "40m" }],
    });
    const texto = describirEntreno(entreno);
    expect(texto).toContain("«(sin etiqueta)»:");
    expect(texto).not.toContain("Ningún paso lleva ejercicio");
  });
});
