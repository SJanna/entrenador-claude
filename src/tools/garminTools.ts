/**
 * Herramientas de entrenos contra Garmin Connect, sin pasar por intervals.icu.
 *
 * El camino de siempre es `create_workout`: escribe el entreno en el calendario
 * de intervals.icu, que lo parsea de un texto y se lo reenvía a Garmin. Dos
 * traducciones seguidas, y los pasos llegan al reloj deformados. Estas
 * herramientas escriben en Garmin directamente, con la misma sintaxis de pasos:
 * lo único que cambia es el destino.
 *
 * Conviven a propósito: intervals sigue mandando en histórico, análisis y
 * rachas, y si Garmin falla, nada de lo de antes se entera.
 */

import { GarminCliente, GarminError } from "../garmin/cliente";
import {
  claveDeporteGarmin,
  construirEntreno,
  EntrenoError,
  type EntradaEntreno,
} from "../garmin/entrenos";
import { formatearDias, leerDia, MAX_DIAS, type DiaBienestar } from "../garmin/bienestar";
import {
  discrepantes,
  formatearUmbrales,
  leerUmbrales,
  umbralesDeIntervals,
  type Umbrales,
} from "../garmin/umbrales";
import { formatearCalendario, leerCalendario } from "../garmin/calendario";
import {
  formatearActividad,
  formatearActividades,
  leerActividad,
  listarActividades,
  MAX_ACTIVIDADES,
} from "../garmin/actividades";
import { contarPasos, describirEntreno } from "../garmin/entrenos";
import { addDays } from "../dates";

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** ¿Hay algún paso, a cualquier profundidad, que use este porcentaje? */
function llevaPorcentaje(pasos: unknown, clave: string): boolean {
  if (!Array.isArray(pasos)) return false;
  return pasos.some((paso) => {
    if (!paso || typeof paso !== "object" || Array.isArray(paso)) return false;
    const step = paso as Record<string, unknown>;
    if (step[clave] !== undefined && step[clave] !== null) return true;
    return llevaPorcentaje(step.steps, clave);
  });
}

/** Lo que Garmin devuelve de un entreno; solo se mira lo que se usa. */
interface EntrenoListado {
  workoutId?: unknown;
  workoutName?: unknown;
  sportType?: { sportTypeKey?: unknown };
  estimatedDurationInSecs?: unknown;
  [clave: string]: unknown;
}

/**
 * Cuándo se tocó por última vez. Garmin no siempre usa el mismo nombre y a
 * veces no manda ninguno: sin fecha no se puede detectar un entreno huérfano ni
 * desduplicar, así que se prueban todos los que suele traer.
 */
function fechaDeEntreno(entreno: EntrenoListado): string {
  for (const clave of ["updatedDate", "updateDate", "lastUpdateDate", "createdDate", "createDate"]) {
    const valor = entreno[clave];
    if (typeof valor === "string" && /^\d{4}-\d{2}-\d{2}/.test(valor)) return valor.slice(0, 10);
    if (typeof valor === "number" && valor > 0) {
      const fecha = new Date(valor);
      if (!Number.isNaN(fecha.getTime())) return fecha.toISOString().slice(0, 10);
    }
  }
  return "—";
}

function duracion(segundos: unknown): string {
  const total = Number(segundos);
  if (!Number.isFinite(total) || total <= 0) return "—";
  const horas = Math.floor(total / 3600);
  const minutos = Math.round((total % 3600) / 60);
  return horas ? `${horas}h${String(minutos).padStart(2, "0")}` : `${minutos} min`;
}

/** Qué es una programación de Garmin: nombre, fecha y entreno. null si no lo parece. */
export function describirCita(
  bruto: unknown,
): { nombre: string; fecha: string; workoutId: number | null } | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const c = bruto as Record<string, unknown>;
  const entreno =
    c.workout && typeof c.workout === "object" ? (c.workout as Record<string, unknown>) : {};
  const fecha = [c.calendarDate, c.date, c.scheduleDate].find(
    (v): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v),
  );
  if (!fecha) return null;
  const nombre = [entreno.workoutName, c.workoutName, c.title].find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  const workoutId = Number(entreno.workoutId ?? c.workoutId);
  return {
    nombre: nombre?.trim() ?? "(sin nombre)",
    fecha: fecha.slice(0, 10),
    workoutId: Number.isFinite(workoutId) && workoutId > 0 ? workoutId : null,
  };
}

