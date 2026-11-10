/**
 * El calendario de Garmin y la lectura de un entreno ya escrito.
 *
 * Esta es la mitad que faltaba: se podía escribir en Garmin y no leer lo
 * escrito. Sin esto, el protocolo de la app mira `list_events`, ve el
 * calendario de intervals vacío y vuelve a escribir la semana entera.
 */

import { describe, expect, it } from "vitest";
import type { GarminCliente } from "../src/garmin/cliente";
import { formatearCalendario, leerCalendario, mesesEntre } from "../src/garmin/calendario";
import { contarPasos, construirEntreno, describirEntreno } from "../src/garmin/entrenos";
import { GarminTools } from "../src/tools/garminTools";

function cliente(porMes: Record<string, unknown>, estados: Record<string, number> = {}) {
  const rutas: string[] = [];
  const falso: { api: (ruta: string) => Promise<Response> } = {
    async api(ruta: string) {
      rutas.push(ruta);
      const clave = ruta.replace("/calendar-service/year/", "").replace("/month/", "-");
      const estado = estados[clave];
      if (estado) return new Response("", { status: estado });
      return new Response(JSON.stringify(porMes[clave] ?? { calendarItems: [] }), { status: 200 });
    },
  };
  return { rutas, falso: falso as unknown as GarminCliente & typeof falso };
}

const ENERO = {
  calendarItems: [
    {
      date: "2026-01-05",
      itemType: "workout",
      title: "Series 4x1k",
      workoutId: 111,
      id: 999,
      sportTypeKey: "running",
      duration: 3600,
    },
    { date: "2026-01-20", itemType: "activity", title: "Rodaje suave", completed: true },
    { date: "2026-01-31", itemType: "workout", title: "Fuera de rango" },
  ],
};

describe("los meses de un rango", () => {
  it("cubre de punta a punta, incluido el mes del final", () => {
    expect(mesesEntre("2026-01-28", "2026-03-02")).toEqual([
      [2026, 1],
      [2026, 2],
      [2026, 3],
    ]);
  });

  it("cruza el fin de año", () => {
    expect(mesesEntre("2026-12-20", "2027-01-05")).toEqual([
      [2026, 12],
      [2027, 1],
    ]);
  });

  it("no se va a pedir años enteros", () => {
    expect(mesesEntre("2026-01-01", "2030-01-01")).toHaveLength(6);
  });
});

describe("leer el calendario", () => {
  it("pide el mes con la numeración de Garmin, que empieza en 0", async () => {
    // Un mes de desfase aquí devuelve un calendario ajeno con toda la pinta de
    // ser el bueno: es el fallo más difícil de ver de todo el módulo.
    const { rutas, falso } = cliente({});
    await leerCalendario(falso, "2026-01-05", "2026-01-20");
    expect(rutas).toEqual(["/calendar-service/year/2026/month/0"]);
  });

  it("se queda solo con lo que cae dentro del rango", async () => {
    const { falso } = cliente({ "2026-0": ENERO });
    const calendario = await leerCalendario(falso, "2026-01-01", "2026-01-25");
    expect(calendario.items.map((i) => i.titulo)).toEqual(["Series 4x1k", "Rodaje suave"]);
  });

  it("saca el id del entreno y el de la programación, que no son el mismo", async () => {
    const { falso } = cliente({ "2026-0": ENERO });
    const [primero] = (await leerCalendario(falso, "2026-01-01", "2026-01-25")).items;
    expect(primero).toMatchObject({
      fecha: "2026-01-05",
      tipo: "workout",
      workoutId: 111,
      scheduleId: 999,
      deporte: "running",
      duracionSegundos: 3600,
      completado: false,
    });
  });

  it("un mes roto se apunta y los demás siguen", async () => {
    const { falso } = cliente({ "2026-1": { calendarItems: [{ date: "2026-02-03", title: "Vive" }] } },
      { "2026-0": 500 });
    const calendario = await leerCalendario(falso, "2026-01-01", "2026-02-28");
    expect(calendario.fallos).toEqual(["2026-01 (500)"]);
    expect(calendario.items).toHaveLength(1);
  });

  it("el vacío se dice; el otro calendario solo se recuerda si hay intervals", async () => {
    const { falso } = cliente({});
    const cal = await leerCalendario(falso, "2026-01-01", "2026-01-07");
    const solo = formatearCalendario(cal, "2026-01-01", "2026-01-07");
    expect(solo).toContain("está vacío");
    expect(solo).not.toContain("list_events");
    const conIntervals = formatearCalendario(cal, "2026-01-01", "2026-01-07", false, true);
    expect(conIntervals).toContain("NO se ve en list_events");
  });
});

