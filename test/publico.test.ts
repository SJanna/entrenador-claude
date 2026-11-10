/**
 * La página pública: el cálculo de los agregados y la lista blanca.
 *
 * Lo que fijan estos tests es lo que no se puede ver mirando la página: que una
 * semana planificada no se reescribe con el real, que hacer de más cuenta como
 * cumplida, y que nada fuera de la lista blanca llega a publicarse.
 */

import { describe, expect, it } from "vitest";
import {
  calcularProgreso,
  categoriaDe,
  categoriaIntervals,
  emparejar,
  EXPONENTE_RIEGEL,
  prediccion,
  pulsoFijo,
  zonasDe,
  erroresTemporadas,
  motivoCongelado,
  rachaSemanas,
  type ActividadKm,
  type EntradaProgreso,
  type SemanaPublica,
  type Temporada,
} from "../src/publico/compute";
import { erroresPublicos } from "../src/publico/esquema";
import { tramosCalendario } from "../src/publico/servicio";

const TEMPORADAS: Temporada[] = [
  { numero: 0, nombre: "Prólogo", desde: "2026-11-03", hasta: "2026-12-13" },
  { numero: 1, nombre: "Base", desde: "2026-12-14", hasta: "2027-02-28" },
  { numero: 2, nombre: "Durabilidad", desde: "2027-03-01", hasta: "2027-05-31" },
  { numero: 3, nombre: "Específica", desde: "2027-06-01", hasta: "2027-07-31" },
  { numero: 4, nombre: "Día D", desde: "2027-08-01", hasta: "2027-08-21" },
];

function run(fecha: string, km: number, tipo = "Run"): ActividadKm {
  return { fecha, tipo, km };
}

function entrada(parcial: Partial<EntradaProgreso> = {}): EntradaProgreso {
  return {
    hoy: "2026-12-30",
    generado: "2026-12-30T08:00:00.000Z",
    diaD: "2027-08-21",
    temporadas: TEMPORADAS,
    actividades: [],
    plan: [],
    hitosManuales: [],
    programadas: [],
    cumplimientoHasta: "2026-12-29",
    ...parcial,
  };
}

function semana(r: ReturnType<typeof calcularProgreso>, lunes: string) {
  const s = r.semanas.find((x) => x.lunes === lunes);
  if (!s) throw new Error(`falta la semana ${lunes}`);
  return s;
}

describe("km por semana", () => {
  it("suma Run, TrailRun y VirtualRun; deja fuera caminatas y bici", () => {
    const r = calcularProgreso(
      entrada({
        actividades: [
          run("2026-12-14", 10),
          run("2026-12-15", 16, "TrailRun"),
          run("2026-12-16", 5, "VirtualRun"),
          run("2026-12-16", 4, "Walk"),
          run("2026-12-17", 6, "Hike"),
          run("2026-12-18", 40, "Ride"),
        ],
      }),
    );
    expect(semana(r, "2026-12-14").km).toBe(31);
    expect(semana(r, "2026-12-14").km_max).toBe(16);
  });

  it("empieza en la semana de la T0 sin contar lo anterior a su primer día", () => {
    // La T0 empieza en martes: el lunes 02/11 es antes del episodio 0.
    const r = calcularProgreso(entrada({ actividades: [run("2026-11-02", 8), run("2026-11-03", 5)] }));
    expect(r.semanas[0]!.lunes).toBe("2026-11-02");
    expect(r.semanas[0]!.km).toBe(5);
    expect(r.semanas[0]!.temporada).toBe(0);
  });

  it("enseña el plan tal como quedó, y null si la semana no lo tenía", () => {
    const r = calcularProgreso(entrada({ plan: [{ lunes: "2026-12-14", km: 30 }] }));
    expect(semana(r, "2026-12-14").km_plan).toBe(30);
    expect(semana(r, "2026-12-21").km_plan).toBeNull();
  });

  it("marca la semana en curso y no pasa de hoy", () => {
    const r = calcularProgreso(entrada());
    const ultima = r.semanas[r.semanas.length - 1]!;
    expect(ultima.lunes).toBe("2026-12-28");
    expect(ultima.en_curso).toBe(true);
    expect(semana(r, "2026-12-21").en_curso).toBe(false);
  });

  it("antes de la T0 no hay semanas, pero sí cuenta atrás", () => {
    const r = calcularProgreso(entrada({ hoy: "2026-10-22" }));
    expect(r.semanas).toEqual([]);
    expect(r.dia_d).toEqual({ fecha: "2027-08-21", dias: 303 });
    expect(r.temporada_actual).toBeNull();
  });
});

