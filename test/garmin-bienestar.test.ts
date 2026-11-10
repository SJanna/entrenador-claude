/**
 * Bienestar de Garmin: seis endpoints distintos, cualquiera puede no tener dato.
 *
 * Lo que se vigila aquí es la diferencia entre «ese día no hubo dato» y «no se
 * pudo leer». Confundirlas es lo que hace que un hueco parezca un cero y que el
 * entrenador prescriba sobre un número que nadie midió.
 */

import { describe, expect, it } from "vitest";
import type { GarminCliente } from "../src/garmin/cliente";
import { formatearDias, leerDia, siestasDe } from "../src/garmin/bienestar";
import { GarminTools } from "../src/tools/garminTools";

interface Guion {
  estado?: number;
  cuerpo?: unknown;
  texto?: string;
}

function cliente(guion: Array<[RegExp, Guion]>, atleta = "atleta-guid") {
  const rutas: string[] = [];
  const falso = {
    async atleta() {
      return atleta;
    },
    async api(ruta: string) {
      rutas.push(ruta);
      for (const [patron, respuesta] of guion) {
        if (patron.test(ruta)) {
          const estado = respuesta.estado ?? 200;
          const cuerpo =
            estado === 204
              ? null
              : respuesta.cuerpo === undefined
                ? (respuesta.texto ?? "")
                : JSON.stringify(respuesta.cuerpo);
          return new Response(cuerpo, { status: estado });
        }
      }
      return new Response("", { status: 404 });
    },
  };
  return { rutas, falso: falso as unknown as GarminCliente };
}

const DIA_COMPLETO: Array<[RegExp, Guion]> = [
  [
    /usersummary/,
    {
      cuerpo: {
        totalSteps: 8432,
        restingHeartRate: 48,
        averageStressLevel: 31,
        bodyBatteryHighestValue: 91,
        bodyBatteryLowestValue: 24,
        moderateIntensityMinutes: 20,
        vigorousIntensityMinutes: 10,
      },
    },
  ],
  [
    /dailySleepData/,
    {
      cuerpo: {
        dailySleepDTO: {
          sleepTimeSeconds: 26_400,
          deepSleepSeconds: 5400,
          lightSleepSeconds: 15_000,
          remSleepSeconds: 4800,
          awakeSleepSeconds: 1200,
          averageSpO2Value: 95,
          averageRespirationValue: 13.4,
          sleepScores: { overall: { value: 78, qualifierKey: "good" } },
        },
      },
    },
  ],
  [
    /trainingreadiness/,
    {
      cuerpo: [
        { score: 40, level: "LOW", feedbackShort: "viejo", recoveryTime: 600 },
        { score: 72, level: "MODERATE", feedbackShort: "RECOVERY_GOOD", recoveryTime: 720 },
      ],
    },
  ],
  [/hrv-service/, { cuerpo: { hrvSummary: { lastNightAvg: 62, weeklyAvg: 58, status: "BALANCED" } } }],
  [
    /trainingstatus/,
    {
      cuerpo: {
        mostRecentTrainingStatus: {
          latestTrainingStatusData: {
            "3456789": {
              trainingStatusFeedbackPhrase: "PRODUCTIVE_1",
              acuteTrainingLoadDTO: {
                dailyTrainingLoadAcute: 410,
                dailyTrainingLoadChronic: 380,
                dailyAcuteChronicWorkloadRatio: 1.08,
              },
            },
          },
        },
      },
    },
  ],
  [/maxmet/, { cuerpo: [{ generic: { vo2MaxPreciseValue: 52.4, vo2MaxValue: 52 } }] }],
];

describe("leer un día", () => {
  it("saca cada métrica de donde vive de verdad", async () => {
    const { falso } = cliente(DIA_COMPLETO);
    const dia = await leerDia(falso, "atleta-guid", "2026-09-16");

    expect(dia.fallos).toEqual([]);
    expect(dia).toMatchObject({
      fecha: "2026-09-16",
      pasos: 8432,
      fcReposo: 48,
      estresMedio: 31,
      bodyBatteryAlto: 91,
      bodyBatteryBajo: 24,
      sueñoSegundos: 26_400,
      sueñoProfundo: 5400,
      sueñoPuntuacion: 78,
      sueñoCalidad: "good",
      spo2Medio: 95,
      hrvNoche: 62,
      hrvSemana: 58,
      hrvEstado: "BALANCED",
      estadoEntreno: "PRODUCTIVE_1",
      cargaAguda: 410,
      cargaCronica: 380,
      ratioCarga: 1.08,
      vo2max: 52.4,
    });
  });

  it("de readiness coge la lectura más reciente, no la primera", async () => {
    const { falso } = cliente(DIA_COMPLETO);
    const dia = await leerDia(falso, "atleta-guid", "2026-09-16");
    expect(dia.readiness).toBe(72);
    expect(dia.readinessNivel).toBe("MODERATE");
  });

  it("los minutos de intensidad cuentan doble los vigorosos, como Garmin", async () => {
    const { falso } = cliente(DIA_COMPLETO);
    expect((await leerDia(falso, "a", "2026-09-16")).minutosIntensidad).toBe(20 + 10 * 2);
  });

  it("el displayName va en la ruta, escapado", async () => {
    const { rutas, falso } = cliente(DIA_COMPLETO, "atleta con espacio");
    await leerDia(falso, "atleta con espacio", "2026-09-16");
    expect(rutas.some((r) => r.includes("atleta%20con%20espacio"))).toBe(true);
    expect(rutas).toHaveLength(6);
  });

  it("un 204 o un 404 es «ese día no hubo», no un fallo", async () => {
    const { falso } = cliente([
      [/hrv-service/, { estado: 204 }],
      [/trainingreadiness/, { estado: 404 }],
    ]);
    const dia = await leerDia(falso, "a", "2026-09-16");
    expect(dia.hrvNoche).toBe(null);
    expect(dia.readiness).toBe(null);
    expect(dia.fallos).toEqual([]);
  });

  it("un 500 sí se apunta, y no tumba las demás métricas", async () => {
    const { falso } = cliente([
      ...DIA_COMPLETO.filter(([p]) => !p.test("/hrv-service/hrv/2026-09-16")),
      [/hrv-service/, { estado: 500, texto: "boom" }],
    ]);
    const dia = await leerDia(falso, "a", "2026-09-16");
    expect(dia.fallos).toEqual(["HRV (500)"]);
    expect(dia.hrvNoche).toBe(null);
    expect(dia.pasos).toBe(8432);
    expect(dia.sueñoPuntuacion).toBe(78);
  });

  it("un cuerpo vacío no revienta el día", async () => {
    const { falso } = cliente([[/./, { texto: "" }]]);
    const dia = await leerDia(falso, "a", "2026-09-16");
    expect(dia.fallos).toEqual([]);
    expect(dia.pasos).toBe(null);
  });
});

