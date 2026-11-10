/**
 * Bienestar leído de Garmin, sin esperar a que intervals.icu sincronice.
 *
 * Por qué existe: intervals recibe estos datos de Garmin con retraso y a veces
 * incompletos —Body Battery y readiness son los que más se pierden—, y entonces
 * el entrenador prescribe a ciegas o, peor, sobre un hueco que parece un cero.
 * Aquí se piden a la fuente.
 *
 * Dos decisiones de forma:
 *
 * - **Cada métrica va por su cuenta.** Son seis endpoints distintos y cualquiera
 *   puede no tener dato ese día (el reloj no se llevó puesto, la siesta no
 *   cuenta, el HRV devuelve 204). Que falte uno no puede tumbar el día entero:
 *   lo que no hay sale como «—» y lo que hay se lee igual.
 * - **La ventana es corta a propósito.** Seis llamadas por día; pedir un mes
 *   serían casi doscientas. Para series largas está `get_wellness` de
 *   intervals, que ya trae el histórico en una sola petición.
 *
 * Nombres de campo adaptados de proyectos MIT. Ver docs/garmin.md.
 */

import type { GarminCliente } from "./cliente";

export const MAX_DIAS = 7;

export interface DiaBienestar {
  fecha: string;
  /** Qué no se pudo leer, para distinguir «no hay dato» de «no se preguntó». */
  fallos: string[];

  pasos: number | null;
  fcReposo: number | null;
  estresMedio: number | null;
  bodyBatteryAlto: number | null;
  bodyBatteryBajo: number | null;
  minutosIntensidad: number | null;

  sueñoSegundos: number | null;
  sueñoProfundo: number | null;
  sueñoLigero: number | null;
  sueñoRem: number | null;
  sueñoDespierto: number | null;
  sueñoPuntuacion: number | null;
  sueñoCalidad: string | null;
  spo2Medio: number | null;
  respiracionMedia: number | null;

  readiness: number | null;
  readinessNivel: string | null;
  readinessFrase: string | null;
  recuperacionMin: number | null;

  hrvNoche: number | null;
  hrvSemana: number | null;
  hrvEstado: string | null;

  estadoEntreno: string | null;
  cargaAguda: number | null;
  cargaCronica: number | null;
  ratioCarga: number | null;

  vo2max: number | null;
}