export class GarminTools {
  constructor(
    private readonly cliente: GarminCliente,
    private readonly hoy: () => string,
    /**
     * Los ajustes por deporte de intervals.icu. Hacen de respaldo cuando Garmin
     * no expone un umbral, y sirven para avisar si los dos no coinciden.
     */
    private readonly ajustesIntervals?: () => Promise<Array<Record<string, unknown>>>,
  ) {}

  /** Toda la superficie de error en un sitio: el MCP lee «Error» al principio. */
  private async intentar(accion: () => Promise<string>): Promise<string> {
    try {
      return await accion();
    } catch (exc) {
      if (exc instanceof GarminError || exc instanceof EntrenoError) {
        return `Error: ${exc.message}`;
      }
      return `Error inesperado hablando con Garmin: ${
        exc instanceof Error ? exc.message : String(exc)
      }`;
    }
  }

  private async json(ruta: string, init?: RequestInit): Promise<unknown> {
    const respuesta = await this.cliente.api(ruta, init);
    const texto = await respuesta.text();
    if (!respuesta.ok) {
      throw new GarminError(
        "protocolo",
        `Garmin respondió ${respuesta.status} a ${ruta}${texto ? `: ${texto.slice(0, 200)}` : "."}`,
      );
    }
    if (!texto) return null;
    try {
      return JSON.parse(texto);
    } catch {
      throw new GarminError("protocolo", `Garmin devolvió algo que no es JSON en ${ruta}.`);
    }
  }

  /**
   * Bienestar leído de Garmin. Ventana corta a propósito: son seis llamadas por
   * día, así que un mes serían casi doscientas. Para series largas está el
   * histórico de la app (garmin_wellness_history), que llena el cron.
   */
  async bienestar(args: Record<string, unknown>): Promise<string> {
    return this.intentar(async () => {
      const hasta = String(args.date ?? args.fecha ?? "").trim() || this.hoy();
      const dia = hasta.toLowerCase() === "hoy" ? this.hoy() : hasta;
      if (!FECHA.test(dia)) {
        throw new EntrenoError(`La fecha debe ser YYYY-MM-DD (recibido ${JSON.stringify(hasta)}).`);
      }
      const pedidos = Number(args.days ?? args.dias ?? 1) || 1;
      const cuantos = Math.max(1, Math.min(MAX_DIAS, Math.round(pedidos)));

      const atleta = await this.cliente.atleta();
      const fechas: string[] = [];
      for (let i = cuantos - 1; i >= 0; i--) fechas.push(addDays(dia, -i));

      // En serie, no en paralelo: cada día ya lanza seis peticiones a la vez, y
      // multiplicarlo por siete es la mejor forma de que Garmin nos limite.
      const dias: DiaBienestar[] = [];
      for (const fecha of fechas) {
        dias.push(await leerDia(this.cliente, atleta, fecha));
      }

      const aviso =
        pedidos > MAX_DIAS
          ? `\n\nPediste ${pedidos} días y se han traído ${MAX_DIAS}: cada día son seis ` +
            "llamadas a Garmin. Para ventanas largas usa garmin_wellness_history."
          : "";
      return `Bienestar leído de Garmin (${cuantos} ${cuantos === 1 ? "día" : "días"}):\n` +
        formatearDias(dias) + aviso;
    });
  }

  /** Lo común a crear y a actualizar: leer la entrada, convertir porcentajes y construir. */
  private async construir(args: Record<string, unknown>) {
    const entrada: EntradaEntreno = {
        nombre: String(args.name ?? args.nombre ?? ""),
        deporte: String(args.sport ?? args.deporte ?? ""),
        pasos: Array.isArray(args.steps)
          ? args.steps
          : Array.isArray(args.pasos)
            ? (args.pasos as unknown[])
            : [],
        descripcion: (args.description ?? args.descripcion ?? null) as string | null,
      };
    // Los umbrales solo se piden si hacen falta: son cinco llamadas más y la
    // mayoría de entrenos van con objetivos absolutos.
    if (["power_pct", "hr_pct", "pace_pct"].some((k) => llevaPorcentaje(entrada.pasos, k))) {
      entrada.umbrales = await this.umbrales(entrada.deporte);
    }
    const lineasConversion = (conversiones: string[]): string[] => {
      if (!conversiones.length) return [];
      const lineas = ["Porcentajes convertidos:", ...conversiones.map((c) => `  ${c}`)];
      const choques = discrepantes(entrada.umbrales ?? { fallos: [] });
      if (choques.length) {
        lineas.push(
          `⚠ Garmin no dice lo mismo que intervals.icu (${choques.join("; ")}). Se ha usado ` +
            "el de Garmin, que es lo que hay en el reloj.",
        );
      }
      return lineas;
    };
    return { entrada, ...construirEntreno(entrada), lineasConversion };
  }

