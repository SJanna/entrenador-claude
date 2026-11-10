import { describe, expect, it } from "vitest";
import {
  banda,
  desacople,
  fcMaxSostenida,
  marcasHistoricas,
  mejoresDeSeries,
  ritmo,
  semanas,
  serieCarga,
  type Series,
} from "../src/historico/calculos";
import { seriesDeDetalle } from "../src/historico/detalle";
import { pesosDe } from "../src/historico/sincronizar";

/** Carrera sintética: velocidad constante, muestra cada `dt` segundos. */
function carrera(minutos: number, v: (t: number) => number, fc: (t: number) => number, dt = 5): Series {
  const s: Series = { segundos: [], distancia: [], velocidad: [], fc: [] };
  let d = 0;
  for (let t = 0; t <= minutos * 60; t += dt) {
    if (t > 0) d += v(t) * dt;
    s.segundos.push(t);
    s.distancia.push(d);
    s.velocidad.push(v(t));
    s.fc.push(fc(t));
  }
  return s;
}

describe("CTL / ATL / TSB", () => {
  it("con carga constante, CTL y ATL tienden a ella y la ATL llega antes", () => {
    const acts = [];
    for (let i = 0; i < 200; i++) {
      const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      acts.push({ id: i, fecha: d, deporte: "running", segundos: 3600, distancia_m: 10000, desnivel_m: 0, fc_media: 140, carga: 100 });
    }
    const { dias } = serieCarga(acts, "2026-01-01", "2026-07-19");
    const ultimo = dias[dias.length - 1]!;
    expect(ultimo.atl).toBeCloseTo(100, 0);
    expect(ultimo.ctl).toBeGreaterThan(95);
    expect(dias[10]!.atl).toBeGreaterThan(dias[10]!.ctl);
    // TSB = CTL − ATL del día anterior
    expect(dias[11]!.tsb).toBeCloseTo(dias[10]!.ctl - dias[10]!.atl, 6);
  });

  it("cuenta las actividades largas sin carga en vez de tratarlas como cero en silencio", () => {
    const r = serieCarga(
      [{ id: 1, fecha: "2026-01-01", deporte: "running", segundos: 3600, distancia_m: 1, desnivel_m: 0, fc_media: 1, carga: null }],
      "2026-01-01",
      "2026-01-02",
    );
    expect(r.sinCarga).toBe(1);
  });
});

describe("semanas", () => {
  it("agrupa de lunes a domingo y separa correr de a pie", () => {
    const s = semanas(
      [
        { id: 1, fecha: "2026-11-02", deporte: "running", segundos: 3600, distancia_m: 10000, desnivel_m: 50, fc_media: 150, carga: 80 },
        { id: 2, fecha: "2026-11-08", deporte: "walking", segundos: 1800, distancia_m: 3000, desnivel_m: 0, fc_media: 100, carga: 10 },
        { id: 3, fecha: "2026-11-09", deporte: "trail_running", segundos: 3600, distancia_m: 8000, desnivel_m: 300, fc_media: 150, carga: 90 },
      ],
      "2026-11-02",
      "2026-11-09",
    );
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ lunes: "2026-11-02", sesiones: 2, kmCarrera: 10, kmAPie: 13, carga: 90 });
    expect(s[1]).toMatchObject({ lunes: "2026-11-09", kmCarrera: 8 });
  });
});