describe("la herramienta del calendario", () => {
  it("por defecto mira desde hoy y dos semanas", async () => {
    const { rutas, falso } = cliente({});
    const tools = new GarminTools(falso, () => "2026-09-16");
    const texto = await tools.calendario({});
    expect(texto).toContain("2026-09-16");
    expect(texto).toContain("2026-09-29");
    expect(rutas).toEqual(["/calendar-service/year/2026/month/8"]);
  });

  it("un rango al revés se dice, no se adivina", async () => {
    const { falso } = cliente({});
    const tools = new GarminTools(falso, () => "2026-09-16");
    expect(await tools.calendario({ from: "2026-09-20", to: "2026-09-10" })).toMatch(/^Error/);
  });
});

describe("contar pasos", () => {
  it("distingue bloques, pasos escritos y pasos que ejecuta el reloj", () => {
    const { entreno } = construirEntreno({
      nombre: "x",
      deporte: "Run",
      pasos: [
        { duration: "15m", intensity: "warmup" },
        { repeat: 4, steps: [{ distance: "1km" }, { duration: "90s" }] },
        { duration: "10m", intensity: "cooldown" },
      ],
    });
    const pasos = entreno.workoutSegments[0]!.workoutSteps as unknown[];
    // Tres bloques plegados, cuatro pasos escritos, diez en el reloj.
    expect(contarPasos(pasos)).toEqual({ bloques: 3, pasos: 4, desplegados: 10 });
  });
});

describe("leer un entreno escrito", () => {
  const { entreno } = construirEntreno({
    nombre: "Series 4x1k",
    deporte: "Run",
    pasos: [
      { label: "Calentamiento", duration: "15m", intensity: "warmup" },
      { repeat: 4, steps: [{ label: "Serie", distance: "1km", pace: "4:00/km" }] },
      { duration: "10m", intensity: "cooldown" },
    ],
  });

  it("enseña cada paso con su objetivo y su etiqueta", () => {
    const texto = describirEntreno({ ...entreno, workoutId: 77 });
    expect(texto).toContain("«Series 4x1k»");
    expect(texto).toContain("id 77");
    expect(texto).toContain("calentamiento");
    expect(texto).toContain("«Calentamiento»");
    expect(texto).toContain("repetir ×4");
    expect(texto).toContain("1.00 km");
    // El ritmo se guardó como velocidad con un ±2 % para que el reloj no pite
    // sin parar, así que al leerlo vuelve como una horquilla alrededor de 4:00.
    expect(texto).toMatch(/3:5\d\/km–4:0\d\/km/);
  });

  it("señala el paso sin nombre propio, que en el reloj sale genérico", () => {
    expect(describirEntreno(entreno)).toContain("(sin etiqueta)");
  });

  it("cuenta los pasos, porque la duración no delata uno perdido", () => {
    // Un paso con botón de vuelta aporta 0 s: si se descarta en silencio, los
    // minutos cuadran igual. Solo el recuento lo caza.
    const { entreno: conBoton } = construirEntreno({
      nombre: "y",
      deporte: "Run",
      pasos: [{ duration: "10m" }, { lap_press: true, label: "Hasta que pites" }, { duration: "5m" }],
    });
    const texto = describirEntreno(conBoton);
    expect(texto).toContain("3 pasos escritos");
    expect(texto).toContain("botón de vuelta");
    expect(conBoton.estimatedDurationInSecs).toBe(900);
  });

  it("lo que no es un entreno se dice, no se pinta a medias", () => {
    expect(() => describirEntreno("nada")).toThrow(/legible/);
  });
});


/**
 * Lo que apareció al mirar el calendario de verdad, el 16/09/2026. Ninguno de
 * estos casos se veía con datos inventados, y los tres son de la misma familia:
 * un número o una etiqueta que parecen correctos y no lo son.
 */