function numero(valor: unknown): number | null {
  if (valor === null || valor === undefined || typeof valor === "boolean") return null;
  const n = typeof valor === "number" ? valor : Number(valor);
  return Number.isFinite(n) ? n : null;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

function objeto(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

/** Un día vacío: todo a null y sin fallos. Lo que no se llene, no había. */
function diaVacio(fecha: string): DiaBienestar {
  return {
    fecha,
    fallos: [],
    pasos: null, fcReposo: null, estresMedio: null,
    bodyBatteryAlto: null, bodyBatteryBajo: null, minutosIntensidad: null,
    sueñoSegundos: null, sueñoProfundo: null, sueñoLigero: null, sueñoRem: null,
    sueñoDespierto: null, sueñoPuntuacion: null, sueñoCalidad: null,
    spo2Medio: null, respiracionMedia: null,
    readiness: null, readinessNivel: null, readinessFrase: null, recuperacionMin: null,
    hrvNoche: null, hrvSemana: null, hrvEstado: null,
    estadoEntreno: null, cargaAguda: null, cargaCronica: null, ratioCarga: null,
    vo2max: null,
  };
}

/**
 * Una métrica. Si Garmin no tiene dato (204, 404 o cuerpo vacío) devuelve null
 * sin más: no es un fallo, es que ese día no hubo. Solo se apunta como fallo lo
 * que sí debería haber funcionado.
 */
async function leer(
  cliente: GarminCliente,
  ruta: string,
  nombre: string,
  fallos: string[],
): Promise<unknown> {
  try {
    const respuesta = await cliente.api(ruta);
    if (respuesta.status === 204 || respuesta.status === 404) {
      await respuesta.body?.cancel();
      return null;
    }
    const cuerpo = await respuesta.text();
    if (!respuesta.ok) {
      fallos.push(`${nombre} (${respuesta.status})`);
      return null;
    }
    if (!cuerpo.trim()) return null;
    return JSON.parse(cuerpo);
  } catch (exc) {
    fallos.push(`${nombre} (${exc instanceof Error ? exc.message : String(exc)})`);
    return null;
  }
}

/** Las seis lecturas de un día, en paralelo. */
export async function leerDia(
  cliente: GarminCliente,
  atleta: string,
  fecha: string,
): Promise<DiaBienestar> {
  const dia = diaVacio(fecha);
  const usuario = encodeURIComponent(atleta);

  const [resumen, sueño, readiness, hrv, estado, vo2] = await Promise.all([
    leer(
      cliente,
      `/usersummary-service/usersummary/daily/${usuario}?calendarDate=${fecha}`,
      "resumen diario",
      dia.fallos,
    ),
    leer(
      cliente,
      `/wellness-service/wellness/dailySleepData/${usuario}?date=${fecha}&nonSleepBufferMinutes=60`,
      "sueño",
      dia.fallos,
    ),
    leer(cliente, `/metrics-service/metrics/trainingreadiness/${fecha}`, "readiness", dia.fallos),
    leer(cliente, `/hrv-service/hrv/${fecha}`, "HRV", dia.fallos),
    leer(
      cliente,
      `/metrics-service/metrics/trainingstatus/aggregated/${fecha}`,
      "estado de entrenamiento",
      dia.fallos,
    ),
    leer(cliente, `/metrics-service/metrics/maxmet/daily/${fecha}/${fecha}`, "VO₂máx", dia.fallos),
  ]);

  const r = objeto(resumen);
  dia.pasos = numero(r.totalSteps);
  dia.fcReposo = numero(r.restingHeartRate);
  dia.estresMedio = numero(r.averageStressLevel);
  dia.bodyBatteryAlto = numero(r.bodyBatteryHighestValue);
  dia.bodyBatteryBajo = numero(r.bodyBatteryLowestValue);
  const moderados = numero(r.moderateIntensityMinutes) ?? 0;
  const vigorosos = numero(r.vigorousIntensityMinutes) ?? 0;
  dia.minutosIntensidad = moderados || vigorosos ? moderados + vigorosos * 2 : null;

  const s = objeto(objeto(sueño).dailySleepDTO);
  dia.sueñoSegundos = numero(s.sleepTimeSeconds);
  dia.sueñoProfundo = numero(s.deepSleepSeconds);
  dia.sueñoLigero = numero(s.lightSleepSeconds);
  dia.sueñoRem = numero(s.remSleepSeconds);
  dia.sueñoDespierto = numero(s.awakeSleepSeconds);
  const puntuaciones = objeto(s.sleepScores);
  dia.sueñoPuntuacion = numero(objeto(puntuaciones.overall).value);
  dia.sueñoCalidad = texto(objeto(puntuaciones.overall).qualifierKey);
  dia.spo2Medio = numero(s.averageSpO2Value);
  dia.respiracionMedia = numero(s.averageRespirationValue);

  // readiness llega como lista de lecturas del día; interesa la más reciente.
  const lecturas = Array.isArray(readiness) ? readiness : readiness ? [readiness] : [];
  const ultima = objeto(lecturas[lecturas.length - 1]);
  dia.readiness = numero(ultima.score);
  dia.readinessNivel = texto(ultima.level);
  dia.readinessFrase = texto(ultima.feedbackShort);
  dia.recuperacionMin = numero(ultima.recoveryTime);

  const h = objeto(objeto(hrv).hrvSummary);
  dia.hrvNoche = numero(h.lastNightAvg ?? h.lastNight);
  dia.hrvSemana = numero(h.weeklyAvg);
  dia.hrvEstado = texto(h.status);

  const e = objeto(objeto(estado).mostRecentTrainingStatus);
  const porDispositivo = objeto(e.latestTrainingStatusData);
  const registro = objeto(Object.values(porDispositivo)[0]);
  dia.estadoEntreno = texto(registro.trainingStatusFeedbackPhrase);
  const carga = objeto(registro.acuteTrainingLoadDTO);
  dia.cargaAguda = numero(carga.dailyTrainingLoadAcute);
  dia.cargaCronica = numero(carga.dailyTrainingLoadChronic);
  dia.ratioCarga = numero(carga.dailyAcuteChronicWorkloadRatio);

  const entrada = Array.isArray(vo2) ? objeto(vo2[0]) : objeto(vo2);
  dia.vo2max = numero(objeto(entrada.generic).vo2MaxPreciseValue ?? objeto(entrada.generic).vo2MaxValue);

  return dia;
}

// ------------------------------------------------------------------ formato

function horas(segundos: number | null): string {
  if (segundos === null || segundos <= 0) return "—";
  const h = Math.floor(segundos / 3600);
  const m = Math.round((segundos % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

function num(valor: number | null, decimales = 0): string {
  return valor === null ? "—" : valor.toFixed(decimales);
}

function columna(valor: string, ancho: number): string {
  return valor.padStart(ancho);
}

/** Tabla de una línea por día: lo que se mira antes de programar. */
export function formatearDias(dias: DiaBienestar[]): string {
  const lineas = [
    "fecha        readi  BB↑/↓    sueño  p.sue   HRV  FCrep  estrés   pasos",
    ...dias.map((d) =>
      [
        d.fecha,
        columna(num(d.readiness), 6),
        columna(
          d.bodyBatteryAlto === null && d.bodyBatteryBajo === null
            ? "—"
            : `${num(d.bodyBatteryAlto)}/${num(d.bodyBatteryBajo)}`,
          8,
        ),
        columna(horas(d.sueñoSegundos), 8),
        columna(num(d.sueñoPuntuacion), 6),
        columna(num(d.hrvNoche), 5),
        columna(num(d.fcReposo), 6),
        columna(num(d.estresMedio), 7),
        columna(num(d.pasos), 7),
      ].join(" "),
    ),
  ];

  // El detalle va SIEMPRE, del día más reciente. Meterlo en todas las filas
  // haría la tabla ilegible, pero omitirlo cuando se piden varios días era
  // prometer un dato —carga aguda, VO₂máx— que luego no aparecía por ningún
  // lado.
  const unico = dias[dias.length - 1];
  if (unico) {
    const fases = [
      unico.sueñoProfundo !== null ? `profundo ${horas(unico.sueñoProfundo)}` : "",
      unico.sueñoLigero !== null ? `ligero ${horas(unico.sueñoLigero)}` : "",
      unico.sueñoRem !== null ? `REM ${horas(unico.sueñoRem)}` : "",
      unico.sueñoDespierto !== null ? `despierto ${horas(unico.sueñoDespierto)}` : "",
    ].filter(Boolean);
    const detalle = [
      unico.readinessFrase || unico.readinessNivel
        ? `Readiness: ${unico.readinessNivel ?? "—"}${
            unico.readinessFrase ? ` · ${unico.readinessFrase}` : ""
          }${unico.recuperacionMin !== null ? ` · recuperación ${Math.round(unico.recuperacionMin / 60)} h` : ""}`
        : "",
      fases.length ? `Sueño: ${fases.join(" · ")}${unico.sueñoCalidad ? ` · ${unico.sueñoCalidad}` : ""}` : "",
      unico.spo2Medio !== null || unico.respiracionMedia !== null
        ? `SpO₂ ${num(unico.spo2Medio)} % · respiración ${num(unico.respiracionMedia, 1)} rpm`
        : "",
      unico.hrvEstado || unico.hrvSemana !== null
        ? `HRV: ${unico.hrvEstado ?? "—"} · media semanal ${num(unico.hrvSemana)} ms`
        : "",
      unico.estadoEntreno || unico.cargaAguda !== null
        ? `Entrenamiento: ${unico.estadoEntreno ?? "—"} · carga aguda ${num(unico.cargaAguda)} / ` +
          `crónica ${num(unico.cargaCronica)}${unico.ratioCarga !== null ? ` (ratio ${num(unico.ratioCarga, 2)})` : ""}`
        : "",
      unico.vo2max !== null ? `VO₂máx ${num(unico.vo2max, 1)}` : "",
      unico.minutosIntensidad !== null ? `Minutos de intensidad: ${num(unico.minutosIntensidad)}` : "",
    ].filter(Boolean);
    if (detalle.length) {
      lineas.push("", dias.length > 1 ? `Detalle del ${unico.fecha}:` : "Detalle:", ...detalle);
    }
  }

  const fallos = [...new Set(dias.flatMap((d) => d.fallos))];
  if (fallos.length) {
    lineas.push(
      "",
      `No se pudo leer: ${fallos.join(", ")}. Un «—» sin fallo aquí significa que ese día ` +
        "no hubo dato, no que se haya perdido.",
    );
  }
  return lineas.join("\n");
}