describe("mejores marcas", () => {
  it("encuentra el tramo más rápido dentro de una carrera", () => {
    // 20 min a 3 m/s (5:33/km) con 2 min a 5 m/s (3:20/km) en medio.
    const s = carrera(20, (t) => (t > 600 && t <= 720 ? 5 : 3), () => 150);
    const m = mejoresDeSeries(s);
    expect(m["400"]).toBe(80); // 400 m a 5 m/s
    expect(m["1000"]!).toBeGreaterThan(200);
    expect(m["1000"]!).toBeLessThan(260);
    expect(m["5000"]).toBeUndefined(); // no llegó a 5 km... 3*1080+5*120 = 3840 m
  });

  it("descarta lo imposible (salto de GPS) en vez de enseñarlo como marca", () => {
    const s = carrera(10, (t) => (t > 100 && t <= 110 ? 60 : 3), () => 150);
    const m = mejoresDeSeries(s);
    expect(m["400"]).toBeUndefined();
  });

  it("ordena las del histórico y se queda con las mejores", () => {
    const m = marcasHistoricas([
      { id: 1, fecha: "2026-01-01", deporte: "running", segundos: 1, distancia_m: 1, desnivel_m: 0, fc_media: 1, carga: 1, mejores: { "5000": 1500 } },
      { id: 2, fecha: "2026-02-01", deporte: "running", segundos: 1, distancia_m: 1, desnivel_m: 0, fc_media: 1, carga: 1, mejores: { "5000": 1410 } },
      { id: 3, fecha: "2026-03-01", deporte: "walking", segundos: 1, distancia_m: 1, desnivel_m: 0, fc_media: 1, carga: 1, mejores: { "5000": 900 } },
    ]);
    expect(m.get(5000)!.map((x) => x.actividad)).toEqual([2, 1]);
  });
});

describe("desacople", () => {
  it("cero con pulso y velocidad estables", () => {
    expect(desacople(carrera(60, () => 3, () => 140))).toBeCloseTo(0, 1);
  });

  it("positivo cuando el pulso deriva hacia arriba a la misma velocidad", () => {
    const d = desacople(carrera(60, () => 3, (t) => 140 + (t / 3600) * 14));
    expect(d!).toBeGreaterThan(4);
    expect(d!).toBeLessThan(6);
  });

  it("null por debajo de 40 minutos: un número sin base no se da", () => {
    expect(desacople(carrera(30, () => 3, () => 140))).toBeNull();
  });
});

describe("FC máxima y bandas", () => {
  it("un pico de una sola muestra no cuenta como máximo", () => {
    const s = carrera(5, () => 3, (t) => (t === 100 ? 230 : t === 200 || t === 205 ? 190 : 150));
    expect(fcMaxSostenida(s)).toBe(190);
  });

  it("banda con mediana, percentiles y n", () => {
    const b = banda([50, 52, 51, 53, 49, 52, null, 55])!;
    expect(b.n).toBe(7);
    expect(b.mediana).toBe(52);
    expect(banda([1, 2])).toBeNull();
  });

  it("el ritmo no escribe 4:60", () => {
    expect(ritmo(299.7, 1000)).toBe("5:00/km");
  });
});

describe("lectura de Garmin", () => {
  it("las series salen de la tabla de descriptores", () => {
    const s = seriesDeDetalle({
      metricDescriptors: [
        { metricsIndex: 0, key: "sumDuration" },
        { metricsIndex: 1, key: "sumDistance" },
        { metricsIndex: 2, key: "directSpeed" },
        { metricsIndex: 3, key: "directHeartRate" },
      ],
      activityDetailMetrics: [{ metrics: [0, 0, 0, 90] }, { metrics: [5, 15, 3, 120] }, { metrics: [10, 30, 3, null] }],
    })!;
    expect(s.segundos).toEqual([0, 5, 10]);
    expect(s.distancia).toEqual([0, 15, 30]);
    expect(s.fc).toEqual([90, 120, null]);
  });

  it("sin filas no hay series, en vez de series vacías que parezcan datos", () => {
    expect(seriesDeDetalle({ metricDescriptors: [], activityDetailMetrics: [] })).toBeNull();
  });

  it("pesos en gramos a kilos, y lo imposible fuera", () => {
    expect(
      pesosDe({
        dateWeightList: [
          { calendarDate: "2026-11-01", weight: 68250 },
          { calendarDate: "2026-11-02", weight: 680 },
        ],
      }),
    ).toEqual([{ fecha: "2026-11-01", kg: 68.3 }]);
  });
});