describe("tirada larga e hitos", () => {
  const historico = [run("2026-01-31", 31.1), run("2026-01-28", 28), run("2026-11-29", 25.5, "TrailRun")];

  it("la referencia es lo mejor de antes de la T1", () => {
    const r = calcularProgreso(entrada({ actividades: historico }));
    expect(r.referencia).toEqual({ km: 31.1, fecha: "2026-01-31" });
    expect(r.hitos[0]!.etiqueta).toBe("Más de 31,1 km");
    // La tirada larga es la de la serie pública (desde la T0), no la histórica.
    expect(r.tirada_larga).toEqual({ km: 25.5, fecha: "2026-11-29" });
  });

  it("un hito cae con la primera actividad que lo alcanza desde la T1", () => {
    const r = calcularProgreso(
      entrada({
        hoy: "2027-04-01",
        actividades: [...historico, run("2027-01-10", 31.1), run("2027-01-24", 33.4), run("2027-03-14", 42.3)],
      }),
    );
    const por = Object.fromEntries(r.hitos.map((h) => [h.clave, h]));
    // Igualar la marca no es superarla.
    expect(por.supera_referencia).toMatchObject({ fecha: "2027-01-24", km: 33.4, manual: false });
    expect(por.maraton).toMatchObject({ fecha: "2027-03-14", km: 42.3 });
    expect(por.km50!.fecha).toBeNull();
    expect(por.noche!.fecha).toBeNull();
  });

  it("lo hecho en la T0 no hace caer hitos", () => {
    const r = calcularProgreso(entrada({ actividades: [...historico, run("2026-12-01", 43)] }));
    expect(r.hitos.find((h) => h.clave === "maraton")!.fecha).toBeNull();
    // …pero sí sube la referencia, porque es marca previa a la T1.
    expect(r.referencia!.km).toBe(43);
  });

  it("un hito manual manda sobre el GPS", () => {
    const r = calcularProgreso(
      entrada({
        hoy: "2027-04-01",
        actividades: [...historico, run("2027-03-14", 42.1)],
        hitosManuales: [
          { clave: "maraton", fecha: "2027-03-14" },
          { clave: "noche", fecha: "2027-02-02" },
        ],
      }),
    );
    const por = Object.fromEntries(r.hitos.map((h) => [h.clave, h]));
    expect(por.maraton).toMatchObject({ fecha: "2027-03-14", manual: true });
    expect(por.noche).toMatchObject({ fecha: "2027-02-02", manual: true });
  });
});

describe("racha de semanas", () => {
  const s = (km: number, en_curso = false): SemanaPublica => ({
    lunes: "x", temporada: 1, km, km_plan: null, km_max: km, programadas: 0, cumplidas: 0, en_curso,
  });

  it("una semana a cero la rompe", () => {
    expect(rachaSemanas([s(10), s(20), s(0), s(5), s(8)])).toEqual({ actual: 2, mejor: 2 });
    expect(rachaSemanas([s(174), s(0), s(0), s(0)])).toEqual({ actual: 0, mejor: 1 });
  });

  it("la semana en curso suma si ya tiene km y no rompe si aún no", () => {
    expect(rachaSemanas([s(10), s(20), s(0, true)])).toEqual({ actual: 2, mejor: 2 });
    expect(rachaSemanas([s(10), s(20), s(3, true)])).toEqual({ actual: 3, mejor: 3 });
  });
});

