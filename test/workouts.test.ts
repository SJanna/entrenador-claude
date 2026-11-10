/**
 * Sintaxis de entrenos: mismos casos que el test_offline.py del proyecto
 * original, para garantizar paridad exacta del port.
 */

import { describe, expect, it } from "vitest";
import {
  WorkoutSpecError,
  avisoDeDuracion,
  avisoDePasos,
  contarEnviados,
  contarInterpretados,
  normalizeSport,
  renderWorkoutText,
} from "../src/intervals/workouts";

describe("renderWorkoutText", () => {
  it("bloques, repeticiones y texto libre", () => {
    const text = renderWorkoutText(
      [
        { section: "Calentamiento", steps: [{ duration: "15m", zone: "Z2", zone_kind: "hr" }] },
        {
          section: "Series",
          repeat: 5,
          steps: [
            { distance: "1km", pace_pct: [103, 107] },
            { duration: 120, zone: "Z1", zone_kind: "hr" },
          ],
        },
        { section: "Vuelta a la calma", steps: [{ duration: "10m", free: true }] },
      ],
      "Objetivo: ritmo de 10 km.",
    );
    expect(text).toBe(
      "Calentamiento\n- 15m Z2 HR\n\n" +
        "Series 5x\n- 1km 103-107% pace\n- 2m Z1 HR\n\n" +
        "Vuelta a la calma\n- 10m free\n\n" +
        "Objetivo: ritmo de 10 km.",
    );
  });

  it("metros en 'mtr' (en intervals.icu 'm' son minutos)", () => {
    expect(renderWorkoutText([{ distance: 400, pace_pct: 110 }])).toBe("- 400mtr 110% pace");
  });

  it("distancia '400m' se normaliza a metros", () => {
    expect(renderWorkoutText([{ distance: "400m", free: true }])).toBe("- 400mtr free");
  });

  it("ritmo absoluto lleva la palabra 'pace'", () => {
    expect(renderWorkoutText([{ duration: "20m", pace: "5:00/km" }])).toBe("- 20m 5:00/km pace");
  });

  it("vatios, cadencia, aviso, intensidad y descanso", () => {
    expect(
      renderWorkoutText([
        {
          label: "Fuerza",
          duration: "3m",
          watts: [240, 260],
          cadence: 60,
          intensity: "active",
          rest: "90s",
        },
      ]),
    ).toBe("- Fuerza 3m 240-260w 60rpm intensity=active 90s rest");
  });

  it("rampa", () => {
    expect(renderWorkoutText([{ duration: "10m", ramp: [50, 75] }])).toBe("- 10m ramp 50-75%");
  });

  it("segundos numéricos → 1h30m", () => {
    expect(renderWorkoutText([{ duration: 5400, power_pct: 65 }])).toBe("- 1h30m 65%");
  });

  it("target con ritmo absoluto gana la palabra 'pace'", () => {
    expect(renderWorkoutText([{ duration: "5m", target: "4:30/km" }])).toBe("- 5m 4:30/km pace");
  });

  const invalidos: Array<[string, unknown[]]> = [
    ["paso sin duración ni distancia", [{ power_pct: 80 }]],
    ["duración y distancia a la vez", [{ duration: "5m", distance: "1km" }]],
    ["repeat sin steps", [{ repeat: 4 }]],
    ["clave inventada", [{ duration: "5m", potencia: 200 }]],
    ["zona inválida", [{ duration: "5m", zone: "X9" }]],
    ["ritmo absoluto mal escrito", [{ duration: "5m", pace: "rápido" }]],
  ];
  for (const [nombre, steps] of invalidos) {
    it(`error claro: ${nombre}`, () => {
      expect(() => renderWorkoutText(steps)).toThrow(WorkoutSpecError);
    });
  }
});

describe("normalizeSport", () => {
  it("acepta español e inglés", () => {
    expect(normalizeSport("correr")).toBe("Run");
    expect(normalizeSport("bici")).toBe("Ride");
    expect(normalizeSport("fuerza")).toBe("WeightTraining");
    expect(normalizeSport("natación")).toBe("Swim");
    expect(normalizeSport("Run")).toBe("Run");
    expect(normalizeSport("AlgoRaro")).toBe("AlgoRaro");
  });
});