describe("formato", () => {
  it("una línea por día, y el detalle del día más reciente", async () => {
    const { falso } = cliente(DIA_COMPLETO);
    const dia = await leerDia(falso, "a", "2026-09-16");

    const uno = formatearDias([dia]);
    expect(uno).toContain("2026-09-16");
    expect(uno).toContain("7:20"); // 26 400 s de sueño
    expect(uno).toContain("MODERATE");
    expect(uno).toContain("profundo 1:30");
    expect(uno).toContain("VO₂máx 52.4");

    // Con varios días el detalle sigue estando —prometerlo y no darlo era el
    // fallo— pero dice de qué día es.
    const dos = formatearDias([{ ...dia, fecha: "2026-09-15" }, dia]);
    expect(dos).toContain("2026-09-15");
    expect(dos).toContain("Detalle del 2026-09-16:");
    expect(dos).toContain("VO₂máx 52.4");
  });

  it("la siesta se suma al sueño de la noche, en columna aparte y en el detalle", async () => {
    const { falso } = cliente(DIA_COMPLETO);
    const dia = { ...(await leerDia(falso, "a", "2026-09-16")), siestaSegundos: 2700 };
    const texto = formatearDias([dia]);
    expect(texto).toMatch(/noche\s+siesta\s+total/);
    expect(texto).toMatch(/2026-09-16 .* 7:20 +0:45 +8:05/);
    expect(texto).toContain("Sueño en 24 h: noche 7:20 + siesta 0:45 = 8:05");
  });

  it("sin siesta, el total es la noche y no hay línea de 24 h", async () => {
    const { falso } = cliente(DIA_COMPLETO);
    const dia = await leerDia(falso, "a", "2026-09-16");
    expect(dia.siestaSegundos).toBeNull();
    const texto = formatearDias([dia]);
    expect(texto).toMatch(/2026-09-16 .* 7:20 +— +7:20/);
    expect(texto).not.toContain("Sueño en 24 h");
  });

  it("la siesta se lee de la lista de siestas o, si no está, del total", () => {
    expect(siestasDe({ dailyNapDTOS: [{ napTimeSec: 1200 }, { napTimeSec: 900 }] }, {})).toBe(2100);
    expect(siestasDe({}, { napTimeSeconds: 1800 })).toBe(1800);
    expect(siestasDe({ dailyNapDTOS: [] }, { napTimeSeconds: 0 })).toBeNull();
  });

  it("lo que falta sale como «—», no como cero", async () => {
    const { falso } = cliente([]);
    const texto = formatearDias([await leerDia(falso, "a", "2026-09-16")]);
    expect(texto).toContain("—");
    expect(texto).not.toMatch(/\b0\b/);
  });

  it("los fallos se listan, y se aclara qué significa un hueco", async () => {
    const { falso } = cliente([[/usersummary/, { estado: 500 }]]);
    const texto = formatearDias([await leerDia(falso, "a", "2026-09-16")]);
    expect(texto).toContain("No se pudo leer: resumen diario (500)");
    expect(texto).toContain("no hubo dato");
  });
});

describe("la herramienta", () => {
  const tools = (guion: Array<[RegExp, Guion]>) => {
    const { rutas, falso } = cliente(guion);
    return { rutas, tools: new GarminTools(falso, () => "2026-09-16") };
  };

  it("por defecto, hoy", async () => {
    const { rutas, tools: t } = tools(DIA_COMPLETO);
    const texto = await t.bienestar({});
    expect(texto).toContain("2026-09-16");
    expect(rutas).toHaveLength(6);
  });

  it("varios días, en orden cronológico", async () => {
    const { rutas, tools: t } = tools(DIA_COMPLETO);
    const texto = await t.bienestar({ days: 3 });
    expect(rutas).toHaveLength(18);
    const lineas = texto.split("\n").filter((l) => /^\d{4}-/.test(l));
    expect(lineas.map((l) => l.slice(0, 10))).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
    ]);
  });

  it("pedir un mes no lanza doscientas llamadas: recorta y lo dice", async () => {
    const { rutas, tools: t } = tools(DIA_COMPLETO);
    const texto = await t.bienestar({ days: 30 });
    expect(rutas).toHaveLength(7 * 6);
    expect(texto).toContain("se han traído 7");
    expect(texto).toContain("garmin_wellness_history");
  });

  it("una fecha que no es fecha no sale a Garmin", async () => {
    const { rutas, tools: t } = tools(DIA_COMPLETO);
    expect(await t.bienestar({ date: "el lunes" })).toMatch(/^Error/);
    expect(rutas).toHaveLength(0);
  });
});