describe("cumplimiento", () => {
  it("cuenta por semana y separa lo de la T1", () => {
    const r = calcularProgreso(
      entrada({
        programadas: [
          { fecha: "2026-12-08", cumplida: true },
          { fecha: "2026-12-09", cumplida: false },
          { fecha: "2026-12-15", cumplida: true },
          { fecha: "2026-12-16", cumplida: true },
          { fecha: "2026-12-17", cumplida: false },
        ],
      }),
    );
    expect(semana(r, "2026-12-07")).toMatchObject({ programadas: 2, cumplidas: 1 });
    expect(r.cumplimiento.total).toEqual({ programadas: 5, cumplidas: 3, pct: 60 });
    expect(r.cumplimiento.desde_t1).toEqual({ programadas: 3, cumplidas: 2, pct: 67 });
    expect(r.cumplimiento.hasta).toBe("2026-12-29");
  });

  it("las sesiones de hoy no cuentan todavía", () => {
    const r = calcularProgreso(
      entrada({ programadas: [{ fecha: "2026-12-29", cumplida: true }, { fecha: "2026-12-30", cumplida: false }] }),
    );
    expect(r.cumplimiento.total).toEqual({ programadas: 1, cumplidas: 1, pct: 100 });
  });

  it("antes de la T1 no hay % de la T1, y sin sesiones no hay % (no un 0)", () => {
    const r = calcularProgreso(entrada({ hoy: "2026-11-20" }));
    expect(r.cumplimiento.desde_t1).toBeNull();
    expect(r.cumplimiento.total.pct).toBeNull();
  });
});

describe("qué sesiones cuentan", () => {
  it("carrera, fuerza y natación; terapia y caminatas no", () => {
    expect(categoriaDe("running", "Rodaje 40 min techo 165")).toBe("carrera");
    expect(categoriaDe("trail_running", "Sierra Trail running")).toBe("carrera");
    expect(categoriaDe("strength_training", "Fuerza piernas · semana uno (casa)")).toBe("fuerza");
    expect(categoriaDe("lap_swimming", "Natación en piscina")).toBe("natacion");
    expect(categoriaDe("swimming", "Natación · clase con profesor (piscina)")).toBe("natacion");
    expect(categoriaDe("strength_training", "Terapia tobillo y tronco (casa)")).toBeNull();
    expect(categoriaDe("strength_training", "Colgado sin apoyo 3x10 s · nivel uno (parque)")).toBeNull();
    // Hay caminatas guardadas como running en Garmin.
    expect(categoriaDe("running", "Caminata de recuperacion 20 min (barrio)")).toBeNull();
    expect(categoriaDe("other", "Caminata 20 min (barrio)")).toBeNull();
    expect(categoriaDe("yoga", "Descarga femorales")).toBeNull();
    expect(categoriaDe("cycling", "Bici 60 min")).toBeNull();
  });
});

