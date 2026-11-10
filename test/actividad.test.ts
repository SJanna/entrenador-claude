/**
 * Render de get_activity contra un cliente falso. Existe sobre todo por las
 * UNIDADES: la API mezcla convenciones y equivocarse no rompe nada, solo
 * imprime un número plausible y falso (una rampa del 5,4 % como "0.1").
 */

import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/env";
import { IntervalsClient, type JsonRecord } from "../src/intervals/client";
import { IntervalsTools } from "../src/tools/intervalsTools";

const CONFIG: AppConfig = {
  intervals: true,
  apiKey: "k",
  athleteId: "i1",
  baseUrl: "http://ejemplo.invalid/api/v1",
  tzName: "America/Bogota",
  fieldOverrides: {},
  today: () => "2026-08-12",
};

/** Cuesta arriba de 40 m y vuelta abajo, a 1 Hz. */
const ALTITUD = Array.from({ length: 400 }, (_, i) =>
  i < 200 ? 10 + i * 0.2 : 10 + (400 - i) * 0.2,
);

function tools(opciones: {
  detalle?: JsonRecord;
  intervalos?: JsonRecord[];
  altitud?: number[] | null;
} = {}): IntervalsTools {
  class Fake extends IntervalsClient {
    async activity(): Promise<JsonRecord> {
      return {
        id: "i1001",
        name: "Cuestas",
        type: "Run",
        start_date_local: "2026-08-11T06:02:00",
        moving_time: 400,
        distance: 1400,
        total_elevation_gain: 42,
        ...(opciones.detalle ?? {}),
      };
    }
    async activityIntervals(): Promise<JsonRecord[]> {
      return (
        opciones.intervalos ?? [
          {
            label: "Rampa 1",
            moving_time: 200,
            distance: 700,
            start_index: 0,
            end_index: 199,
            total_elevation_gain: 40,
            average_gradient: 0.054,
          },
        ]
      );
    }
    async activityStreams(): Promise<unknown> {
      const altitud = opciones.altitud === undefined ? ALTITUD : opciones.altitud;
      return altitud ? [{ type: "altitude", data: altitud }] : [];
    }
  }
  return new IntervalsTools(CONFIG, new Fake(CONFIG));
}

/** La celda de una columna en la primera fila de datos de la tabla. */
function celda(texto: string, columna: string): string {
  const lineas = texto.split("\n");
  const iCabecera = lineas.findIndex((l) => l.trimStart().startsWith("#") && l.includes(columna));
  const cabecera = lineas[iCabecera]!;
  const fila = lineas[iCabecera + 1]!;
  // Las columnas van alineadas a la derecha: el final del título marca el final
  // de la celda, y el hueco anterior, su principio.
  const fin = cabecera.indexOf(columna) + columna.length;
  return fila.slice(0, fin).split(/\s{2,}/).at(-1)!.trim();
}

describe("get_activity · unidades", () => {
  it("pend% es porcentaje aunque la API dé la fracción", async () => {
    // intervals.icu manda average_gradient = 0.054 para una rampa del 5,4 %.
    const texto = await tools().getActivity("i1001");
    expect(celda(texto, "pend%")).toBe("5.4");
    expect(texto).not.toContain(" 0.1 ");
  });

  it("el desacople de la API ya viene en porcentaje y se imprime tal cual", async () => {
    const texto = await tools({
      detalle: { decoupling: 4.2, icu_efficiency_factor: 1.83 },
      intervalos: [{ label: "Larga", moving_time: 200, decoupling: 2.1 }],
    }).getActivity("i1001");
    expect(texto).toContain("Desacople aeróbico 4.2 % · factor de eficiencia 1.83");
    expect(celda(texto, "desac%")).toBe("2.1");
  });

  it("la temperatura sale con su sensación térmica y su rango", async () => {
    const texto = await tools({
      detalle: {
        average_weather_temp: 29.4,
        average_feels_like: 34.1,
        min_weather_temp: 27.8,
        max_weather_temp: 31.2,
        average_temp: 32,
      },
    }).getActivity("i1001");
    expect(texto).toContain(
      "Clima: 29.4 °C de media · sensación 34.1 °C · rango 27.8–31.2 °C · sensor del reloj 32.0 °C",
    );
  });

  it("sin ninguno de los dos, ni línea de desacople ni de clima", async () => {
    const texto = await tools().getActivity("i1001");
    expect(texto).not.toContain("Desacople");
    expect(texto).not.toContain("Clima:");
  });
});

describe("get_activity · desnivel por vuelta", () => {
  it("deriva la bajada de la altitud y avisa de que no es de la API", async () => {
    const texto = await tools({
      intervalos: [
        { label: "Subida", start_index: 0, end_index: 199, total_elevation_gain: 40 },
        { label: "Bajada", start_index: 200, end_index: 399, total_elevation_gain: 0 },
      ],
    }).getActivity("i1001");
    expect(celda(texto, "bajada")).toBe("—"); // la primera vuelta solo sube
    // La segunda baja 39,8 m: el umbral de 1 m se come el resto final, que es
    // justo lo que hace que una llanura no acumule desnivel de la nada.
    expect(texto).toContain("−39m");
    expect(texto).toContain("NO la publica la API");
  });

  it("sin serie de altitud no inventa bajada y no imprime la nota", async () => {
    const texto = await tools({ altitud: null }).getActivity("i1001");
    expect(texto).not.toContain("NO la publica la API");
    expect(texto).toContain("Intervalos (1)");
  });
});
