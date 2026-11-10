/**
 * Sincronización del histórico de Garmin, con presupuesto de llamadas.
 *
 * Un Worker tiene un límite de subpeticiones por invocación (50 en el plan
 * gratuito) y Garmin limita por IP, que en Cloudflare es compartida. Así que la
 * carga inicial no se hace de golpe: cada ejecución del cron gasta como mucho
 * `presupuesto` llamadas y deja apuntado por dónde va. En el orden:
 *
 *   1. Lo reciente primero (actividades de las dos últimas semanas, bienestar
 *      de hoy y de ayer): es lo que pide el entrenador esta noche.
 *   2. La carga inicial de actividades, página a página hacia atrás.
 *   3. El detalle (series) de las actividades a pie, de la más nueva a la más
 *      vieja: de ahí salen las marcas y el desacople.
 *   4. El bienestar hacia atrás, hasta el objetivo de días.
 *   5. El peso, una vez al día.
 *
 * Si Garmin limita (429) se para en seco: lo que no se hizo hoy se hace en la
 * siguiente ejecución, y reintentar ahora solo alargaría el castigo.
 */

import { addDays } from "../dates";
import { listarActividades } from "../garmin/actividades";
import { leerDia } from "../garmin/bienestar";
import type { GarminCliente } from "../garmin/cliente";
import { GarminError } from "../garmin/cliente";
import { desacople, esAPie, fcMaxSostenida, mejoresDeSeries } from "./calculos";
import { leerSeries } from "./detalle";
import type { HistoricoStore } from "./store";

/**
 * Llamadas a Garmin por ejecución. En el plan gratuito, D1 admite 50 consultas
 * por invocación y cada llamada útil acaba en una escritura, más unas 15 fijas:
 * 18 deja margen. En el plan de pago se sube con HISTORICO_PRESUPUESTO.
 */
export const PRESUPUESTO_POR_DEFECTO = 18;
/** Días de bienestar que se quieren tener: R026 pide 120 para FC en reposo. */
export const DIAS_BIENESTAR_OBJETIVO = 120;
const PAGINA = 50;
const LLAMADAS_POR_DIA = 6;
/** Bienestar de hoy/ayer: se relee si tiene más de esto. */
const REFRESCO_MS = 3 * 3600_000;
/**
 * Hoy, mientras le falten sueño o VFC, se relee cada hora: el reloj suele
 * sincronizar la noche después de la primera lectura de la mañana, y con 3 h
 * el panel enseñaba el día a medias toda la mañana (visto el 10/11).
 */
const REFRESCO_HOY_INCOMPLETO_MS = 3600_000 - 5 * 60_000;

export interface InformeSync {
  llamadas: number;
  actividadesNuevas: number;
  detalles: number;
  dias: number;
  pesos: number;
  parado: string | null;
  errores: string[];
}

class SinPresupuesto extends Error {}

/** Cliente que cuenta y corta: nadie dentro de la sync puede pasarse. */
function contado(cliente: GarminCliente, presupuesto: number, informe: InformeSync): GarminCliente {
  return {
    atleta: () => cliente.atleta(),
    api: async (ruta: string, init?: RequestInit) => {
      if (informe.llamadas >= presupuesto) throw new SinPresupuesto();
      informe.llamadas++;
      return cliente.api(ruta, init);
    },
  } as unknown as GarminCliente;
}