describe("emparejar plan y actividades", () => {
  const p = (id: string, minutos: number | null, categoria: "carrera" | "fuerza" = "carrera") => ({
    id, fecha: "2026-10-18", categoria, segundos: minutos === null ? null : minutos * 60,
  });
  const h = (minutos: number, categoria: "carrera" | "fuerza" = "carrera") => ({
    fecha: "2026-10-18", categoria, segundos: minutos * 60,
  });

  it("con la mitad de la duración basta, y hacer de más cuenta", () => {
    expect([...emparejar([p("a", 40)], [h(20)])]).toEqual(["a"]);
    expect([...emparejar([p("a", 40)], [h(19)])]).toEqual([]);
    // Trail: 40 min programados, 3h10 hechas.
    expect([...emparejar([p("a", 40)], [h(190)])]).toEqual(["a"]);
  });

  it("cada actividad cubre una sola sesión, y se cubren todas las posibles", () => {
    // Una larga y una corta hechas; programadas una larga y una corta. Si la
    // corta se llevara la actividad larga, la larga quedaría sin cubrir.
    expect(emparejar([p("larga", 71), p("corta", 30)], [h(60), h(16)]).size).toBe(2);
    expect([...emparejar([p("a", 30), p("b", 30)], [h(60)])]).toHaveLength(1);
  });

  it("otro deporte u otro día no cumplen", () => {
    expect(emparejar([p("a", 30)], [h(60, "fuerza")]).size).toBe(0);
    expect(emparejar([p("a", 30)], [{ ...h(60), fecha: "2026-10-19" }]).size).toBe(0);
  });

  it("sin duración conocida, cualquier actividad de ese deporte vale", () => {
    expect(emparejar([p("a", null)], [h(5)]).size).toBe(1);
  });
});

describe("el plan se congela el lunes", () => {
  it("antes del lunes se cambia; el lunes solo si no había plan; luego nunca", () => {
    expect(motivoCongelado("2026-12-14", "2026-12-13", true)).toBeNull();
    expect(motivoCongelado("2026-12-14", "2026-12-14", false)).toBeNull();
    expect(motivoCongelado("2026-12-14", "2026-12-14", true)).toMatch(/congeló hoy/);
    expect(motivoCongelado("2026-12-14", "2026-12-15", false)).toMatch(/congelada/);
  });
});

describe("temporadas", () => {
  it("las de la migración son válidas", () => {
    expect(erroresTemporadas(TEMPORADAS, "2027-08-21")).toEqual([]);
  });

  it("el día D cae en fin de semana y la T4 acaba ese día", () => {
    expect(erroresTemporadas(TEMPORADAS, "2027-08-20").join()).toMatch(/sábado o domingo/);
    expect(erroresTemporadas(TEMPORADAS, "2027-08-22").join()).toMatch(/T4 tiene que acabar/);
  });

  it("sin huecos ni solapes entre temporadas", () => {
    const movida = TEMPORADAS.map((t) => (t.numero === 2 ? { ...t, desde: "2027-03-08" } : t));
    expect(erroresTemporadas(movida, "2027-08-21").join()).toMatch(/T2 tiene que empezar/);
  });
});

describe("tramos del calendario de Garmin", () => {
  it("parte un rango largo en bloques de seis meses naturales", () => {
    expect(tramosCalendario("2026-11-03", "2027-08-21")).toEqual([
      ["2026-11-03", "2027-04-30"],
      ["2027-05-01", "2027-08-21"],
    ]);
    expect(tramosCalendario("2026-12-01", "2026-12-20")).toEqual([["2026-12-01", "2026-12-20"]]);
  });
});