  /**
   * Cambia un entreno que ya existe SIN borrarlo: conserva su id y, con él,
   * todas sus fechas en el calendario. Es lo que hace falta con un entreno
   * reutilizado (la caminata de cada día): borrar y crear se llevaría todas sus
   * fechas, y volver a programarlas a mano es la forma de duplicar sesiones.
   */
  async actualizarEntreno(args: Record<string, unknown>): Promise<string> {
    return this.intentar(async () => {
      const id = Number(args.workout_id ?? args.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new EntrenoError("Falta 'workout_id': el id del entreno que quieres cambiar.");
      }
      const antes = (await this.json(`/workout-service/workout/${id}`)) as Record<string, unknown> | null;
      if (!antes || typeof antes !== "object") {
        throw new EntrenoError(`Garmin no tiene el entreno ${id}.`);
      }
      const { entreno, conversiones, lineasConversion } = await this.construir(args);
      const pasosAntes = contarPasos(
        ((antes.workoutSegments as Array<Record<string, unknown>> | undefined)?.[0]?.workoutSteps as unknown[]) ?? [],
      );
      // Se parte del entreno TAL COMO LO DEVUELVE Garmin y se cambia lo que toca.
      // Con un cuerpo construido de cero, Garmin aceptaba los pasos pero perdía el
      // deporte (probado el 10/11/2026: el entreno quedaba sin sportType). Lo que
      // el entreno ya tenía (id, dueño, segmento) se conserva; si cambia de
      // deporte, manda el nuevo.
      const segmentoAntes =
        ((antes.workoutSegments as Array<Record<string, unknown>> | undefined)?.[0] ?? {}) as Record<string, unknown>;
      const mismoDeporte =
        String((antes.sportType as Record<string, unknown> | undefined)?.sportTypeKey ?? "") ===
        entreno.sportType.sportTypeKey;
      const deporte = mismoDeporte ? antes.sportType : entreno.sportType;
      const cuerpo: Record<string, unknown> = {
        ...antes,
        workoutId: id,
        workoutName: entreno.workoutName,
        sportType: deporte,
        estimatedDurationInSecs: entreno.estimatedDurationInSecs,
        workoutSegments: [
          {
            ...segmentoAntes,
            segmentOrder: 1,
            sportType: mismoDeporte ? (segmentoAntes.sportType ?? deporte) : deporte,
            workoutSteps: entreno.workoutSegments[0]!.workoutSteps,
          },
        ],
      };
      if ("description" in entreno) cuerpo.description = entreno.description;
      else delete cuerpo.description;
      await this.json(`/workout-service/workout/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cuerpo),
      });

      const escritos = Array.isArray(entreno.workoutSegments[0]?.workoutSteps)
        ? (entreno.workoutSegments[0]!.workoutSteps as unknown[])
        : [];
      const recuento = contarPasos(escritos);
      // Se relee: lo que importa es lo que Garmin guardó, no lo que se le mandó.
      const despues = (await this.json(`/workout-service/workout/${id}`)) as Record<string, unknown> | null;
      const deporteGuardado = String(
        (despues?.sportType as Record<string, unknown> | undefined)?.sportTypeKey ?? "",
      );
      const avisoDeporte =
        deporteGuardado === entreno.sportType.sportTypeKey
          ? []
          : [
              `⚠ Garmin guardó el entreno con deporte «${deporteGuardado || "ninguno"}» en vez de ` +
                `«${entreno.sportType.sportTypeKey}». Revísalo con garmin_get_workout antes de que llegue al reloj.`,
            ];
      return [
        ...avisoDeporte,
        `Entreno ${id} actualizado en Garmin: «${String(antes.workoutName ?? "")}» → «${entreno.workoutName}».`,
        `Antes: ${pasosAntes.pasos} pasos escritos · ahora: ${recuento.pasos} pasos escritos, ` +
          `${recuento.desplegados} en el reloj · duración estimada ${duracion(entreno.estimatedDurationInSecs)}.`,
        ...lineasConversion(conversiones),
        "Conserva su id y todas sus fechas del calendario: el reloj recibe la versión nueva en la " +
          "próxima sincronización. Compruébalo con garmin_get_workout (número de pasos).",
      ].join("\n");
    });
  }

  /** Crea el entreno y, si se le da fecha, lo deja en el calendario. */
  async crearEntreno(args: Record<string, unknown>): Promise<string> {
    return this.intentar(async () => {
      const { entreno, conversiones, lineasConversion } = await this.construir(args);

      // Garmin no tiene clave de idempotencia, así que la identidad natural es
      // el nombre: un reintento tras un timeout llega con el mismo, y sin esto
      // deja dos entrenos iguales en la biblioteca. Programar el mismo entreno
      // en varias fechas no necesita duplicarlo: se reprograma por id.
      if (args.allow_duplicate !== true) {
        const gemelo = await this.buscarPorNombre(entreno.workoutName);
        if (gemelo !== null) {
          return (
            `Ya existe un entreno llamado «${entreno.workoutName}» en Garmin (id ${gemelo}). ` +
            "No he creado otro. Si quieres esa misma sesión en otra fecha, prográmala con " +
            `garmin_schedule_workout sobre el id ${gemelo}; si de verdad quieres dos entrenos ` +
            "con el mismo nombre, repite con allow_duplicate: true."
          );
        }
      }

      const creado = (await this.json("/workout-service/workout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entreno),
      })) as { workoutId?: unknown } | null;

      const id = Number(creado?.workoutId);
      if (!Number.isFinite(id) || id <= 0) {
        throw new GarminError("protocolo", "Garmin aceptó el entreno pero no devolvió su id.");
      }

      const escritos = Array.isArray(entreno.workoutSegments[0]?.workoutSteps)
        ? (entreno.workoutSegments[0]!.workoutSteps as unknown[])
        : [];
      const recuento = contarPasos(escritos);
      const lineas = [
        `Entreno creado en Garmin: «${entreno.workoutName}» (id ${id}).`,
        `Deporte: ${entreno.sportType.sportTypeKey} · ${recuento.bloques} bloques · ` +
          `${recuento.pasos} pasos escritos · ${recuento.desplegados} pasos en el reloj · ` +
          `duración estimada ${duracion(entreno.estimatedDurationInSecs)}`,
      ];

      lineas.push(...lineasConversion(conversiones));
      lineas.push(
        "Comprueba los pasos con garmin_get_workout: la duración no delata un paso perdido si " +
          "acababa con el botón de vuelta.",
      );

      const fecha = String(args.date ?? args.fecha ?? "").trim();
      if (fecha) {
        lineas.push(await this.programar(id, fecha));
      } else {
        lineas.push(
          "Está en tu biblioteca de Garmin, sin fecha. Para que llegue al reloj, prográmalo " +
            "con garmin_schedule_workout o vuelve a llamar con 'date'.",
        );
      }
      return lineas.join("\n");
    });
  }

  /** Umbrales por deporte, cacheados mientras dure la petición. */
  private readonly cacheUmbrales = new Map<string, Promise<Umbrales>>();

  private umbrales(deporte: string): Promise<Umbrales> {
    const guardado = this.cacheUmbrales.get(deporte);
    if (guardado) return guardado;
    const leyendo = (async () => {
      let respaldo = {};
      if (this.ajustesIntervals && deporte) {
        try {
          respaldo = umbralesDeIntervals(await this.ajustesIntervals(), deporte);
        } catch {
          // Si intervals no contesta se sigue: manda Garmin, y lo de intervals
          // solo servía para poder comparar.
        }
      }
      return leerUmbrales(this.cliente, this.hoy(), respaldo, claveDeporteGarmin(deporte));
    })();
    this.cacheUmbrales.set(deporte, leyendo);
    return leyendo;
  }

  /** Los umbrales de un deporte, con su fuente, para poder contrastarlos. */
  async verUmbrales(args: Record<string, unknown> = {}): Promise<string> {
    return this.intentar(async () => {
      const deporte = String(args.sport ?? args.deporte ?? "Run").trim() || "Run";
      const umbrales = await this.umbrales(deporte);
      return `Deporte: ${deporte}\n${formatearUmbrales(umbrales, args.debug === true)}`;
    });
  }

  /** Qué hay escrito en el calendario de Garmin. */
  async calendario(args: Record<string, unknown>): Promise<string> {
    return this.intentar(async () => {
      const desde = this.fecha(args.from ?? args.desde, this.hoy());
      const hasta = this.fecha(args.to ?? args.hasta, addDays(desde, 13));
      if (hasta < desde) {
        throw new EntrenoError(`El rango va al revés: ${desde} es posterior a ${hasta}.`);
      }
      return formatearCalendario(
        await leerCalendario(this.cliente, desde, hasta),
        desde,
        hasta,
        args.debug === true,
        Boolean(this.ajustesIntervals),
      );
    });
  }

  /** Actividades hechas, tal y como las registró el reloj. */
  async actividades(args: Record<string, unknown>): Promise<string> {
    return this.intentar(async () => {
      const limite = Math.max(
        1,
        Math.min(MAX_ACTIVIDADES, Number(args.limit ?? args.limite ?? 10) || 10),
      );
      const desde = args.from ?? args.desde ? this.fecha(args.from ?? args.desde, "") : undefined;
      const hasta = args.to ?? args.hasta ? this.fecha(args.to ?? args.hasta, "") : undefined;
      const deporte = String(args.sport ?? args.deporte ?? "").trim() || undefined;
      return formatearActividades(
        await listarActividades(this.cliente, { limite, desde, hasta, deporte }),
      );
    });
  }

  /** Una actividad, con sus series si fue de fuerza. */
  async actividad(args: Record<string, unknown>): Promise<string> {
    return this.intentar(async () => {
      const id = Number(args.activity_id ?? args.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new EntrenoError("Falta 'activity_id': el id que devuelve garmin_activities.");
      }
      const r = await leerActividad(this.cliente, id);
      const texto = formatearActividad(r.actividad, r.series, r.avisoSeries, r.vueltas, r.avisoVueltas, r.entreno, {
        tiempo: r.tiempo,
        zonas: r.zonas,
      });
      if (args.debug !== true) return texto;
      return (
        `${texto}\n\nClaves del detalle (solo nombres): ${r.claves.detalle.join(", ")}` +
        `\nClaves de metadataDTO: ${r.claves.metadata.join(", ") || "—"}`
      );
    });
  }

  /** Un entreno ya escrito, paso a paso, para verificar lo que llegó. */
  async verEntreno(args: Record<string, unknown>): Promise<string> {
    return this.intentar(async () => {
      const id = Number(args.workout_id ?? args.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new EntrenoError("Falta 'workout_id': el id del entreno que quieres leer.");
      }
      return describirEntreno(await this.json(`/workout-service/workout/${id}`));
    });
  }

  /** El id de un entreno de la biblioteca con ese nombre exacto, si lo hay. */
  private async buscarPorNombre(nombre: string): Promise<number | null> {
    try {
      const lista = (await this.json(
        "/workout-service/workouts?start=0&limit=50&myWorkoutsOnly=true",
      )) as Array<{ workoutId?: unknown; workoutName?: unknown }> | null;
      if (!Array.isArray(lista)) return null;
      const gemelo = lista.find(
        (w) => String(w.workoutName ?? "").trim() === nombre.trim(),
      );
      const id = Number(gemelo?.workoutId);
      return Number.isFinite(id) && id > 0 ? id : null;
    } catch {
      // Si la biblioteca no se puede leer, no bloqueamos la escritura: el
      // riesgo de duplicar es menor que el de no poder programar nada.
      return null;
    }
  }

  /** Normaliza una fecha o devuelve la de por defecto. */
  private fecha(valor: unknown, porDefecto: string): string {
    const texto = String(valor ?? "").trim();
    if (!texto) return porDefecto;
    const dia = texto.toLowerCase() === "hoy" ? this.hoy() : texto;
    if (!FECHA.test(dia)) {
      throw new EntrenoError(`La fecha debe ser YYYY-MM-DD (recibido ${JSON.stringify(valor)}).`);
    }
    return dia;
  }

  private async programar(id: number, fecha: string): Promise<string> {
    const dia = fecha.toLowerCase() === "hoy" ? this.hoy() : fecha;
    if (!FECHA.test(dia)) {
      throw new EntrenoError(`La fecha debe ser YYYY-MM-DD (recibido ${JSON.stringify(fecha)}).`);
    }
    await this.json(`/workout-service/schedule/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: dia }),
    });
    return `Programado para el ${dia}: Garmin lo enviará al reloj en la próxima sincronización.`;
  }

  async programarEntreno(args: Record<string, unknown>): Promise<string> {
    return this.intentar(async () => {
      const id = Number(args.workout_id ?? args.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new EntrenoError("Falta 'workout_id': el id que devolvió garmin_create_workout.");
      }
      return this.programar(id, String(args.date ?? args.fecha ?? ""));
    });
  }

  async listarEntrenos(args: Record<string, unknown>): Promise<string> {
    return this.intentar(async () => {
      const limite = Math.max(1, Math.min(50, Number(args.limit ?? args.limite ?? 10) || 10));
      const lista = (await this.json(
        `/workout-service/workouts?start=0&limit=${limite}&myWorkoutsOnly=true`,
      )) as EntrenoListado[] | null;
      if (!Array.isArray(lista) || lista.length === 0) {
        return "No hay entrenos en tu biblioteca de Garmin.";
      }
      const filas = lista.map((w) => {
        const fecha = fechaDeEntreno(w);
        return `${String(w.workoutId ?? "—").padStart(10)}  ${duracion(
          w.estimatedDurationInSecs,
        ).padStart(7)}  ${String(w.sportType?.sportTypeKey ?? "—").padEnd(18)}  ${fecha}  ${String(
          w.workoutName ?? "",
        )}`;
      });
      return [
        `${lista.length} entrenos en la biblioteca de Garmin (los más recientes primero):`,
        "        id  duración  deporte             actualizado  nombre",
        ...filas,
      ].join("\n");
    });
  }

  /**
   * Quita una sola cita del calendario. Un entreno reutilizado (la caminata de
   * cada día) tiene muchas programaciones y un solo id de entreno: borrarlo se
   * lleva todas. Aquí se borra la programación, que es una fecha.
   */
  async desprogramar(args: Record<string, unknown>): Promise<string> {
    return this.intentar(async () => {
      const id = Number(args.schedule_id ?? args.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new EntrenoError(
          "Falta 'schedule_id': el número de la columna «programación» de garmin_list_calendar " +
            "(no el id del entreno).",
        );
      }
      // Antes de quitar nada, qué es: un id de entreno o de actividad pasado por
      // error no debe borrar una cita al azar.
      const cita = describirCita(await this.json(`/workout-service/schedule/${id}`));
      if (!cita) {
        throw new EntrenoError(
          `Garmin no reconoce ${id} como una programación. Mira la columna «programación» de ` +
            "garmin_list_calendar: el id del entreno y el de la actividad no valen aquí.",
        );
      }
      if (args.confirm !== true) {
        return (
          `Sin quitar. La programación ${id} es «${cita.nombre}» el ${cita.fecha}` +
          `${cita.workoutId ? ` (entreno ${cita.workoutId})` : ""}. ` +
          "Si es la que quieres quitar, repite con confirm: true. El entreno y sus otras " +
          "fechas no se tocan."
        );
      }
      const respuesta = await this.cliente.api(`/workout-service/schedule/${id}`, {
        method: "DELETE",
      });
      await respuesta.body?.cancel();
      if (!respuesta.ok && respuesta.status !== 204) {
        throw new GarminError(
          "protocolo",
          `Garmin no quitó la programación ${id} (${respuesta.status}).`,
        );
      }
      return (
        `Quitado del calendario: «${cita.nombre}» el ${cita.fecha}. El entreno sigue en la ` +
        "biblioteca con sus otras fechas. El reloj lo deja de ver en la próxima sincronización; " +
        "compruébalo con garmin_list_calendar."
      );
    });
  }

  async borrarEntreno(args: Record<string, unknown>): Promise<string> {
    return this.intentar(async () => {
      const id = Number(args.workout_id ?? args.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new EntrenoError("Falta 'workout_id': el id del entreno que quieres borrar.");
      }
      // Igual que delete_event en intervals: un id equivocado borra una sesión
      // real y no hay papelera. La confirmación es la única red que hay.
      if (args.confirm !== true) {
        const entreno = (await this.json(`/workout-service/workout/${id}`)) as {
          workoutName?: unknown;
        } | null;
        return (
          `Sin borrar. El entreno ${id} es «${String(entreno?.workoutName ?? "(sin nombre)")}». ` +
          "Si es el que quieres borrar, repite con confirm: true."
        );
      }
      const respuesta = await this.cliente.api(`/workout-service/workout/${id}`, {
        method: "DELETE",
      });
      await respuesta.body?.cancel();
      if (!respuesta.ok && respuesta.status !== 204) {
        throw new GarminError(
          "protocolo",
          `Garmin no borró el entreno ${id} (${respuesta.status}).`,
        );
      }
      return `Entreno ${id} borrado de Garmin. Si estaba programado, desaparece también del calendario.`;
    });
  }
}
