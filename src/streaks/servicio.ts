/**
 * Lectura mixta de rachas: histórico desde D1 + los últimos días en vivo desde
 * intervals.icu, que son los que todavía pueden cambiar.
 *
 * Reglas de la mezcla:
 *  - Los últimos `DIAS_EN_VIVO` días SIEMPRE se piden a intervals: Garmin
 *    sincroniza tarde y una actividad se edita días después.
 *  - Lo anterior sale de D1 de un tirón, sin tocar la red.
 *  - Si D1 todavía no cubre la ventana pedida (primer arranque), se pide todo
 *    en vivo y se guarda: la base se rellena sola con el uso normal.
 *  - Todo lo que se lee en vivo se persiste, así que el cron es un seguro, no
 *    la única vía de escritura.
 */

import type { AppConfig } from "../env";
import { addDays } from "../dates";
import * as fmt from "../intervals/format";
import type { IntervalsClient, JsonRecord } from "../intervals/client";
import {
  agregarDias,
  densificar,
  rachasDeDias,
  type DiaAgregado,
  type RachasResultado,
  type UmbralesRachas,
} from "./compute";
import { RachasStore, type Cobertura } from "./store";

/** Días recientes que nunca se dan por definitivos. */
export const DIAS_EN_VIVO = 21;

function numero(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(num) ? num : null;
}

/** Pide a intervals el tramo [desde, hasta] y lo resume día a día. */
export async function agregarDesdeIntervals(
  client: IntervalsClient,
  desde: string,
  hasta: string,
): Promise<DiaAgregado[]> {
  const [activities, events, wellness] = await Promise.all([
    client.activities(desde, hasta, 1000),
    client.events(desde, hasta),
    client.wellness(desde, hasta),
  ]);
  return agregarDias({
    hoy: hasta,
    desde,
    actividades: activities.map((item: JsonRecord) => ({
      fecha: fmt.dateShort(item.start_date_local),
      deporte: String(item.type ?? ""),
      segundos: numero(fmt.firstPresent(item, ["moving_time", "elapsed_time"])),
      carga: numero(fmt.firstPresent(item, ["icu_training_load"])),
    })),
    eventos: events.map((item: JsonRecord) => ({
      fecha: fmt.dateShort(item.start_date_local),
      categoria: String(item.category ?? ""),
      nombre: String(item.name ?? ""),
      descripcion: String(item.description ?? ""),
      segundos: numero(fmt.firstPresent(item, ["moving_time", "time_target"])),
    })),
    bienestar: wellness.map((item: JsonRecord) => ({
      fecha: fmt.dateShort(fmt.firstPresent(item, ["id", "date"])),
      sueno_secs: numero(fmt.firstPresent(item, ["sleepSecs"])),
    })),
  });
}

export interface OpcionesRachas {
  dias: number;
  umbrales?: Partial<UmbralesRachas>;
  /**
   * Dónde soltar el trabajo que no hace falta esperar (`ctx.waitUntil`). Si
   * viene, la reescritura de los últimos días deja de estar en el camino
   * crítico: el panel responde y la persistencia termina después.
   */
  enSegundoPlano?: (promesa: Promise<unknown>) => void;
}

export interface LecturaRachas {
  resultado: RachasResultado;
  /** De dónde salió cada tramo, para poder explicarlo y para los tests. */
  origen: {
    /** Primer día pedido en vivo a intervals; lo anterior salió de D1. */
    vivo: string;
    guardado: number;
    escritos: number;
    /** La escritura se dejó para después de responder (no se esperó). */
    diferido: boolean;
    cobertura: Cobertura;
  };
}

export async function leerRachas(
  db: D1Database,
  client: IntervalsClient,
  config: AppConfig,
  opciones: OpcionesRachas,
): Promise<LecturaRachas> {
  const store = new RachasStore(db);
  const hoy = config.today();
  const desde = addDays(hoy, -(opciones.dias - 1));

  const cobertura = await store.cobertura();
  const cubierto = cobertura.primero !== null && cobertura.primero <= desde;
  // Sin histórico suficiente, la ventana entera va en vivo (y se guarda).
  const inicioVivo = cubierto ? maximo(desde, addDays(hoy, -(DIAS_EN_VIVO - 1))) : desde;

  const vivos = await agregarDesdeIntervals(client, inicioVivo, hoy);

  // Si el histórico ya cubría la ventana, esta escritura solo refresca los
  // últimos días: nadie la necesita para responder, así que va en diferido.
  // Cuando NO cubría, la ventana entera se acaba de traer en vivo y sí se
  // espera: es la que rellena la base la primera vez.
  const guardando = store.guardar(vivos, new Date().toISOString());
  const diferido = cubierto && Boolean(opciones.enSegundoPlano);
  if (diferido) {
    opciones.enSegundoPlano!(
      guardando.catch((exc) => {
        // El cron y la siguiente lectura reintentan: no rompe nada.
        console.error("rachas: no se pudo persistir el refresco en diferido", exc);
      }),
    );
  } else {
    await guardando;
  }

  const guardados = inicioVivo > desde ? await store.leer(desde, addDays(inicioVivo, -1)) : [];
  const completos = densificar(desde, hoy, [...guardados, ...vivos]);

  return {
    resultado: rachasDeDias(completos, { hoy, umbrales: opciones.umbrales }),
    origen: {
      vivo: inicioVivo,
      guardado: guardados.length,
      escritos: vivos.length,
      diferido,
      cobertura: await store.cobertura(),
    },
  };
}

/** Refresco nocturno: reescribe los últimos días y deja el histórico al día. */
export async function sincronizarRachas(
  db: D1Database,
  client: IntervalsClient,
  config: AppConfig,
  dias = DIAS_EN_VIVO,
): Promise<number> {
  const hoy = config.today();
  const desde = addDays(hoy, -(dias - 1));
  const resumen = await agregarDesdeIntervals(client, desde, hoy);
  return new RachasStore(db).guardar(resumen, new Date().toISOString());
}

function maximo(a: string, b: string): string {
  return a >= b ? a : b;
}