describe("lo que enseñó el calendario real", () => {
  const item = async (bruto: Record<string, unknown>) => {
    const { falso } = cliente({ "2026-8": { calendarItems: [{ date: "2026-09-10", ...bruto }] } });
    const calendario = await leerCalendario(falso, "2026-09-01", "2026-09-30");
    return calendario.items[0]!;
  };

  it("la duración de una actividad viene en milisegundos", async () => {
    // Un paseo de 1h12 salía como «1202h10»: absurdo, pero un número.
    expect((await item({ itemType: "activity", duration: 4_327_200 })).duracionSegundos).toBe(4327);
  });

  it("pero la de una siesta viene en segundos, y no se toca", async () => {
    expect((await item({ itemType: "nap", duration: 7140 })).duracionSegundos).toBe(7140);
  });

  it("el deporte de una actividad no está donde el de un entreno", async () => {
    // Salía «—» en las 40 actividades del mes y sí en los entrenos.
    expect((await item({ itemType: "activity", activityType: { typeKey: "running" } })).deporte)
      .toBe("running");
    expect((await item({ itemType: "workout", sportTypeKey: "strength_training" })).deporte)
      .toBe("strength_training");
  });

  it("en una actividad, el id del item es de la actividad, no de una cita", async () => {
    // Enseñarlo como «programación» manda a desprogramar algo que ya pasó.
    const actividad = await item({ itemType: "activity", id: 24198280150 });
    expect(actividad).toMatchObject({ activityId: 24198280150, scheduleId: null });

    const entreno = await item({ itemType: "workout", id: 1776582737, workoutId: 1697091641 });
    expect(entreno).toMatchObject({ scheduleId: 1776582737, workoutId: 1697091641 });
  });

  it("un id de tipo crudo es mejor que un guion, y que un nombre inventado", async () => {
    // Las actividades no traen el nombre del deporte, solo un id numérico.
    // Sin nadie a quien preguntar, traducirlo sería adivinar.
    expect((await item({ itemType: "activity", activityTypeId: 13 })).deporte).toBe("tipo 13");
  });

  it("pero si se le puede preguntar a Garmin, se le pregunta", async () => {
    // La lista de actividades sí trae el deporte: se cruza por id en vez de
    // traducir el número por nuestra cuenta.
    const { rutas, falso } = cliente({
      "2026-8": {
        calendarItems: [
          { date: "2026-09-14", itemType: "activity", id: 24364478822, activityTypeId: 13 },
        ],
      },
    });
    const original = falso.api.bind(falso);
    falso.api = async (ruta: string) => {
      if (ruta.includes("activitylist")) {
        rutas.push(ruta);
        return new Response(
          JSON.stringify([
            {
              activityId: 24364478822,
              activityName: "Terapia",
              activityType: { typeKey: "strength_training" },
            },
          ]),
          { status: 200 },
        );
      }
      return original(ruta);
    };
    const calendario = await leerCalendario(falso, "2026-09-01", "2026-09-30");
    expect(calendario.items[0]!.deporte).toBe("strength_training");
    expect(rutas.some((r) => r.includes("activitylist"))).toBe(true);
  });

  it("si la lista de actividades falla, se queda el id crudo", async () => {
    const { falso } = cliente({
      "2026-8": {
        calendarItems: [
          { date: "2026-09-14", itemType: "activity", id: 1, activityTypeId: 13 },
        ],
      },
    });
    const original = falso.api.bind(falso);
    falso.api = async (ruta: string) => {
      if (ruta.includes("activitylist")) return new Response("", { status: 500 });
      return original(ruta);
    };
    expect((await leerCalendario(falso, "2026-09-01", "2026-09-30")).items[0]!.deporte)
      .toBe("tipo 13");
  });

  it("sin actividades que completar no se pide la lista", async () => {
    const { rutas, falso } = cliente({
      "2026-8": {
        calendarItems: [
          { date: "2026-09-15", itemType: "workout", sportTypeKey: "running", id: 1 },
        ],
      },
    });
    await leerCalendario(falso, "2026-09-01", "2026-09-30");
    expect(rutas.some((r) => r.includes("activitylist"))).toBe(false);
  });

  it("el diagnóstico enseña las claves, nunca los valores", async () => {
    const { falso } = cliente({
      "2026-8": {
        calendarItems: [
          {
            date: "2026-09-10",
            itemType: "activity",
            activityTypeId: 1,
            title: "Carrera secreta del atleta",
          },
        ],
      },
    });
    const calendario = await leerCalendario(falso, "2026-09-01", "2026-09-30");
    const texto = formatearCalendario(calendario, "2026-09-01", "2026-09-30", true);
    expect(texto).toContain("activity: activityTypeId, date, itemType, title");
    // El título aparece en la tabla, pero el diagnóstico no vuelca más valores.
    expect(texto.split("Claves que trae Garmin")[1]).not.toContain("secreta");
  });

  it("sin diagnóstico no se enseñan las claves", async () => {
    const { falso } = cliente({ "2026-8": { calendarItems: [{ date: "2026-09-10" }] } });
    const calendario = await leerCalendario(falso, "2026-09-01", "2026-09-30");
    expect(formatearCalendario(calendario, "2026-09-01", "2026-09-30")).not.toContain("Claves que");
  });

  it("el deporte no se corta a mitad de palabra", async () => {
    const { falso } = cliente({
      "2026-8": {
        calendarItems: [
          { date: "2026-09-10", itemType: "workout", sportTypeKey: "strength_training", title: "x" },
        ],
      },
    });
    const texto = formatearCalendario(
      await leerCalendario(falso, "2026-09-01", "2026-09-30"),
      "2026-09-01",
      "2026-09-30",
    );
    expect(texto).toContain("strength_training");
    expect(texto).not.toContain("strength_tra ");
  });
});
