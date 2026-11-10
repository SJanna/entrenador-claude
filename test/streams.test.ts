import { describe, expect, it } from "vitest";
import {
  desnivelAcumulado,
  indexarSeries,
  longitudSeries,
  media,
  pasoAutomatico,
  primerValor,
  serieTiempo,
  tramos,
  ultimoValor,
} from "../src/intervals/streams";

describe("indexarSeries", () => {
  it("convierte la respuesta de la API en un mapa tipo → serie", () => {
    const series = indexarSeries([
      { type: "altitude", data: [10, 11, "12", null] },
      { type: "heartrate", data: [120, 130] },
    ]);
    expect(series.get("altitude")).toEqual([10, 11, 12, null]);
    expect(series.get("heartrate")).toEqual([120, 130]);
    expect(longitudSeries(series)).toBe(4);
  });

  it("descarta latlng, series vacías y payloads que no son lista", () => {
    const series = indexarSeries([
      { type: "latlng", data: [[1, 2]], valueTypeIsArray: true },
      { type: "watts", data: [null, null], allNull: true },
      { type: "", data: [1] },
      { type: "cadence", data: "no es una lista" },
    ]);
    expect([...series.keys()]).toEqual([]);
    expect(indexarSeries(null).size).toBe(0);
    expect(indexarSeries({ type: "altitude" }).size).toBe(0);
  });
});

describe("desnivelAcumulado", () => {
  it("suma subida y bajada de una loma", () => {
    const altitud = [0, 10, 20, 30, 20, 10, 0];
    expect(desnivelAcumulado(altitud)).toEqual({ subida: 30, bajada: 30 });
  });

  it("el umbral se come el ruido del barómetro", () => {
    // Cien muestras oscilando ±0.4 m: sin umbral acumularía decenas de metros.
    const ruido = Array.from({ length: 100 }, (_, i) => 50 + (i % 2 ? 0.4 : -0.4));
    const { subida, bajada } = desnivelAcumulado(ruido);
    expect(subida).toBe(0);
    expect(bajada).toBe(0);
  });

  it("respeta el tramo pedido y salta los huecos", () => {
    const altitud = [0, 100, null, 120, 100, 0];
    expect(desnivelAcumulado(altitud, 1, 4)).toEqual({ subida: 20, bajada: 20 });
    expect(desnivelAcumulado(undefined)).toEqual({ subida: 0, bajada: 0 });
  });

  it("con umbral alto solo cuenta lo que de verdad sube", () => {
    const altitud = [0, 3, 6, 9];
    expect(desnivelAcumulado(altitud, 0, 3, 5).subida).toBe(6);
  });
});

describe("tramos", () => {
  it("corta cada vez que la guía avanza el paso", () => {
    const tiempo = Array.from({ length: 31 }, (_, i) => i);
    expect(tramos(tiempo, 10, 0, 30)).toEqual([
      { desde: 0, hasta: 10 },
      { desde: 10, hasta: 20 },
      { desde: 20, hasta: 30 },
    ]);
  });

  it("cierra el último tramo aunque quede corto", () => {
    const tiempo = Array.from({ length: 26 }, (_, i) => i);
    const salida = tramos(tiempo, 10, 0, 25);
    expect(salida.at(-1)).toEqual({ desde: 20, hasta: 25 });
  });

  it("no cae en bucle con pasos imposibles ni rangos vacíos", () => {
    const tiempo = [0, 1, 2];
    expect(tramos(tiempo, 0, 0, 2)).toEqual([]);
    expect(tramos(tiempo, 10, 2, 2)).toEqual([]);
    expect(tramos(undefined, 10, 0, 2)).toEqual([]);
  });

  it("remuestrea por distancia igual que por tiempo", () => {
    const distancia = [0, 10, 20, 30, 40, 50];
    expect(tramos(distancia, 25, 0, 5)).toEqual([
      { desde: 0, hasta: 3 },
      { desde: 3, hasta: 5 },
    ]);
  });
});

describe("agregados de tramo", () => {
  const serie = [null, 10, 20, null, 30];

  it("media ignora huecos", () => {
    expect(media(serie, 0, 4)).toBe(20);
    expect(media([null, null], 0, 1)).toBe(null);
    expect(media(undefined, 0, 1)).toBe(null);
  });

  it("primer y último valor no nulos del tramo", () => {
    expect(primerValor(serie, 0, 4)).toBe(10);
    expect(ultimoValor(serie, 0, 4)).toBe(30);
    expect(ultimoValor(serie, 0, 1)).toBe(10);
    expect(primerValor(serie, 3, 3)).toBe(null);
  });
});

describe("serieTiempo y pasoAutomatico", () => {
  it("si no hay stream de tiempo, el índice es el segundo", () => {
    expect(serieTiempo(new Map(), 3)).toEqual([0, 1, 2]);
    expect(serieTiempo(new Map([["time", [0, 5, 10]]]), 3)).toEqual([0, 5, 10]);
  });

  it("el paso automático mantiene la tabla en ~120 filas", () => {
    expect(pasoAutomatico(3600, 120)).toBe(30);
    expect(pasoAutomatico(600, 120)).toBe(5); // nunca baja de 5 s
    expect(pasoAutomatico(0, 120)).toBe(5);
    expect(3 * 3600 / pasoAutomatico(3 * 3600, 120)).toBeLessThanOrEqual(120);
  });
});