export async function sincronizarHistorico(
  clienteReal: GarminCliente,
  store: HistoricoStore,
  hoy: string,
  opciones: { presupuesto?: number; diasObjetivo?: number; ahora?: () => number } = {},
): Promise<InformeSync> {
  const presupuesto = Math.max(6, opciones.presupuesto ?? PRESUPUESTO_POR_DEFECTO);
  const ahora = opciones.ahora ?? Date.now;
  const informe: InformeSync = {
    llamadas: 0, actividadesNuevas: 0, detalles: 0, dias: 0, pesos: 0, parado: null, errores: [],
  };
  const cliente = contado(clienteReal, presupuesto, informe);
  const queda = () => presupuesto - informe.llamadas;
  const objetivo = addDays(hoy, -(opciones.diasObjetivo ?? DIAS_BIENESTAR_OBJETIVO) + 1);
  await store.fijarCursor("bienestar_objetivo", objetivo);

  const paso = async (nombre: string, fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (exc) {
      if (exc instanceof SinPresupuesto) {
        informe.parado ??= "presupuesto agotado";
        return false;
      }
      if (exc instanceof GarminError && (exc.codigo === "limitado" || exc.codigo === "no_enlazada" || exc.codigo === "reenlazar")) {
        informe.parado = exc.message;
        return false;
      }
      informe.errores.push(`${nombre}: ${exc instanceof Error ? exc.message : String(exc)}`);
      return true; // un fallo puntual no para el resto
    }
  };

  /**
   * leerDia se traga los fallos de cada endpoint (los apunta en `fallos`), así
   * que aquí se decide: si Garmin limitó, se para; si falló casi todo, el día
   * NO se guarda, para que la próxima vez se vuelva a pedir en vez de quedarse
   * para siempre como «leído y vacío».
   */
  const leerYGuardarDia = async (fecha: string): Promise<void> => {
    const atleta = await cliente.atleta();
    const dia = await leerDia(cliente, atleta, fecha);
    if (dia.fallos.some((f) => /limitando|429/.test(f))) {
      throw new GarminError("limitado", "Garmin está limitando las peticiones (429).");
    }
    if (dia.fallos.length >= 3) {
      throw new Error(`día incompleto, se reintentará: ${dia.fallos.join(" · ")}`);
    }
    await store.guardarDia(dia);
    informe.dias++;
  };

  // 1a. Actividades recientes. Si la última guardada es más vieja que la
  // ventana (Garmin desenlazado un tiempo), se rehace la carga inicial entera:
  // la lista reciente solo trae 50 y dejaría un hueco para siempre.
  const ultima = (await store.cobertura()).ultima;
  if (ultima && ultima < addDays(hoy, -14)) {
    await store.fijarCursor("actividades_completas", "0");
    await store.fijarCursor("actividades_inicio", "0");
  }
  if (!(await paso("actividades recientes", async () => {
    const recientes = await listarActividades(cliente, { limite: PAGINA, desde: addDays(hoy, -14), hasta: hoy });
    informe.actividadesNuevas += await store.guardarActividades(recientes, esAPie);
  }))) return cerrar();

  // 1b. Bienestar reciente: hoy y ayer si tienen más de 3 h; y los días de la
  // última semana que se leyeron vacíos (el reloj sincronizó tarde), cada 12 h.
  const leidos = await store.diasLeidos(addDays(hoy, -6), hoy);
  const vacios = await store.diasVacios(addDays(hoy, -6), addDays(hoy, -2));
  const filaHoy = (await store.bienestar(hoy, hoy))[0];
  const hoyIncompleto = !filaHoy || filaHoy.sueno_seg === null || filaHoy.hrv_noche === null;
  const toca: string[] = [];
  for (const fecha of [hoy, addDays(hoy, -1)]) {
    const cuando = leidos.get(fecha);
    const cada = fecha === hoy && hoyIncompleto ? REFRESCO_HOY_INCOMPLETO_MS : REFRESCO_MS;
    if (!cuando || ahora() - Date.parse(cuando) >= cada) toca.push(fecha);
  }
  for (const [fecha, cuando] of vacios) {
    if (ahora() - Date.parse(cuando) >= 4 * REFRESCO_MS) toca.push(fecha);
  }
  for (const fecha of toca) {
    if (queda() < LLAMADAS_POR_DIA) break;
    if (!(await paso(`bienestar ${fecha}`, () => leerYGuardarDia(fecha)))) return cerrar();
  }

  // 2. Carga inicial de actividades, hacia atrás.
  if ((await store.leerCursor("actividades_completas")) !== "1") {
    const inicio = Number((await store.leerCursor("actividades_inicio")) ?? "0") || 0;
    if (!(await paso("carga inicial de actividades", async () => {
      const pagina = await listarActividades(cliente, { limite: PAGINA, inicio });
      informe.actividadesNuevas += await store.guardarActividades(pagina, esAPie);
      await store.fijarCursor("actividades_inicio", String(inicio + pagina.length));
      if (pagina.length < PAGINA) await store.fijarCursor("actividades_completas", "1");
    }))) return cerrar();
  }

  // 3. Detalle de las actividades a pie.
  // Deja sitio para un día de bienestar hacia atrás (6) y el peso (1). Con 6
  // justos, el paso 4 (que pide 7) no arrancaba hasta acabar TODAS las series:
  // visto en producción el 09/11, bienestar parado en 2 días tras cuatro pasadas.
  const reservaBienestar = LLAMADAS_POR_DIA + 1;
  const pendientes = await store.pendientesDeDetalle(Math.max(0, queda() - reservaBienestar));
  for (const { id } of pendientes) {
    if (queda() <= reservaBienestar) break;
    const seguir = await paso(`detalle ${id}`, async () => {
      try {
        const series = await leerSeries(cliente, id);
        if (!series) {
          await store.guardarDetalle(id, { estado: "sin_datos" });
        } else {
          await store.guardarDetalle(id, {
            estado: "hecho",
            mejores: mejoresDeSeries(series),
            desacople: desacople(series),
            fcMax: fcMaxSostenida(series),
          });
        }
        informe.detalles++;
      } catch (exc) {
        // Lo que para la sync (presupuesto, 429, cuenta caída) no es culpa de la
        // actividad: no se apunta. Lo demás se reintenta hasta tres veces.
        if (
          exc instanceof SinPresupuesto ||
          (exc instanceof GarminError && ["limitado", "no_enlazada", "reenlazar"].includes(exc.codigo))
        ) {
          throw exc;
        }
        await store.falloDetalle(id, exc instanceof Error ? exc.message : String(exc));
        throw exc;
      }
    });
    if (!seguir) return cerrar();
  }

  // 4. Bienestar hacia atrás, del más reciente que falte al más viejo.
  const yaLeidos = await store.diasLeidos(objetivo, hoy);
  for (let fecha = addDays(hoy, -2); fecha >= objetivo; fecha = addDays(fecha, -1)) {
    if (yaLeidos.has(fecha)) continue;
    if (queda() < LLAMADAS_POR_DIA + 1) break;
    if (!(await paso(`bienestar ${fecha}`, () => leerYGuardarDia(fecha)))) return cerrar();
  }

  // 5. Peso, una vez al día, de los últimos 30 días (o del objetivo entero la primera vez).
  if ((await store.leerCursor("peso_dia")) !== hoy && queda() >= 1) {
    await paso("peso", async () => {
      const primera = (await store.leerCursor("peso_dia")) === null;
      const desde = primera ? objetivo : addDays(hoy, -30);
      const r = await cliente.api(`/weight-service/weight/dateRange?startDate=${desde}&endDate=${hoy}`);
      if (!r.ok && r.status !== 204 && r.status !== 404) {
        await r.body?.cancel();
        throw new Error(`Garmin respondió ${r.status} al peso; se reintenta en la próxima pasada.`);
      }
      const cuerpo = r.ok ? await r.json().catch(() => null) : null;
      const pesos = pesosDe(cuerpo);
      await store.guardarPesos(pesos);
      informe.pesos = pesos.length;
      await store.fijarCursor("peso_dia", hoy);
    });
  }

  return cerrar();

  async function cerrar(): Promise<InformeSync> {
    await store.fijarCursor("ultima_sync", new Date(ahora()).toISOString());
    return informe;
  }
}

/** dateWeightList: [{calendarDate, weight (gramos)}]. Lo raro se descarta. */
export function pesosDe(cuerpo: unknown): Array<{ fecha: string; kg: number }> {
  const lista = (cuerpo as Record<string, unknown> | null)?.dateWeightList;
  if (!Array.isArray(lista)) return [];
  const porDia = new Map<string, number>();
  for (const e of lista) {
    const r = e as Record<string, unknown>;
    const fecha = String(r.calendarDate ?? "").slice(0, 10);
    const g = Number(r.weight);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !Number.isFinite(g)) continue;
    const kg = Math.round(g / 100) / 10;
    if (kg < 25 || kg > 250) continue; // un número imposible no se guarda
    porDia.set(fecha, kg);
  }
  return [...porDia].map(([fecha, kg]) => ({ fecha, kg }));
}
