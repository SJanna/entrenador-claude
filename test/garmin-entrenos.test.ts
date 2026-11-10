/**
 * La traducción de pasos a entreno de Garmin.
 *
 * Aquí las UNIDADES lo son todo, igual que en el resto del proyecto:
 * equivocarse no rompe nada, escribe un número plausible y falso en el reloj y
 * el atleta hace la sesión que no era. Y hay una trampa heredada: en
 * intervals.icu "400m" son 400 MINUTOS, mientras que en Garmin —y aquí— son
 * 400 metros. Los dos caminos conviven, así que la diferencia tiene que estar
 * probada, no recordada.
 */

import { describe, expect, it } from "vitest";
import {
  construirEntreno,
  EntrenoError,
  metros,
  metrosPorSegundo,
  segundos,
} from "../src/garmin/entrenos";

/** Atajo: los pasos del primer (y único) segmento. */
function pasos(construido: ReturnType<typeof construirEntreno>): Array<Record<string, unknown>> {
  return construido.entreno.workoutSegments[0]!.workoutSteps as Array<Record<string, unknown>>;
}

describe("duraciones", () => {
  it("entiende la sintaxis de siempre", () => {
    expect(segundos("10m", 1)).toBe(600);
    expect(segundos("1h30m", 1)).toBe(5400);
    expect(segundos("5m30s", 1)).toBe(330);
    expect(segundos("45s", 1)).toBe(45);
    expect(segundos("5:00", 1)).toBe(300);
    expect(segundos("1:05:30", 1)).toBe(3930);
    expect(segundos(600, 1)).toBe(600);
  });

  it("rechaza lo que no entiende en vez de suponer", () => {
    for (const malo of ["", "diez minutos", 0, -5, true, null]) {
      expect(() => segundos(malo, 3)).toThrow(EntrenoError);
    }
  });
});

describe("distancias", () => {
  it("convierte a metros", () => {
    expect(metros("400mtr", 1)).toBe(400);
    expect(metros("5km", 1)).toBe(5000);
    expect(metros("1mi", 1)).toBe(1609.34);
    expect(metros("100yrd", 1)).toBe(91.44);
    expect(metros(400, 1)).toBe(400);
  });

  it("«400m» aquí son 400 METROS, no 400 minutos como en intervals.icu", () => {
    expect(metros("400m", 1)).toBe(400);
  });

  it("una unidad desconocida no se adivina", () => {
    expect(() => metros("400 leguas", 2)).toThrow(/unidad de distancia/i);
  });
});

describe("ritmos", () => {
  it("pasa de ritmo a velocidad, que es lo que guarda Garmin", () => {
    expect(metrosPorSegundo("5:00/km", 1)).toBeCloseTo(3.3333, 3);
    expect(metrosPorSegundo("4:00/km", 1)).toBeCloseTo(4.1667, 3);
    expect(metrosPorSegundo("1:45/100m", 1)).toBeCloseTo(0.9524, 3);
  });

  it("un porcentaje no es un ritmo", () => {
    expect(() => metrosPorSegundo("90%", 1)).toThrow(EntrenoError);
  });
});