describe("ayer, la semana día a día y los totales", () => {
  const ses = (fecha: string, tipo: string, km: number, extra: Partial<ActividadKm> = {}): ActividadKm => ({
    fecha, tipo, km, categoria: categoriaIntervals(tipo, ""), segundos: 3000, fcMedia: 151.6, fcMax: 171, temp: 31.24, ...extra,
  });

  it("ayer sale sesión a sesión, con ritmo, pulso y temperatura; hoy no", () => {
    const r = calcularProgreso(
      entrada({
        hoy: "2026-12-30",
        actividades: [
          ses("2026-12-29", "Run", 8),
          ses("2026-12-29", "WeightTraining", 0, { segundos: 1500, fcMedia: null, fcMax: null, temp: null }),
          ses("2026-12-30", "Run", 20),
        ],
      }),
    );
    expect(r.ayer).toEqual({
      fecha: "2026-12-29",
      sesiones: [
        { deporte: "carrera", km: 8, segundos: 3000, ritmo: 375, fc_media: 152, fc_max: 171, temp: 31.2 },
        { deporte: "fuerza", km: null, segundos: 1500, ritmo: null, fc_media: null, fc_max: null, temp: null },
      ],
    });
    expect(r.totales).toEqual({ km: 8, horas: 1.3, sesiones: 2, desde: "2026-11-03" });
  });

  it("caminatas, terapia y otros deportes no son sesiones (pero los km de carrera cuentan)", () => {
    const r = calcularProgreso(
      entrada({
        actividades: [
          { ...ses("2026-12-29", "Walk", 4), categoria: categoriaIntervals("Walk", "Caminata") },
          { ...ses("2026-12-29", "WeightTraining", 0), categoria: categoriaIntervals("WeightTraining", "Terapia tobillo") },
          { ...ses("2026-12-29", "Ride", 30), categoria: categoriaIntervals("Ride", "Bici") },
        ],
      }),
    );
    expect(r.ayer?.sesiones).toEqual([]);
    expect(r.totales?.sesiones).toBe(0);
  });

  it("la semana va del lunes a ayer, con km de carrera y los deportes de cada día", () => {
    const r = calcularProgreso(
      entrada({
        hoy: "2026-12-31",
        actividades: [ses("2026-12-28", "Run", 6), ses("2026-12-28", "Swim", 1.5), ses("2026-12-30", "Run", 10)],
      }),
    );
    expect(r.semana_dias).toEqual({
      lunes: "2026-12-28",
      dias: [
        { fecha: "2026-12-28", km: 6, sesiones: ["carrera", "natacion"] },
        { fecha: "2026-12-29", km: 0, sesiones: [] },
        { fecha: "2026-12-30", km: 10, sesiones: ["carrera"] },
      ],
    });
  });

  it("antes del día 1 no hay nada de esto", () => {
    const r = calcularProgreso(entrada({ hoy: "2026-11-03", actividades: [ses("2026-11-02", "Run", 5)] }));
    expect(r.ayer).toBeNull();
    expect(r.semana_dias).toBeNull();
    expect(r.totales).toBeNull();
  });
});

describe("ritmo a pulso fijo y predicción", () => {
  const rodaje = (fecha: string, km: number, segundos: number, fc: number, gap: number): ActividadKm => ({
    fecha, tipo: "Run", km, categoria: "carrera", segundos, fcMedia: fc, gap, temp: 30,
  });

  it("solo rodajes suaves de 20 min o más; ritmo equivalente al centro de la Z1 (144) con GAP", () => {
    const p = pulsoFijo([
      rodaje("2026-12-28", 5, 2500, 125, 2), // vale: 2/125 · 144 = 2,304 m/s → 434 s/km
      rodaje("2026-12-29", 3, 900, 140, 3), // 15 min: fuera
      rodaje("2026-12-30", 10, 3000, 178, 3.3), // tempo: fuera
      rodaje("2026-12-31", 4, 2400, 110, 1.6), // subida caminando: fuera
    ]);
    expect(p).toEqual({ pulso: 144, techo_z1: 154, semanas: [{ lunes: "2026-12-28", ritmo: 434, sesiones: 1, temp: 30 }] });
  });

  it("los límites siguen las zonas de Garmin: con la Z2 desde 150, un rodaje a 152 ya no es suave", () => {
    const r = [rodaje("2026-12-28", 5, 2500, 152, 2.4)];
    expect(pulsoFijo(r)).not.toBeNull();
    expect(pulsoFijo(r, zonasDe([130, 150, 165, 180, 190]))!).toBeNull();
    expect(zonasDe([130, 150, 165, 180, 190])).toEqual({ z1Suelo: 130, z1: 149, z2: 164 });
    expect(zonasDe(null)).toEqual({ z1Suelo: 134, z1: 154, z2: 171 });
  });

  it("sin rodajes suaves no hay serie", () => {
    expect(pulsoFijo([rodaje("2026-12-28", 10, 3000, 178, 3.3)])).toBeNull();
  });

  it("predice con la tirada aeróbica más larga de 8 semanas y Riegel de ultra; las carreras no cuentan", () => {
    const larga = rodaje("2026-12-20", 15, 6000, 150, 2.5);
    const carrera = rodaje("2026-12-27", 21.1, 6600, 182, 3.2);
    const vieja = rodaje("2026-10-01", 30, 14000, 150, 2.2);
    const p = prediccion([larga, carrera, vieja], "2026-12-14", "2026-12-29")!;
    expect(p.km_base).toBe(15);
    expect(p.fecha_base).toBe("2026-12-20");
    expect(p.segundos).toBe(Math.round(6000 * Math.pow(120 / 15, EXPONENTE_RIEGEL)));
    expect(p.semanas.map((w) => w.lunes)).toEqual(["2026-12-14", "2026-12-21", "2026-12-28"]);
  });

  it("sin tiradas aeróbicas de 10 km no hay predicción", () => {
    expect(prediccion([rodaje("2026-12-20", 8, 3000, 150, 2.6)], "2026-12-14", "2026-12-29")).toBeNull();
  });
});