describe("verificar lo que intervals.icu interpreta", () => {
  // Tres veces ha escrito el sistema un entreno que no era el enviado, y las
  // tres respondio OK: R030 (pasos descartados), R034 (pasos fabricados desde
  // la descripcion) y R042 (duracion disparada por un label). Esto es lo que
  // los caza. Y lo primero es que NO de falsas alarmas: un aviso que salta sin
  // motivo se ignora, y el dia que importe tambien se ignorara.

  it("lap_press deja de perderse en silencio y manda a la via que si lo soporta", () => {
    expect(() => renderWorkoutText([{ lap_press: true, label: "Hasta que pites" }])).toThrow(
      WorkoutSpecError,
    );
    expect(() => renderWorkoutText([{ lap_press: true }])).toThrow(/garmin_create_workout/);
  });

  it("cuenta lo enviado con y sin desplegar las series, y suma los segundos", () => {
    const enviado = contarEnviados([
      { duration: "10m", hr_pct: 65 },
      { section: "Series", repeat: 4, steps: [{ duration: "3m", hr_pct: 90 }, { duration: "2m" }] },
      { duration: "5m" },
    ]);
    expect(enviado.hojas).toBe(4);
    expect(enviado.desplegados).toBe(10);
    expect(enviado.segundos).toBe(600 + 4 * (180 + 120) + 300);
  });

  it("un paso por distancia deja la suma en null: no se inventa un total", () => {
    expect(contarEnviados([{ duration: "10m" }, { distance: "400mtr" }]).segundos).toBeNull();
  });

  it("el 'rest' cuenta como tiempo ejecutado y como paso que intervals puede separar", () => {
    const enviado = contarEnviados([{ duration: "3m", rest: "1m" }]);
    expect(enviado.segundos).toBe(240);
    expect(enviado.conRest).toBe(1);
  });

  it("lee el workout_doc esté anidado o desplegado", () => {
    expect(contarInterpretados({ steps: [{ duration: 600 }, { duration: 300 }] })).toEqual({
      hojas: 2,
      desplegados: 2,
    });
    expect(
      contarInterpretados({ steps: [{ reps: 4, steps: [{ duration: 180 }, { duration: 120 }] }] }),
    ).toEqual({ hojas: 2, desplegados: 8 });
    expect(contarInterpretados({ nada: 1 })).toBeNull();
  });

  it("NO avisa cuando lo interpretado cabe en alguna lectura de lo enviado", () => {
    const enviado = contarEnviados([
      { duration: "10m" },
      { section: "Series", repeat: 4, steps: [{ duration: "3m", rest: "1m" }] },
    ]);
    // Anidado (2 hojas), desplegado (5), y con los rest separados (9): las tres valen.
    for (const visto of [
      { hojas: 2, desplegados: 2 },
      { hojas: 5, desplegados: 5 },
      { hojas: 9, desplegados: 9 },
    ]) {
      expect(avisoDePasos(enviado, visto)).toBeNull();
    }
    expect(avisoDePasos(enviado, null)).toBeNull();
  });

  it("avisa cuando faltan pasos (R030) y cuando sobran (R034)", () => {
    const enviado = contarEnviados([{ duration: "10m" }, { duration: "5m" }, { duration: "5m" }]);
    expect(avisoDePasos(enviado, { hojas: 1, desplegados: 1 })).toMatch(/FALTAN PASOS/);
    expect(avisoDePasos(enviado, { hojas: 1, desplegados: 1 })).toMatch(/R030/);
    expect(avisoDePasos(enviado, { hojas: 9, desplegados: 9 })).toMatch(/SOBRAN PASOS/);
    expect(avisoDePasos(enviado, { hojas: 9, desplegados: 9 })).toMatch(/R034/);
  });

  it("caza la duración disparada de R042, y calla si solo baila un minuto", () => {
    // El caso real del 27/08: pasos correctos, duración de 2h10 a 18h50.
    const enviado = contarEnviados([{ duration: "2h10m", hr_pct: 65 }]);
    expect(avisoDeDuracion(enviado, 18 * 3600 + 50 * 60)).toMatch(/R042/);
    expect(avisoDeDuracion(enviado, 2 * 3600 + 10 * 60)).toBeNull();
    expect(avisoDeDuracion(enviado, 2 * 3600 + 11 * 60)).toBeNull();
    // Sin suma fiable no se opina.
    expect(avisoDeDuracion(contarEnviados([{ distance: "5km" }]), 99999)).toBeNull();
  });
});

describe("lecciones de R034 que ahora hace cumplir el servidor", () => {
  it("rechaza una etiqueta con letra pegada a número (H10)", () => {
    expect(() =>
      renderWorkoutText([{ duration: "10m", label: "Con H10 puesta" }]),
    ).toThrow(/letra pegada/);
  });

  it("acepta la misma idea escrita en palabras", () => {
    expect(() =>
      renderWorkoutText([{ duration: "10m", label: "Con banda de pecho" }]),
    ).not.toThrow();
  });

  it("rechaza una línea de descripción que empieza por guion", () => {
    expect(() =>
      renderWorkoutText([{ duration: "10m", label: "Suave" }], "Nutrición:\n- agua y sales"),
    ).toThrow(/guion/);
  });

  it("rechaza un token de duración pegado en la descripción", () => {
    expect(() =>
      renderWorkoutText([{ duration: "10m", label: "Suave" }], "Camina 15m al final"),
    ).toThrow(/duración/);
  });

  it("sin pasos, la descripción es sintaxis de intervals y no se vigila", () => {
    expect(() => renderWorkoutText([], "- 10m Z2 Suave")).not.toThrow();
  });

  it("deja pasar la prosa normal con números separados", () => {
    expect(() =>
      renderWorkoutText(
        [{ duration: "10m", label: "Suave" }],
        "Antes: 500 ml de agua con sales 30-45 min antes. Ritmo 5:00/km. Techo 165 ppm.",
      ),
    ).not.toThrow();
  });
});