describe("estructura del entreno", () => {
  const RODAJE = {
    nombre: "Rodaje con series",
    deporte: "carrera",
    pasos: [
      { label: "Calentamiento", duration: "15m", intensity: "warmup" },
      {
        repeat: 6,
        steps: [
          { label: "Serie", distance: "400mtr", pace: "4:00/km", intensity: "active" },
          { label: "Trote", duration: "90s", intensity: "rest" },
        ],
      },
      { label: "Vuelta a la calma", duration: "10m", intensity: "cooldown" },
    ],
  };

  it("arma segmento, deporte y tipos de paso", () => {
    const { entreno } = construirEntreno(RODAJE);
    expect(entreno.workoutName).toBe("Rodaje con series");
    expect(entreno.sportType).toMatchObject({ sportTypeId: 1, sportTypeKey: "running" });
    expect(entreno.workoutSegments).toHaveLength(1);

    const lista = pasos(construirEntreno(RODAJE));
    expect(lista).toHaveLength(3);
    expect(lista[0]).toMatchObject({
      type: "ExecutableStepDTO",
      stepOrder: 1,
      stepType: { stepTypeKey: "warmup" },
      endCondition: { conditionTypeKey: "time" },
      endConditionValue: 900,
      description: "Calentamiento",
    });
    expect(lista[2]).toMatchObject({ stepType: { stepTypeKey: "cooldown" }, endConditionValue: 600 });
  });

  it("las series son un grupo de repetición con sus hijos dentro", () => {
    const grupo = pasos(construirEntreno(RODAJE))[1] as Record<string, unknown>;
    expect(grupo).toMatchObject({
      type: "RepeatGroupDTO",
      stepOrder: 2,
      numberOfIterations: 6,
      endCondition: { conditionTypeKey: "iterations" },
      endConditionValue: 6,
    });
    const hijos = grupo.workoutSteps as Array<Record<string, unknown>>;
    expect(hijos).toHaveLength(2);
    expect(hijos[0]).toMatchObject({
      stepOrder: 3,
      endCondition: { conditionTypeKey: "distance" },
      endConditionValue: 400,
      targetType: { workoutTargetTypeKey: "pace.zone" },
    });
    expect(hijos[1]).toMatchObject({ stepOrder: 4, stepType: { stepTypeKey: "rest" } });
  });

  it("la duración estimada cuenta cada repetición, no una sola vuelta", () => {
    // 15 min + 6 × 90 s de trote + 10 min. Las series van por distancia y no
    // suman tiempo: estimar de menos es preferible a inventarse un ritmo.
    expect(construirEntreno(RODAJE).entreno.estimatedDurationInSecs).toBe(900 + 6 * 90 + 600);
  });

  it("los pasos se numeran seguidos, también dentro de los grupos", () => {
    const lista = pasos(construirEntreno(RODAJE));
    const grupo = lista[1] as Record<string, unknown>;
    const ordenes = [
      lista[0]!.stepOrder,
      grupo.stepOrder,
      ...(grupo.workoutSteps as Array<Record<string, unknown>>).map((h) => h.stepOrder),
      lista[2]!.stepOrder,
    ];
    expect(ordenes).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("objetivos", () => {
  const conPaso = (paso: Record<string, unknown>) =>
    pasos(construirEntreno({ nombre: "x", deporte: "Run", pasos: [paso] }))[0]!;

  it("vatios y pulsaciones van como rango absoluto", () => {
    expect(conPaso({ duration: "5m", watts: [200, 240] })).toMatchObject({
      targetType: { workoutTargetTypeKey: "power.zone" },
      targetValueOne: 200,
      targetValueTwo: 240,
    });
    expect(conPaso({ duration: "5m", bpm: 150 })).toMatchObject({
      targetType: { workoutTargetTypeKey: "heart.rate.zone" },
      targetValueOne: 150,
      targetValueTwo: 150,
    });
  });

  it("un rango al revés se ordena solo", () => {
    expect(conPaso({ duration: "5m", watts: [240, 200] })).toMatchObject({
      targetValueOne: 200,
      targetValueTwo: 240,
    });
  });

  it("el ritmo se guarda como velocidad, con un margen para que el reloj no pite", () => {
    const paso = conPaso({ duration: "5m", pace: "5:00/km" });
    expect(paso.targetType).toMatchObject({ workoutTargetTypeKey: "pace.zone" });
    expect(paso.targetValueOne as number).toBeCloseTo(3.2667, 3);
    expect(paso.targetValueTwo as number).toBeCloseTo(3.4, 3);
    expect(paso.targetValueOne as number).toBeLessThan(paso.targetValueTwo as number);
  });

  it("#79: un rango de pulso en texto '90-155' es un rango, no un 90 fijo", () => {
    expect(conPaso({ duration: "5m", bpm: "90-155" })).toMatchObject({
      targetValueOne: 90,
      targetValueTwo: 155,
    });
  });

  it("#79: medio número se rechaza en vez de guardarse en silencio", () => {
    expect(() => conPaso({ duration: "5m", bpm: "150ppm" })).toThrow(/no válido/);
    expect(() => conPaso({ duration: "5m", bpm: "90 a 155" })).toThrow(/no válido/);
    expect(() => conPaso({ duration: "5m", bpm: "" })).toThrow(/no válido/);
  });

  it("el ritmo acepta rangos como lista y como texto, y los ordena", () => {
    const lista = conPaso({ duration: "6m", pace: ["5:05/km", "4:55/km"] });
    const texto = conPaso({ duration: "6m", pace: "4:55-5:05/km" });
    for (const paso of [lista, texto]) {
      expect(paso.targetValueOne as number).toBeCloseTo(1000 / 305, 3);
      expect(paso.targetValueTwo as number).toBeCloseTo(1000 / 295, 3);
    }
  });

  it("las zonas van por número, no por valor", () => {
    expect(conPaso({ duration: "5m", zone: "Z2" })).toMatchObject({
      targetType: { workoutTargetTypeKey: "heart.rate.zone" },
      zoneNumber: 2,
    });
    expect(conPaso({ duration: "5m", zone: "Z2" }).targetValueOne).toBeUndefined();
  });

  it("Garmin no tiene Z6 ni Z7, y se dice", () => {
    expect(() => conPaso({ duration: "5m", zone: "Z6" })).toThrow(/Z1…Z5/);
  });

  it("sin objetivo, no.target: el paso existe igual", () => {
    expect(conPaso({ duration: "10m", label: "Suave" })).toMatchObject({
      targetType: { workoutTargetTypeKey: "no.target" },
    });
  });

  it("la cadencia sola es objetivo; acompañada se escribe en el nombre del paso", () => {
    expect(conPaso({ duration: "5m", cadence: 90 })).toMatchObject({
      targetType: { workoutTargetTypeKey: "cadence" },
      targetValueOne: 90,
    });
    const conAmbos = conPaso({ duration: "5m", label: "Rodaje", bpm: 140, cadence: 90 });
    expect(conAmbos.targetType).toMatchObject({ workoutTargetTypeKey: "heart.rate.zone" });
    expect(conAmbos.description).toBe("Rodaje · 90 rpm");
  });

  it("sin umbrales, un porcentaje se rechaza en vez de inventárselo", () => {
    for (const campo of ["power_pct", "hr_pct", "pace_pct"]) {
      expect(() => conPaso({ duration: "5m", [campo]: 80 })).toThrow(/garmin_thresholds/);
    }
  });

  it("una rampa no existe en Garmin, con umbrales o sin ellos", () => {
    expect(() => conPaso({ duration: "5m", ramp: [50, 75] })).toThrow(/no tiene rampas/);
  });
});

describe("lo que no se traga", () => {
  const entreno = (pasos: unknown[], deporte = "Run") =>
    construirEntreno({ nombre: "x", deporte, pasos });

  it("un paso sin duración ni distancia", () => {
    expect(() => entreno([{ label: "flotando" }])).toThrow(/falta la duración/i);
  });

  it("duración y distancia a la vez", () => {
    expect(() => entreno([{ duration: "5m", distance: "1km" }])).toThrow(/no las dos/);
  });

  it("un bloque con 'steps' pero sin 'repeat'", () => {
    expect(() => entreno([{ section: "Bloque", steps: [{ duration: "5m" }] }])).toThrow(
      /sin 'repeat'/,
    );
  });

  it("un 'repeat' sin pasos dentro", () => {
    expect(() => entreno([{ repeat: 4 }])).toThrow(/necesita los 'steps'/);
  });

  it("un deporte que Garmin no conoce", () => {
    expect(() => entreno([{ duration: "5m" }], "quidditch")).toThrow(/no soportado/);
  });

  it("un entreno sin nombre o sin pasos", () => {
    expect(() => construirEntreno({ nombre: "", deporte: "Run", pasos: [{ duration: "5m" }] })).toThrow(
      /nombre/,
    );
    expect(() => entreno([])).toThrow(/al menos un paso/);
  });

  it("acepta los alias en español del proyecto", () => {
    expect(construirEntreno({ nombre: "x", deporte: "bici", pasos: [{ duration: "5m" }] }).entreno
      .sportType).toMatchObject({ sportTypeKey: "cycling" });
    expect(construirEntreno({ nombre: "x", deporte: "natación", pasos: [{ duration: "5m" }] }).entreno
      .sportType).toMatchObject({ sportTypeKey: "swimming" });
  });
});