describe("lista blanca", () => {
  const valido = () =>
    calcularProgreso(
      entrada({
        actividades: [run("2026-01-31", 31.1), run("2026-12-15", 12)],
        plan: [{ lunes: "2026-12-14", km: 20 }],
        programadas: [{ fecha: "2026-12-15", cumplida: true }],
      }),
    ) as unknown as Record<string, unknown>;

  it("lo que calcula el módulo pasa", () => {
    expect(erroresPublicos(valido())).toEqual([]);
  });

  it("una clave nueva no pasa, aunque sea inocente", () => {
    const r = valido();
    (r.semanas as Array<Record<string, unknown>>)[0]!.nombre = "Ciudad - Rodaje · Rampa 1";
    expect(erroresPublicos(r).join()).toMatch(/semanas\[0\]\.nombre: clave no permitida/);
  });

  it("un texto donde va una fecha no pasa", () => {
    const r = valido();
    (r.tirada_larga as Record<string, unknown>).fecha = "2026-12-15T05:30:00";
    expect(erroresPublicos(r).length).toBeGreaterThan(0);
  });

  it("salud y la V2 tienen que ir a null", () => {
    const r = valido();
    r.salud = { hrv_media: 42 };
    expect(erroresPublicos(r).join()).toMatch(/\$\.salud/);
  });

  it("una etiqueta de hito inventada no pasa", () => {
    const r = valido();
    (r.hitos as Array<Record<string, unknown>>)[0]!.etiqueta = "Salida desde Calle 84";
    expect(erroresPublicos(r).join()).toMatch(/texto no permitido/);
  });

  it("una sesión de ayer con hora o nombre no pasa", () => {
    const r = calcularProgreso(
      entrada({ actividades: [{ fecha: "2026-12-29", tipo: "Run", km: 8, categoria: "carrera", segundos: 3000 }] }),
    ) as unknown as Record<string, unknown>;
    expect(erroresPublicos(r)).toEqual([]);
    const sesion = (r.ayer as { sesiones: Array<Record<string, unknown>> }).sesiones[0]!;
    sesion.hora = "05:30";
    expect(erroresPublicos(r).join()).toMatch(/\$\.ayer/);
    delete sesion.hora;
    sesion.deporte = "Rodaje Rampa 1";
    expect(erroresPublicos(r).join()).toMatch(/\$\.ayer/);
    sesion.deporte = "carrera";
    expect(erroresPublicos(r)).toEqual([]);
  });

  it("coordenadas sueltas no pasan", () => {
    const r = valido();
    r.ruta = [[10.98, -74.8]];
    expect(erroresPublicos(r).join()).toMatch(/\$\.ruta/);
  });
});
