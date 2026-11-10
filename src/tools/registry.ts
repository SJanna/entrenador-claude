/**
 * Registro de herramientas MCP: definición (nombre, descripción, esquema JSON)
 * y despacho. Las de intervals.icu, las del contrato y el material, y las de
 * Garmin, que escriben entrenos sin pasar por intervals.
 */

import type { AppConfig, Env } from "../env";
import { IntervalsTools } from "./intervalsTools";
import { ContractTools } from "./contractTools";
import { MaterialTools } from "./materialTools";
import { ContractStore, type CommitInput } from "../contract/store";
import { MaterialStore } from "../material/store";
import { GarminTools } from "./garminTools";
import { GarminAlmacen } from "../garmin/almacen";
import { GarminCliente } from "../garmin/cliente";
import { IntervalsClient } from "../intervals/client";
import { PublicoTools } from "./publicoTools";
import { PublicoStore } from "../publico/store";
import { briefing } from "./briefing";
import { leerCalendario } from "../garmin/calendario";
import { HistoricoTools } from "./historicoTools";
import { DiarioTools } from "./diarioTools";
import { DiarioStore } from "../diario/store";
import { HistoricoStore } from "../historico/store";

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

/** Herramientas que necesitan intervals.icu: sin él no se registran. */
export const HERRAMIENTAS_INTERVALS = new Set([
  "get_wellness",
  "set_wellness",
  "get_activities",
  "search_activities",
  "get_records",
  "get_activity",
  "get_activity_streams",
  "get_weekly_summary",
  "get_streaks",
  "list_events",
  "get_event",
  "create_workout",
  "create_note",
  "update_event",
  "delete_event",
  "get_athlete_settings",
  "update_athlete_settings",
]);

/** Módulo opcional: solo existe si hay página pública (KV `PUBLICO`). */
export const HERRAMIENTAS_PUBLICO = new Set(["set_plan_publico"]);

export interface Modulos {
  intervals: boolean;
  publico: boolean;
}

/**
 * Instrucciones del servidor. Se construyen según lo que haya instalado: decirle
 * al modelo que use una herramienta que no existe es otra forma de que afirme
 * sin leer.
 */
export function serverInstructions(m: Modulos): string {
  const partes: string[] = [
    "Plataforma de entrenamiento de UN atleta. El contrato (reglas, estado, pendientes, " +
      "disparadores, condiciones, carreras, material) vive en la base de datos de esta app y " +
      "es la fuente de verdad sobre los acuerdos. Garmin Connect es la fuente principal de " +
      "datos: el reloj escribe ahí." +
      (m.intervals
        ? " intervals.icu está conectado como RESPALDO: úsalo solo si el histórico de Garmin " +
          "no cubre lo que necesitas o Garmin falla."
        : ""),
    "HISTÓRICO: la app guarda su propio histórico de Garmin (lo llena un cron cada hora). " +
      "garmin_weekly_summary (volumen, carga y CTL/ATL/TSB en la escala de Garmin), " +
      "garmin_records (mejores marcas y FC máxima de todo el histórico), " +
      "garmin_wellness_history (bandas de 120 días de FC en reposo, VFC, sueño y peso) y " +
      "garmin_search_activities (filtrar, con desacople aeróbico), garmin_streaks (constancia). " +
      "Cada respuesta empieza por " +
      "la cobertura: si dice HISTÓRICO INCOMPLETO, lo que saques es provisional y se dice.",
    "ANTES de programar o recomendar carga: llama a `briefing`. Trae en una sola llamada el " +
      "contrato compacto, los disparadores vencidos, el bienestar y las actividades recientes " +
      "de Garmin y LOS calendarios, y marca los días sin nada escrito. Nunca programes desde " +
      "el recuerdo de otra conversación: lo que no leíste hoy, no lo sabes.",
    "Todo acuerdo termina en UNA llamada a contract_commit: atómica, escribe el log " +
      "(append-only), aplica los cambios y sube la versión. Nunca digas que algo quedó escrito " +
      "sin la línea de confirmación «commit vN». Las reglas PROTEGIDAS (restricciones médicas " +
      "y similares) solo se tocan con la frase textual del atleta en `cita_textual`: el " +
      "servidor rechaza el commit sin ella. No la parafrasees ni la deduzcas. Tampoco la rodees: " +
      "ni una regla nueva sin proteger que la contradiga, ni subir el nivel de la lesión en el " +
      "estado sin cumplir sus condiciones.",
    "EL CONTRATO ES CORTO POR DISEÑO: get_contract da una línea por entrada; el detalle se " +
      "pide con detalle: \"R001\" o seccion + detalle: true. La narrativa va en 'mensaje' " +
      "(sin límite, al log); los campos del contrato tienen límite y el commit se rechaza " +
      "entero si se supera. Comprimir textos no devuelve espacio: solo tener menos entradas. " +
      "Cuando salga ⚠ SALUD, proponer bajas es parte del trabajo, no un extra.",
    "DIARIO: diary_set y diary_get guardan lo subjetivo (dolor 0-10 de una lesión, síntomas). " +
      "Con una lesión activa, el dolor del mismo día y a las 48 h se registra siempre.",
    "MATERIAL: lo que no está en get_material, el atleta no lo tiene. Mira el inventario " +
      "antes de recomendar cualquier cosa que necesite material.",
    "FUERZA: el registro serie a serie (ejercicio, repeticiones, peso) solo está en Garmin: " +
      "garmin_activities para encontrar la sesión, garmin_activity para sus series.",
    "ENTRENOS: garmin_create_workout escribe directo en Garmin y es la ruta por defecto: los " +
      "pasos llegan al reloj tal cual. Los rangos van como lista [min, max]. Después de " +
      "escribir una sesión que importe, léela con garmin_get_workout y compara el NÚMERO DE " +
      "PASOS, no solo la duración." +
      (m.intervals
        ? " create_workout (intervals) solo cuando haga falta lo que Garmin no tiene: rampas " +
          "dentro de un paso o la carga proyectada en intervals. Lo de un calendario no se ve " +
          "en el otro."
        : ""),
  ];
  if (m.intervals) {
    partes.push(
      "intervals.icu (respaldo): list_events recorta las notas a 60 caracteres: " +
        "full_notes=true o get_event(id) para leerlas enteras. get_streaks da la constancia; " +
        "una racha viva nunca es razón para entrenar.",
    );
  }
  if (m.publico) {
    partes.push(
      "PÁGINA PÚBLICA: al cargar cada semana, set_plan_publico con los km de carrera " +
        "planificados. Se congelan el lunes: escríbelos antes.",
    );
  }
  return partes.join("\n");
}

/** Compatibilidad: las instrucciones con todos los módulos. */
export const SERVER_INSTRUCTIONS = serverInstructions({ intervals: true, publico: true });

const rangoNota = "Acepta un número (90) o un rango [88, 94].";

/**
 * `enSegundoPlano` es el `ctx.waitUntil` de la petición: lo usa get_streaks
 * para refrescar el histórico sin hacer esperar a la respuesta.
 */
export function buildTools(
  env: Env,
  config: AppConfig,
  enSegundoPlano?: (promesa: Promise<unknown>) => void,
): ToolDefinition[] {
  // Sin intervals no se construye su cliente: sus herramientas se filtran abajo
  // y nunca llegan a ejecutarse.
  const intervals = config.intervals
    ? new IntervalsTools(config)
    : (null as unknown as IntervalsTools);
  const conPublico = Boolean(env.PUBLICO);
  const historicoStore = new HistoricoStore(env.DB);
  const store = new ContractStore(env.DB, config.today);
  const materialStore = new MaterialStore(env.DB);
  const contract = new ContractTools(store, materialStore);
  const material = new MaterialTools(materialStore);
  const publico = new PublicoTools(new PublicoStore(env.DB), config.today);
  const garminCliente = new GarminCliente(new GarminAlmacen(env.DB, env.SESSION_SECRET));
  const garmin = new GarminTools(
    garminCliente,
    config.today,
    // Manda Garmin, que es el origen. Los de intervals se leen igual: sirven
    // de respaldo cuando Garmin no expone el umbral, y para avisar si difieren.
    config.intervals ? () => new IntervalsClient(config).sportSettings() : undefined,
  );
  const historico = new HistoricoTools(historicoStore, garminCliente, config.today);
  const diario = new DiarioTools(new DiarioStore(env.DB), config.today);

  const todas: ToolDefinition[] = [
    // ------------------------------------------------------------ briefing
    {
      name: "briefing",
      title: "Briefing antes de programar",
      description:
        "LLÁMALA PRIMERO, antes de programar o recomendar carga. Hace en una sola llamada " +
        "todo el protocolo de lectura: contrato compacto (con disparadores vencidos), " +
        "bienestar y actividades recientes de Garmin, " +
        (config.intervals ? "los DOS calendarios (Garmin e intervals), " : "el calendario de Garmin, ") +
        "la carga de las últimas 4 semanas (histórico de Garmin, con CTL/ATL/TSB) " +
        "y marca los días de los próximos 7 SIN nada escrito y los programados en los dos " +
        "calendarios. Lo que no se pudo leer sale como NO LEÍDO: sobre eso no se programa.",
      inputSchema: {
        type: "object",
        properties: {
          days_back: { type: "number", description: "Días de calendario hacia atrás (0-14, por defecto 7)." },
          days_ahead: { type: "number", description: "Días hacia delante (7-21, por defecto 14)." },
          wellness_days: {
            type: "number",
            description:
              "Días de bienestar de Garmin (1-7, por defecto 3). Cada día son varias llamadas a " +
              "Garmin: para ventanas largas, garmin_wellness aparte" +
              (config.intervals ? " o get_wellness." : "."),
          },
        },
      },
      annotations: { readOnlyHint: true, title: "Briefing antes de programar" },
      run: (args) =>
        briefing(
          {
            hoy: config.today,
            contrato: () => contract.getContract(),
            bienestar: (dias) => garmin.bienestar({ days: dias }),
            actividades: () => garmin.actividades({ limit: 10 }),
            calendarioGarmin: (desde, hasta) => leerCalendario(garminCliente, desde, hasta),
            resumenSemanal: () => historico.semanal({ weeks: 4 }),
            ...(config.intervals
              ? {
                  eventosIntervals: (desde: string, hasta: string) =>
                    new IntervalsClient(config).events(desde, hasta),
                }
              : {}),
          },
          args,
        ),
    },
    // ------------------------------------------------------------ contrato
    {
      name: "get_contract",
      title: "Contrato de entrenamiento",
      description:
        "El contrato vigente desde la base de datos de la app (fuente de verdad): versión, " +
        "reglas activas con su vencimiento, estado (nivel de una lesión, bloque, zonas, flags), " +
        "pendientes, disparadores, condiciones especiales activas y carreras con cuenta " +
        "atrás. Llámala SIEMPRE antes de programar o recomendar carga: reemplaza a la " +
        "antigua lectura de la zona 2099 del calendario. Las reglas y pendientes vencidos " +
        "se dan de baja automáticamente en esta lectura y quedan registrados en el log.\n" +
        "Sin parámetros devuelve la VISTA COMPACTA: una línea por entrada con su 'resumen' " +
        "(o el principio del texto recortado, marcado «…[+N]», si aún no tiene resumen), " +
        "pensada para caber siempre en una lectura. El detalle se pide aparte: " +
        "detalle: \"R001\" (una regla), \"#3\" (pendiente/disparador/carrera), " +
        "\"bloque\" (clave de estado); o seccion: \"reglas\" con detalle: true para " +
        "una sección entera. Los pendientes y claves de estado sin tocar más de 60 días " +
        "salen marcados ESTANCADO. Termina siempre con la línea [TAMAÑO].",
      inputSchema: {
        type: "object",
        properties: {
          seccion: {
            type: "string",
            enum: ["reglas", "estado", "pendientes", "disparadores", "condiciones", "carreras", "material"],
            description: "Solo esa sección (compacta; con detalle: true, entera).",
          },
          detalle: {
            type: ["string", "number", "boolean"],
            description:
              "Id de una entrada para leerla entera (\"R001\", \"#3\", 3, \"bloque\"), " +
              "o true para la sección/el contrato completos.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, title: "Contrato de entrenamiento" },
      run: (args) => contract.getContract(args.seccion, args.detalle),
    },
    {
      name: "contract_commit",
      title: "Commit del contrato",
      description:
        "Cierra un acuerdo con un commit ATÓMICO: escribe la entrada en el log " +
        "(append-only), aplica los cambios estructurados y sube la versión, todo o nada. " +
        "Reemplaza el protocolo manual de reescribir snapshots. Toda conversación donde " +
        "se acuerde algo termina con una llamada a esta herramienta. Responde " +
        "«commit v{N} · {mensaje}» como confirmación. Si solo quieres dejar constancia " +
        "sin cambios estructurales, pasa únicamente 'mensaje'.\n" +
        "LÍMITES DE LONGITUD (en caracteres, el commit se rechaza ENTERO si se superan): " +
        "estado ≤300 por clave · reglas.resumen ≤300 · reglas.contenido ≤1500 · " +
        "pendientes.texto y resumen ≤400 · carreras.notas ≤600 · disparadores.accion_texto " +
        "≤1500. 'mensaje' NO tiene límite: ahí va la narrativa (contexto, razonamiento, lo " +
        "que pasó), que se guarda íntegra en el log. En el contrato solo cabe el mandato.",
      inputSchema: {
        type: "object",
        properties: {
          mensaje: {
            type: "string",
            description:
              "Qué se acordó y por qué. Va al log tal cual (append-only) y sin límite de " +
              "longitud: es el sitio de la narrativa larga que no cabe en el contrato. Empieza " +
              "con un título corto (p. ej. «PODA 2/3 · REGLAS»): es lo que enseña el índice de get_log.",
          },
          fecha: {
            type: "string",
            description: "Día del acuerdo, YYYY-MM-DD. Por defecto hoy.",
          },
          cita_textual: {
            type: "string",
            description:
              "Obligatoria para crear, modificar o retirar una regla PROTEGIDA (🔒, la doble " +
              "llave de las restricciones médicas): la frase del atleta COPIADA TAL CUAL la dijo " +
              "en esta conversación, no una paráfrasis. Va al log. Sin ella el commit entero se " +
              "rechaza.",
          },
          reglas: {
            type: "array",
            description:
              "Cambios de reglas. crear: {accion:'crear', id? (autonumera si falta), tema, " +
              "resumen (el mandato operativo, ≤300), contenido (el porqué y el precedente, " +
              "≤1500), vence? (YYYY-MM-DD, 'nunca', o \"cond: <la condición>\" para las reglas " +
              "que no caducan en una fecha sino cuando pasa algo — la condición es obligatoria, " +
              "porque una condición sin decir cuál ya era 'nunca')}. " +
              "modificar: {accion:'modificar', id, " +
              "tema?, resumen?, contenido?, vence?, protegida?}. retirar: {accion:'retirar', id, " +
              "motivo?}. protegida: true marca una restricción médica o de seguridad que el " +
              "entrenador no puede relajar: tocarla exige 'cita_textual' y no puede vencer por " +
              "fecha. La vista compacta de get_contract enseña solo 'resumen'.",
            items: {
              type: "object",
              properties: {
                accion: { type: "string", enum: ["crear", "modificar", "retirar"] },
                id: { type: "string" },
                tema: { type: "string" },
                resumen: { type: ["string", "null"] },
                contenido: { type: "string" },
                vence: { type: ["string", "null"] },
                motivo: { type: "string" },
                protegida: { type: "boolean" },
              },
              required: ["accion"],
            },
          },
          estado: {
            type: "object",
            description:
              "Claves de estado a fijar, p. ej. {\"nivel_lesion\": \"1\", \"bloque\": \"base-2\"}. " +
              "Valor null borra la clave. Cada valor ≤300 caracteres: es un dato, no un diario; " +
              "la explicación va en 'mensaje'.",
            additionalProperties: { type: ["string", "number", "null"] },
          },
          pendientes: {
            type: "array",
            description:
              "Backlog: {accion:'añadir', texto (≤400), resumen? (≤400), vence? (YYYY-MM-DD: " +
              "caduca solo; o \"cond: <la condición>\", que no fija fecha y deja la red de los " +
              "90 días sin tocarse)}, {accion:'actualizar', id, texto?, resumen?, vence?} (conserva el " +
              "id, que se cita desde reglas y disparadores) o {accion:'resolver', id}.",
            items: {
              type: "object",
              properties: {
                accion: { type: "string", enum: ["añadir", "anadir", "actualizar", "resolver"] },
                id: { type: "number" },
                texto: { type: "string" },
                resumen: { type: ["string", "null"] },
                vence: { type: ["string", "null"] },
              },
              required: ["accion"],
            },
          },
          disparadores: {
            type: "array",
            description:
              "Acciones en fecha futura (antiguos [REVISAR]): {accion:'añadir', fecha, " +
              "accion_texto (≤1500)} o {accion:'completar'|'cancelar', id}.",
            items: {
              type: "object",
              properties: {
                accion: { type: "string", enum: ["añadir", "anadir", "completar", "cancelar"] },
                id: { type: "number" },
                fecha: { type: "string" },
                accion_texto: { type: "string" },
              },
              required: ["accion"],
            },
          },
          condiciones: {
            type: "array",
            description:
              "Condiciones especiales (antiguos [NOTA]: viaje, molestia, semana intensa): " +
              "{accion:'añadir', texto, desde?, hasta?} o {accion:'cerrar', id}.",
            items: {
              type: "object",
              properties: {
                accion: { type: "string", enum: ["añadir", "anadir", "cerrar"] },
                id: { type: "number" },
                texto: { type: "string" },
                desde: { type: ["string", "null"] },
                hasta: { type: ["string", "null"] },
              },
              required: ["accion"],
            },
          },
          carreras: {
            type: "array",
            description:
              "Objetivos con fecha: {accion:'añadir', nombre, fecha?, distancia_km?, " +
              "desnivel_m?, prioridad? (A|B|C), estado? (candidata|confirmada), notas? (≤600)} o " +
              "{accion:'actualizar'|'completar'|'cancelar', id, …campos}. Una carrera, una " +
              "ficha: si la fecha coincide con otra activa, la respuesta lo avisa.",
            items: {
              type: "object",
              properties: {
                accion: {
                  type: "string",
                  enum: ["añadir", "anadir", "actualizar", "completar", "cancelar"],
                },
                id: { type: "number" },
                nombre: { type: "string" },
                fecha: { type: ["string", "null"] },
                distancia_km: { type: ["number", "null"] },
                desnivel_m: { type: ["number", "null"] },
                prioridad: { type: ["string", "null"] },
                estado: { type: "string" },
                resultado: { type: ["string", "null"] },
                notas: { type: ["string", "null"] },
              },
              required: ["accion"],
            },
          },
        },
        required: ["mensaje"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Commit del contrato" },
      run: (args) => contract.contractCommit(args as unknown as CommitInput),
    },
    {
      name: "get_material",
      title: "Material del atleta",
      description:
        "El inventario de lo que el atleta TIENE, por categorías (running, fuerza, " +
        "recuperación… las elige él), con para qué sirve cada cosa y su id. Llámala ANTES " +
        "de recomendar cualquier cosa que necesite material: una terapia, un ejercicio de " +
        "fuerza, qué llevar a una tirada larga. Recomendar sobre material supuesto es " +
        "prescribir a ciegas; si algo no está en la lista, no lo tiene. get_contract ya " +
        "trae el resumen con los nombres: esta herramienta añade el detalle de cada cosa.",
      inputSchema: {
        type: "object",
        properties: {
          categoria: {
            type: "string",
            description:
              "Filtrar por categoría (running, recuperación…). Sin esto, el inventario entero.",
          },
          incluir_retirados: {
            type: "boolean",
            description:
              "Añade lo retirado (zapatillas gastadas, material roto). Falso por defecto: " +
              "sirve para explicar el pasado, no para prescribir el presente.",
          },
        },
      },
      annotations: { readOnlyHint: true, title: "Material del atleta" },
      run: (args) => material.getMaterial(args.categoria ?? null, args.incluir_retirados ?? false),
    },
    {
      name: "set_material",
      title: "Actualizar material",
      description:
        "Da de alta, modifica, retira o reactiva material del inventario. Úsala cuando el " +
        "atleta cuente que tiene algo nuevo, que algo se gastó o que ya no lo usa: el " +
        "inventario solo sirve si está al día. Nada se borra: lo retirado sigue explicando " +
        "los entrenos de hace meses. Dar de alta algo que ya existe en la misma categoría " +
        "lo actualiza (y lo reactiva si estaba retirado) en vez de duplicarlo.",
      inputSchema: {
        type: "object",
        properties: {
          articulos: {
            type: "array",
            description:
              "Lista de cambios. Alta o actualización: {accion:'añadir', categoria, nombre, " +
              "detalle? (PARA QUÉ sirve, no solo qué es: es lo que se lee al buscar con qué " +
              "hacer una terapia), desde? (YYYY-MM-DD)}. Sobre algo que ya existe, por su id " +
              "(columna '#' de get_material): {accion:'retirar'|'reactivar', id} o " +
              "{accion:'editar', id, nombre?, categoria?, detalle?, desde?}.",
            items: {
              type: "object",
              properties: {
                accion: {
                  type: "string",
                  enum: ["añadir", "anadir", "actualizar", "editar", "retirar", "reactivar"],
                },
                id: { type: "number" },
                categoria: { type: "string" },
                nombre: { type: "string" },
                detalle: { type: "string" },
                desde: { type: ["string", "null"] },
              },
            },
          },
        },
        required: ["articulos"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Actualizar material" },
      run: (args) => material.setMaterial(args.articulos, new Date().toISOString()),
    },
    {
      name: "set_plan_publico",
      title: "Plan de la página pública",
      description:
        "Lo que la página pública no puede sacar de los datos: los km de carrera " +
        "PLANIFICADOS de cada semana (Garmin planifica por tiempo, así que este número no " +
        "existe en otro sitio), las fechas de las temporadas 0-4, el día D y los hitos " +
        "manuales. Llámala al cargar cada semana, ANTES de su lunes: el planificado se " +
        "congela ese día para que la gráfica compare con el plan original y no con el " +
        "corregido (el propio lunes solo se acepta si la semana aún no tenía plan). Todo o " +
        "nada: si un cambio no vale, no se escribe ninguno. Sin argumentos devuelve lo que " +
        "hay. Los hitos por distancia (>referencia, 42,2, 50, 70 y 120 km) caen solos; a " +
        "mano solo la primera salida de noche, o uno que el GPS midió corto.",
      inputSchema: {
        type: "object",
        properties: {
          semanas: {
            type: "array",
            description:
              "Km planificados por semana: [{lunes: 'YYYY-MM-DD' (un lunes), km: número}]. " +
              "Solo km de carrera (Run, TrailRun, VirtualRun); caminatas fuera. 0 es una " +
              "semana de descanso planificada, que no es lo mismo que no tener plan.",
            items: {
              type: "object",
              properties: { lunes: { type: "string" }, km: { type: "number" } },
              required: ["lunes", "km"],
            },
          },
          temporadas: {
            type: "array",
            description:
              "Cambios de temporada: [{numero: 0-4, nombre?, desde?, hasta?}]. Tienen que " +
              "quedar contiguas (cada una empieza el día después de que acabe la anterior) " +
              "y la 4 termina el día D.",
            items: {
              type: "object",
              properties: {
                numero: { type: "number" },
                nombre: { type: "string" },
                desde: { type: "string" },
                hasta: { type: "string" },
              },
              required: ["numero"],
            },
          },
          dia_d: {
            type: "string",
            description:
              "Fecha del intento, YYYY-MM-DD, siempre sábado o domingo. Mueve con ella el " +
              "final de la T4.",
          },
          hitos: {
            type: "array",
            description:
              "Hitos marcados a mano: [{clave, fecha: 'YYYY-MM-DD' o null para quitarlo}]. " +
              "Claves: supera_referencia, maraton, km50, km70, km120, noche.",
            items: {
              type: "object",
              properties: { clave: { type: "string" }, fecha: { type: ["string", "null"] } },
              required: ["clave"],
            },
          },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Plan de la página pública" },
      run: (args) => publico.setPlanPublico(args, new Date().toISOString()),
    },
    {
      name: "get_log",
      title: "Log del contrato",
      description:
        "Historial append-only de acuerdos y commits, más reciente primero. El log es la " +
        "verdad histórica del sistema: nunca se edita ni se borra. Úsalo para reconstruir " +
        "contexto, auditar decisiones o la compactación semestral.\n" +
        "Sin parámetros devuelve un ÍNDICE: una línea por entrada (versión · fecha · " +
        "principio del mensaje · qué tocó). Las entradas enteras se piden con version: N " +
        "(una) o desde/hasta (rango de fechas YYYY-MM-DD o de versiones); buscar: \"texto\" " +
        "filtra por contenido y enseña el fragmento que coincide.",
      inputSchema: {
        type: "object",
        properties: {
          version: {
            type: ["number", "string"],
            description: "Una entrada entera, por su versión (133 o \"v133\").",
          },
          desde: {
            type: ["string", "number"],
            description: "Entradas enteras desde esta fecha (YYYY-MM-DD) o versión, inclusive.",
          },
          hasta: {
            type: ["string", "number"],
            description: "…hasta esta fecha o versión, inclusive.",
          },
          buscar: {
            type: "string",
            description: "Filtro por texto en mensaje y cambios; devuelve el índice de las coincidencias.",
          },
          limit: {
            type: "number",
            description: "Cuántas entradas devolver (1-200; 40 en el índice, 200 en un rango).",
          },
          antes_de: {
            type: "string",
            description: "Índice: solo entradas con fecha anterior a este día (YYYY-MM-DD), para paginar.",
          },
        },
      },
      annotations: { readOnlyHint: true, title: "Log del contrato" },
      run: (args) =>
        contract.getLog({
          limit: args.limit, antes_de: args.antes_de, version: args.version,
          desde: args.desde, hasta: args.hasta, buscar: args.buscar,
        }),
    },

    // ----------------------------------------------------------- bienestar
    {
      name: "get_wellness",
      title: "Bienestar diario",
      description:
        "Bienestar día a día desde intervals.icu: sueño (duración y fases), HRV, pulso en " +
        "reposo, Body Battery, Training Readiness, peso, pasos y forma (CTL, ATL, TSB), más " +
        "las columnas del DIARIO de la app (lo que registres con set_wellness: dolor, " +
        "síntomas…), en la misma tabla y sobre el mismo eje de fechas, que es lo que permite " +
        "leer una molestia contra la carga. Úsala para saber cómo está el atleta antes de " +
        "proponer o ajustar entrenos.",
      inputSchema: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Número de días hacia atrás, incluido hoy (1-120). Por defecto 14.",
          },
        },
      },
      annotations: { readOnlyHint: true, title: "Bienestar diario" },
      run: (args) => intervals.getWellness(env.DB, args.days ?? 14),
    },
    {
      name: "set_wellness",
      title: "Registrar bienestar",
      description:
        "Escribe el bienestar SUBJETIVO de un día (crea el registro si no existe y solo toca " +
        "lo que pases). Sirve para que el dolor, la fatiga o una molestia dejen de ser prosa " +
        "y pasen a una serie que se lee contra la carga. Escribe en DOS sitios: los campos " +
        "con nombre propio (fatiga, estres, animo, motivacion, dolor_muscular, lesion, " +
        "calidad_sueno, comentarios) van a intervals.icu en su escala 1-4; 'campos' va al " +
        "DIARIO de la app, que es donde viven las escalas propias (dolor 0-10, síntomas " +
        "sí/no, dolor de una lesión) porque la API de intervals.icu no deja crearlas desde " +
        "fuera. Un campo del diario hay que DECLARARLO antes con 'definir' (se puede en la " +
        "misma llamada): escribir uno sin declarar es un error y no se guarda nada, para que " +
        "una errata no cree una serie fantasma. Lo objetivo (sueño, HRV, pulso en reposo, " +
        "peso) lo sincroniza Garmin y NO se toca desde aquí. Todo lo escrito sale luego en " +
        "get_wellness.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: 'Día, YYYY-MM-DD (o "hoy"/"ayer"). Por defecto hoy.' },
          fatiga: { type: "number", description: "Fatiga percibida, 1-4." },
          estres: { type: "number", description: "Estrés, 1-4." },
          animo: { type: "number", description: "Ánimo, 1-4." },
          motivacion: { type: "number", description: "Motivación, 1-4." },
          dolor_muscular: {
            type: "number",
            description: "Dolor muscular (soreness), 1-4. Para una escala 0-10 usa 'campos'.",
          },
          lesion: { type: "number", description: "Lesión / molestia (injury), 1-4." },
          calidad_sueno: { type: "number", description: "Calidad del sueño percibida, 1-4." },
          comentarios: {
            type: "string",
            description: "Texto libre del día (queda en el campo 'comments' de intervals.icu).",
          },
          campos: {
            type: "object",
            description:
              'Valores del diario de la app: {"dolor_lesion": 3, "sintomas": false}. Cada ' +
              "clave tiene que estar declarada (mira las que hay en get_wellness, o " +
              "decláralas con 'definir'). Un valor vacío o null BORRA la medición del día, " +
              "que no es lo mismo que apuntar un 0.",
          },
          definir: {
            type: "array",
            description:
              "Declarar campos del diario antes de usarlos, o cambiarles etiqueta/escala. " +
              'Cada uno: {campo (clave estable), etiqueta? (cabecera en la tabla), tipo ' +
              '("numero"|"si_no"|"texto"), minimo?, maximo?, descripcion? (qué significa el ' +
              '0 y qué el 10)}. Ejemplo: [{"campo": "dolor_lesion", "etiqueta": "lesión", ' +
              '"tipo": "numero", "minimo": 0, "maximo": 10, "descripcion": "0 nada, 10 ' +
              'insoportable"}]. Declarar es idempotente: repetirlo actualiza la definición ' +
              "y no borra el histórico.",
            items: { type: "object" },
          },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Registrar bienestar" },
      run: (args) => intervals.setWellness(env.DB, args),
    },
    {
      name: "get_activities",
      title: "Actividades recientes",
      description:
        "Actividades completadas: fecha, deporte, duración, distancia, desnivel, pulso " +
        "medio y máximo, ritmo, GAP, carga y RPE, más los totales por deporte. Devuelve " +
        "el id de cada actividad para pedir el detalle con get_activity.",
      inputSchema: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Número de días hacia atrás, incluido hoy (1-365). Por defecto 30.",
          },
        },
      },
      annotations: { readOnlyHint: true, title: "Actividades recientes" },
      run: (args) => intervals.getActivities(args.days ?? 30),
    },
    {
      name: "search_activities",
      title: "Buscar actividades",
      description:
        "Actividades que cumplen todos los filtros a la vez, con el mismo formato de tabla " +
        "que get_activities. Úsala para responder «¿cuántas tiradas de más de 20 km ha " +
        "hecho?» o «¿qué series ha hecho este mes?» sin traerte el periodo entero y leerlo " +
        "a mano. Los filtros se combinan con Y: una actividad sale solo si los cumple " +
        "todos, y una actividad sin el dato que filtras nunca se cuela.",
      inputSchema: {
        type: "object",
        properties: {
          sport: {
            type: "string",
            description: "Deporte: Run, Ride, Swim… (también vale en español: carrera, bici).",
          },
          days: {
            type: "number",
            description: "Días hacia atrás desde hoy si no pasas 'oldest' (1-3650). Por defecto 365.",
          },
          oldest: {
            type: "string",
            description: "Primer día del rango, YYYY-MM-DD. Si lo pasas, 'days' no se usa.",
          },
          newest: {
            type: "string",
            description: "Último día del rango, YYYY-MM-DD. Por defecto, hoy.",
          },
          min_km: { type: "number", description: "Distancia mínima en km." },
          max_km: { type: "number", description: "Distancia máxima en km." },
          min_minutes: { type: "number", description: "Duración mínima en minutos." },
          max_minutes: { type: "number", description: "Duración máxima en minutos." },
          min_elevation: { type: "number", description: "Desnivel positivo mínimo en metros." },
          min_avg_hr: { type: "number", description: "FC media mínima en ppm." },
          name_contains: {
            type: "string",
            description: "Texto que debe aparecer en el nombre (sin distinguir mayúsculas).",
          },
          sort: {
            type: "string",
            description:
              "Orden: fecha (más reciente), distancia (más larga), ritmo (más rápido) o carga.",
          },
          limit: { type: "number", description: "Número máximo de filas (1-200). Por defecto 50." },
        },
      },
      annotations: { readOnlyHint: true, title: "Buscar actividades" },
      run: (args) => intervals.searchActivities(args),
    },
    {
      name: "get_records",
      title: "Récords y máximos",
      description:
        "Máximos históricos con la fecha y el id de la actividad que produjo cada uno: FC " +
        "máxima, mejor FC media sostenida, mejores marcas por distancia y curva de ritmo. " +
        "Úsala SIEMPRE que necesites la FC máxima del atleta, una estimación de umbral o su " +
        "mejor marca, en vez de traerte actividades y leerlas fila a fila. Barre todo el " +
        "historial por defecto, así que no puede pasar que la mejor marca del atleta quede " +
        "fuera de la ventana consultada. Devuelve: (a) FC máxima absoluta, los 10 valores " +
        "más altos y el máximo de los últimos 30, 90 y 365 días; (b) mejor FC media " +
        "sostenida en 5, 10, 20, 30 y 60 minutos — la de 20 y 60 min es una estimación " +
        "directa del umbral; (c) mejores marcas en 1, 5, 10, 15, 21,1 y 42,2 km con tiempo, " +
        "ritmo, GAP, desnivel y FC media; (d) la curva de ritmo completa.",
      inputSchema: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description:
              "Ventana en días hacia atrás. Por defecto (sin valor) se barre el HISTÓRICO " +
              "COMPLETO, que es lo que hay que usar para récords.",
          },
          sport: {
            type: "string",
            description:
              "Deporte para las marcas por distancia y la curva de ritmo (la FC máxima se " +
              "calcula sobre todos los deportes). Por defecto Run.",
          },
        },
      },
      annotations: { readOnlyHint: true, title: "Récords y máximos" },
      run: (args) => intervals.getRecords(args.days ?? null, args.sport ?? "Run"),
    },
    {
      name: "get_activity",
      title: "Detalle de actividad",
      description:
        "Detalle de una actividad: métricas medias y máximas, potencia, carga, intensidad, " +
        "desacople aeróbico y factor de eficiencia, temperatura y sensación térmica, " +
        "tiempo en zonas (potencia, FC, ritmo, GAP) y lista de intervalos con ascenso, " +
        "pendiente media y desacople por vuelta. El desacople es el criterio con el que se " +
        "juzgan las tiradas largas (por debajo del 5% la durabilidad aguantó); la " +
        "temperatura hay que mirarla ANTES de interpretar pulsaciones altas. " +
        "intervals.icu no publica humedad: no la busques aquí.",
      inputSchema: {
        type: "object",
        properties: {
          activity_id: {
            type: "string",
            description: "Id de la actividad, como i123456789 (lo da get_activities).",
          },
        },
        required: ["activity_id"],
      },
      annotations: { readOnlyHint: true, title: "Detalle de actividad" },
      run: (args) => intervals.getActivity(args.activity_id),
    },
    {
      name: "get_activity_streams",
      title: "Series de la actividad",
      description:
        "La serie punto a punto de una actividad —altitud, FC, ritmo, cadencia, potencia, " +
        "temperatura y distancia— remuestreada en tramos para que quepa en el contexto. " +
        "Úsala cuando la media de la sesión o la de la vuelta no baste: dónde deja de " +
        "empinarse una rampa, el perfil de pendiente por tramos de una ruta, o mirar un " +
        "criterio por segmento en vez de por actividad entera. Cada fila es un TRAMO " +
        "agregado (el ritmo es distancia/tiempo del tramo, la FC su media), no una muestra " +
        "suelta. Sin resolución elige una automática de ~120 filas. Para un lap concreto " +
        "pasa 'vuelta' con el número de la columna '#' de get_activity: es mucho más barato " +
        "que traerse la actividad entera fina.",
      inputSchema: {
        type: "object",
        properties: {
          activity_id: {
            type: "string",
            description: "Id de la actividad, como i123456789 (lo da get_activities).",
          },
          cada_segundos: {
            type: "number",
            description:
              "Remuestrear cada N segundos (1-3600). Excluyente con 'cada_metros'. " +
              "Sin ninguno de los dos se elige un paso automático.",
          },
          cada_metros: {
            type: "number",
            description:
              "Remuestrear cada N metros (5-10000), útil para perfiles de pendiente. " +
              "Excluyente con 'cada_segundos'. Son METROS de verdad, no la trampa de " +
              "intervals.icu donde 'm' son minutos.",
          },
          vuelta: {
            type: "number",
            description:
              "Recortar a una sola vuelta: el número de la columna '#' de get_activity.",
          },
        },
        required: ["activity_id"],
      },
      annotations: { readOnlyHint: true, title: "Series de la actividad" },
      run: (args) =>
        intervals.getActivityStreams(
          args.activity_id,
          args.cada_segundos ?? null,
          args.cada_metros ?? null,
          args.vuelta ?? null,
        ),
    },
    {
      name: "get_weekly_summary",
      title: "Resumen semanal",
      description:
        "Totales por semana (lunes a domingo) y por deporte: sesiones, tiempo, distancia, " +
        "desnivel y carga, con una fila TOTAL por semana. Úsala para ver progresión de " +
        "volumen y carga antes de planificar.",
      inputSchema: {
        type: "object",
        properties: {
          weeks: {
            type: "number",
            description: "Número de semanas hacia atrás, incluida la actual (1-52). Por defecto 8.",
          },
        },
      },
      annotations: { readOnlyHint: true, title: "Resumen semanal" },
      run: (args) => intervals.getWeeklySummary(args.weeks ?? 8),
    },
    {
      name: "get_streaks",
      title: "Rachas",
      description:
        "Rachas de constancia: días seguidos en movimiento (actividad de ≥15 min), días " +
        "cumpliendo el plan, noches durmiendo lo suficiente y semanas con suficientes días " +
        "activos, cada una con su mejor marca, más un calendario ASCII de las últimas " +
        "cuatro semanas. Reglas del cálculo: el descanso solo cuenta como cumplido si está " +
        "escrito en el calendario (HOLIDAY/SICK/INJURED o nota de descanso), un día vacío " +
        "es un día perdido, y ni hoy ni la semana en curso rompen nada hasta que acaban. " +
        "Úsala cuando la conversación vaya de constancia, cuando propongas un descanso (para " +
        "decir qué se rompe y qué no) o cuando el atleta pregunte cómo lleva la racha. " +
        "Si avisa de días encadenados sin uno suave, atiende el aviso: la racha NUNCA es " +
        "argumento para entrenar.",
      inputSchema: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "Ventana en días hacia atrás, incluido hoy (14-365). Por defecto 120.",
          },
          min_minutos: {
            type: "number",
            description:
              "Duración mínima (minutos) de una actividad para que el día cuente como " +
              "activo (1-120). Por defecto 15.",
          },
        },
      },
      // readOnlyHint sigue siendo cierto de cara al atleta: lo único que
      // escribe es el resumen diario, una caché de lo que ya hay en intervals.
      annotations: { readOnlyHint: true, title: "Rachas" },
      run: (args) =>
        intervals.getStreaks(env.DB, args.days ?? 120, args.min_minutos ?? null, enSegundoPlano),
    },

    // ------------------------------------------------------------- eventos
    {
      name: "list_events",
      title: "Calendario",
      description:
        "Calendario de intervals.icu: entrenos planificados, notas, carreras y días " +
        "especiales, con duración, carga y número de pasos de cada entreno. Dos modos: " +
        "ventana relativa a hoy (days_back/days_ahead) o rango absoluto (oldest/newest). " +
        "La tabla resume; con full_notes=true devuelve además las descripciones completas.",
      inputSchema: {
        type: "object",
        properties: {
          days_back: {
            type: "number",
            description: "Días hacia atrás desde hoy (0-180). Se ignora si pasas 'oldest'. Por defecto 7.",
          },
          days_ahead: {
            type: "number",
            description:
              "Días hacia adelante desde hoy (0-365). Se ignora si pasas 'oldest' o 'newest'. Por defecto 21.",
          },
          oldest: {
            type: "string",
            description:
              "Primer día del rango, YYYY-MM-DD. Si lo pasas, days_back y days_ahead no se usan.",
          },
          newest: {
            type: "string",
            description: "Último día del rango, YYYY-MM-DD. Si solo pasas 'oldest', se lee ese único día.",
          },
          full_notes: {
            type: "boolean",
            description:
              "Añade al final el texto ÍNTEGRO de cada descripción, con sus saltos de línea. " +
              "Sin esto la columna 'detalle' viene recortada a 60 caracteres: úsalo siempre " +
              "que necesites leer el contenido de una nota, no solo saber que existe.",
          },
        },
      },
      annotations: { readOnlyHint: true, title: "Calendario" },
      run: (args) =>
        intervals.listEvents(
          args.days_back ?? 7,
          args.days_ahead ?? 21,
          args.oldest ?? null,
          args.newest ?? null,
          args.full_notes ?? false,
        ),
    },
    {
      name: "get_event",
      title: "Detalle de evento",
      description:
        "Un evento del calendario con su descripción ÍNTEGRA, sin recortar y conservando " +
        "los saltos de línea. Úsala cuando list_events te muestre una nota truncada.",
      inputSchema: {
        type: "object",
        properties: {
          event_id: {
            type: "string",
            description: "Id del evento, el de la columna 'id' de list_events.",
          },
        },
        required: ["event_id"],
      },
      annotations: { readOnlyHint: true, title: "Detalle de evento" },
      run: (args) => intervals.getEvent(args.event_id),
    },
    {
      name: "create_workout",
      title: "Crear entreno",
      description:
        "Crea un entreno estructurado en el calendario de intervals.icu, que lo empuja a " +
        "Garmin Connect y al reloj (si la sincronización está activada). Escribe siempre " +
        'distancias en metros como "400mtr": en intervals.icu "400m" significa 400 minutos. ' +
        "Cada paso lleva nombre (label): es lo que aparece en el reloj. " +
        "intervals.icu no guarda lo que se le manda, lo INTERPRETA: la respuesta compara los " +
        "pasos y la duración enviados con los que ha entendido, y AVISA si no cuadran. Si sale " +
        "un aviso, el entreno del calendario no es el que pediste: léelo antes de darlo por " +
        "escrito.",
      inputSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: 'Fecha del entreno, YYYY-MM-DD (también vale "hoy" o "mañana").',
          },
          sport: {
            type: "string",
            description: "Deporte: Run, Ride, VirtualRide, Swim, Walk, Hike, WeightTraining…",
          },
          name: { type: "string", description: "Título que se verá en el calendario y en el reloj." },
          description: {
            type: "string",
            description:
              "Texto libre (objetivo de la sesión, propósito fisiológico, criterio de éxito). " +
              "Se añade al final. Si no pasas 'steps', puedes escribir aquí directamente la " +
              "sintaxis de intervals.icu y se enviará tal cual.",
          },
          steps: {
            type: "array",
            description:
              "Pasos del entreno, en orden. Cada paso es un objeto. " +
              'Duración (una de las dos): "duration" ("10m", "1h30m", "5m30s", "45s", "5:00" ' +
              'o un número de segundos) o "distance" ("400mtr", "5km", "3mi", "100yrd" o un ' +
              'número en metros). "lap_press" NO existe aquí: intervals.icu descarta el paso ' +
              "sin avisar; si necesitas que acabe con el botón de vuelta, usa " +
              "garmin_create_workout. " +
              `Objetivo (elige uno): "power_pct" (% del FTP, ${rangoNota}), "watts", ` +
              '"hr_pct" (% de FC), "bpm", "pace_pct" (% del ritmo umbral), "pace" ' +
              '(ritmo absoluto: "5:00/km", "8:00/mi", "1:45/100m"), "zone" ("Z2" con ' +
              '"zone_kind": "power"|"hr"|"pace"), "ramp" ([50, 75] con "kind"), "free": true, ' +
              'o "target" con el texto crudo de intervals.icu. ' +
              'Extras por paso: "label" (nombre visible en el reloj), "cadence", "rest" ' +
              '("30s"), "intensity" ("warmup"|"active"|"rest"|"cooldown"). ' +
              'Agrupar y repetir: {"section": "Calentamiento", "steps": [...]} y ' +
              '{"section": "Series", "repeat": 5, "steps": [...]}. ' +
              'Ejemplo: [{"section": "Calentamiento", "steps": [{"duration": "12m", ' +
              '"zone": "Z2", "zone_kind": "hr", "label": "Rodaje suave"}]}, ' +
              '{"section": "Series", "repeat": 5, "steps": [{"distance": "1km", ' +
              '"pace_pct": [103, 107], "label": "Ritmo 10K"}, {"duration": "2m", ' +
              '"zone": "Z1", "zone_kind": "hr", "label": "Trote de vuelta"}]}, ' +
              '{"section": "Vuelta a la calma", "steps": [{"duration": "10m", "free": true, ' +
              '"label": "Suave"}]}]',
            items: { type: "object" },
          },
        },
        required: ["date", "sport", "name"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Crear entreno" },
      run: (args) =>
        intervals.createWorkout(args.date, args.sport, args.name, args.description ?? "", args.steps ?? null),
    },
    {
      name: "create_note",
      title: "Crear nota",
      description:
        "Crea una nota en el calendario de intervals.icu. OJO: el contexto de " +
        "entrenamiento (viajes, molestias, acuerdos) ya NO se guarda como notas: usa " +
        "contract_commit con 'condiciones' o el log. Esta herramienta queda para notas " +
        "operativas que deban verse en el calendario de intervals/Garmin.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: 'Fecha de la nota, YYYY-MM-DD (o "hoy"/"mañana").' },
          text: { type: "string", description: "Contenido. La primera línea se usa como título." },
        },
        required: ["date", "text"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Crear nota" },
      run: (args) => intervals.createNote(args.date, args.text),
    },
    {
      name: "update_event",
      title: "Modificar evento",
      description:
        "Reescribe un evento que ya existe en el calendario de intervals.icu: contenido, " +
        "título o fecha. Devuelve el estado anterior y el nuevo. Los campos que no pases " +
        "se quedan como estaban.",
      inputSchema: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "Id del evento (columna 'id' de list_events)." },
          text: {
            type: "string",
            description:
              "Contenido nuevo, que SUSTITUYE por completo al anterior. Si no pasas 'name', " +
              "el título se toma de la primera línea.",
          },
          name: { type: "string", description: "Título nuevo para el calendario y el reloj." },
          date: { type: "string", description: 'Mover el evento a otro día, YYYY-MM-DD (o "hoy").' },
        },
        required: ["event_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Modificar evento" },
      run: (args) => intervals.updateEvent(args.event_id, args.text, args.name, args.date),
    },
    {
      name: "delete_event",
      title: "Borrar evento",
      description:
        "Elimina un evento del calendario de intervals.icu. Irreversible: no hay papelera. " +
        "Sin confirm=true no borra nada, solo describe el evento señalado. Las sesiones " +
        "canceladas SE BORRAN, no se anotan: lo que queda en el calendario se ejecuta.",
      inputSchema: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "Id del evento (columna 'id' de list_events)." },
          confirm: {
            type: "boolean",
            description:
              "Falso por defecto: la primera llamada solo muestra qué se borraría. " +
              "Repite con true para borrarlo de verdad.",
          },
        },
        required: ["event_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, title: "Borrar evento" },
      run: (args) => intervals.deleteEvent(args.event_id, args.confirm ?? false),
    },

    // ------------------------------------------------------------- ajustes
    {
      name: "get_athlete_settings",
      title: "Ajustes del atleta",
      description:
        "Perfil y ajustes por deporte de intervals.icu: LTHR, FC máxima, zonas de FC, " +
        "ritmo umbral, zonas de ritmo, FTP y peso. De aquí salen las ZONAS y el peso. Para el " +
        "umbral con el que se prescribe manda Garmin: usa garmin_thresholds, y si los dos " +
        "no coinciden fíate de Garmin. Nunca los leas de la memoria de otra conversación.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, title: "Ajustes del atleta" },
      run: () => intervals.getAthleteSettings(),
    },
    {
      name: "update_athlete_settings",
      title: "Modificar ajustes del atleta",
      description:
        "Cambia ajustes de un deporte en intervals.icu (p. ej. LTHR tras un test válido). " +
        "Sin confirm=true muestra el antes/después y no cambia nada. Los umbrales " +
        "gobiernan todas las prescripciones: cámbialos solo con evidencia convergente.",
      inputSchema: {
        type: "object",
        properties: {
          sport: { type: "string", description: "Deporte cuyos ajustes se tocan (Run, Ride, Swim…)." },
          fields: {
            type: "object",
            description:
              'Campos a cambiar tal y como los nombra la API, p. ej. {"lthr": 193, "max_hr": 206}.',
          },
          confirm: {
            type: "boolean",
            description: "Falso por defecto: solo vista previa. true aplica los cambios.",
          },
        },
        required: ["sport", "fields"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Modificar ajustes del atleta" },
      run: (args) => intervals.updateAthleteSettings(args.sport, args.fields, args.confirm ?? false),
    },

    // ------------------------------------------------------------- Garmin
    // ----------------------------------------------------- diario (D1)
    {
      name: "diary_set",
      title: "Escribir en el diario",
      description:
        "Diario subjetivo de la app: dolor 0-10 de una lesión, síntomas sí/no, notas. Es el " +
        "sensor de lo que Garmin no mide. Un campo se DECLARA una vez con 'definir' (su escala) " +
        "y luego se escribe en 'campos'; escribir uno sin declarar es un error y no se guarda " +
        "nada. Un valor vacío borra la medición (no es un cero).",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: 'YYYY-MM-DD, "hoy" o "ayer". Por defecto hoy.' },
          campos: {
            type: "object",
            description: '{"dolor_lesion": 3, "sintomas": false, "nota": "texto"}.',
          },
          definir: {
            type: "array",
            description:
              'Declaraciones: [{"campo": "dolor_lesion", "etiqueta": "lesión", "tipo": ' +
              '"numero" | "si_no" | "texto", "minimo": 0, "maximo": 10, "descripcion": ' +
              '"qué es el 0 y qué el 10"}].',
            items: { type: "object" },
          },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Escribir en el diario" },
      run: (args) => diario.escribir(args),
    },
    {
      name: "diary_get",
      title: "Leer el diario",
      description:
        "El diario subjetivo de los últimos días (por defecto 14), con la escala de cada campo. " +
        "Léelo antes de subir carga sobre una lesión: el dolor a las 48 h es el dato que decide.",
      inputSchema: {
        type: "object",
        properties: { days: { type: "number", description: "Días hacia atrás (1-120, por defecto 14)." } },
      },
      annotations: { readOnlyHint: true, title: "Leer el diario" },
      run: (args) => diario.leer(args),
    },
    // --------------------------------------------- histórico de Garmin (D1)
    {
      name: "garmin_weekly_summary",
      title: "Resumen semanal (histórico de Garmin)",
      description:
        "Volumen y carga por semana (lunes a domingo) desde el histórico de Garmin guardado en " +
        "la app: sesiones, horas, km corriendo y a pie, desnivel, carga, y CTL/ATL/TSB (medias de " +
        "42 y 7 días sobre la carga de Garmin). Empieza diciendo cuánto histórico hay detrás. " +
        "Sustituye a get_weekly_summary de intervals.",
      inputSchema: {
        type: "object",
        properties: { weeks: { type: "number", description: "Semanas (1-52, por defecto 8)." } },
      },
      annotations: { readOnlyHint: true, title: "Resumen semanal" },
      run: (args) => historico.semanal(args),
    },
    {
      name: "garmin_records",
      title: "Mejores marcas (histórico de Garmin)",
      description:
        "Mejores tiempos en carrera para 400 m, 800 m, 1 km, milla, 3K, 5K, 10K, media y " +
        "maratón, sacados de las SERIES de cada actividad (no solo de los récords oficiales de " +
        "Garmin), y las 5 FC máximas más altas con su fecha. Úsala para anclar ritmos, umbral " +
        "y FC máxima: una ventana corta da una imagen falsa del atleta. 'from' (YYYY-MM-DD) " +
        "limita a lo reciente.",
      inputSchema: {
        type: "object",
        properties: { from: { type: "string", description: "Opcional: solo desde esta fecha." } },
      },
      annotations: { readOnlyHint: true, title: "Mejores marcas" },
      run: (args) => historico.marcas(args),
    },
    {
      name: "garmin_wellness_history",
      title: "Bienestar largo (histórico de Garmin)",
      description:
        "Bandas de FC en reposo, VFC y sueño (mediana, media ± DE, p10-p90) sobre una ventana " +
        "larga (por defecto 120 días), el peso y los últimos 14 días en tabla. Es la base para " +
        "calibrar cortes de bienestar: nunca en la propia mediana. Dice con cuántos días reales " +
        "se calculó.",
      inputSchema: {
        type: "object",
        properties: { days: { type: "number", description: "Ventana en días (7-365, por defecto 120)." } },
      },
      annotations: { readOnlyHint: true, title: "Bienestar largo" },
      run: (args) => historico.bienestar(args),
    },
    {
      name: "garmin_search_activities",
      title: "Buscar en el histórico de Garmin",
      description:
        "Filtra el histórico sin traerse el periodo entero: deporte ('correr' para todo lo de " +
        "carrera, o un tipo de Garmin como 'walking'), fechas, distancia y duración mínimas. Da " +
        "totales y una tabla con ritmo, FC, desnivel, carga y DESACOPLE aeróbico de cada una.",
      inputSchema: {
        type: "object",
        properties: {
          sport: { type: "string" },
          from: { type: "string", description: "YYYY-MM-DD" },
          to: { type: "string", description: "YYYY-MM-DD" },
          min_km: { type: "number" },
          min_minutes: { type: "number" },
          limit: { type: "number", description: "Filas a enseñar (por defecto 30)." },
        },
      },
      annotations: { readOnlyHint: true, title: "Buscar actividades" },
      run: (args) => historico.buscar(args),
    },
    {
      name: "garmin_streaks",
      title: "Constancia (histórico de Garmin)",
      description:
        "Rachas de constancia (días seguidos en movimiento, cumplimiento del plan, sueño y " +
        "semanas) sobre el histórico de Garmin y su calendario. El descanso solo cuenta si está " +
        "ESCRITO en el calendario; hoy no rompe nada hasta que acabe. Una racha viva nunca es " +
        "razón para entrenar: si el bienestar pide parar, se para.",
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "number", description: "Ventana (14-365, por defecto 120)." },
          min_minutos: { type: "number", description: "Minutos mínimos para que un día cuente (por defecto 15)." },
        },
      },
      annotations: { readOnlyHint: true, title: "Constancia" },
      run: (args) => historico.rachas(args, (desde, hasta) => leerCalendario(garminCliente, desde, hasta)),
    },
    {
      name: "garmin_sync",
      title: "Sincronizar histórico de Garmin",
      description:
        "Trae de Garmin lo que falte al histórico de la app, con un presupuesto de llamadas " +
        "(por defecto 18, máximo 25: en el plan gratuito D1 admite 50 consultas por petición): primero lo reciente, luego la carga inicial hacia atrás. El " +
        "cron lo hace solo cada hora; úsala para adelantar la carga inicial o si el briefing dice " +
        "que el histórico va atrasado. Si Garmin limita (429), para y lo dice: no la repitas en " +
        "bucle.",
      inputSchema: {
        type: "object",
        properties: { budget: { type: "number", description: "Llamadas a Garmin (6-25)." } },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Sincronizar histórico" },
      run: (args) => historico.sync(args),
    },
    {
      name: "garmin_wellness",
      title: "Bienestar directo de Garmin",
      description:
        "Bienestar leído en vivo de Garmin: readiness, Body Battery, sueño, HRV, FC en reposo, " +
        "estrés y pasos en una línea por día, y al pie el detalle del día más reciente: fases " +
        "del sueño, SpO₂, respiración, estado de entrenamiento con carga aguda/crónica y " +
        "VO₂máx. Ventana corta a propósito (máximo 7 días): son seis llamadas a Garmin por " +
        "día. Para series largas y bandas, garmin_wellness_history.",
      inputSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: 'Último día de la ventana, YYYY-MM-DD (o "hoy"). Por defecto, hoy.',
          },
          days: {
            type: "number",
            description: "Cuántos días hacia atrás contando ese (1-7, por defecto 1).",
          },
        },
      },
      annotations: { readOnlyHint: true, title: "Bienestar de Garmin" },
      run: (args) => garmin.bienestar(args),
    },
    {
      name: "garmin_thresholds",
      title: "Umbrales del atleta",
      description:
        "Los umbrales de un deporte —FC de umbral (LTHR), FC máxima, FTP y ritmo de umbral— " +
        "con la fuente de cada uno. MANDA Garmin, que es el origen de los datos y lo que " +
        "acaba en el reloj; intervals.icu sirve de respaldo cuando Garmin no tiene ese " +
        "umbral, y cuando los dos no coinciden se avisa con un ⚠. Enseña también las ZONAS de FC del reloj cuando Garmin las publica, que no tienen por qué ser las de intervals. " +
        "Son los que garmin_create_workout usa para convertir los porcentajes. Míralos antes " +
        "de prescribir en porcentaje: un umbral desactualizado no da error, escribe un paso " +
        "plausible y falso en el reloj.",
      inputSchema: {
        type: "object",
        properties: {
          sport: {
            type: "string",
            description: "Deporte cuyos umbrales se miran (Run, Ride, Swim…). Por defecto Run.",
          },
          debug: {
            type: "boolean",
            description:
              "Añade qué claves trae Garmin en su respuesta de zonas (solo los nombres, no " +
              "los valores). Sirve si las zonas no salen y hay que saber dónde mirar.",
          },
        },
      },
      annotations: { readOnlyHint: true, title: "Umbrales de Garmin" },
      run: (args) => garmin.verUmbrales(args),
    },
    {
      name: "garmin_activities",
      title: "Actividades de Garmin",
      description:
        "Las actividades tal y como las registró el reloj, sin pasar por intervals.icu. " +
        "Devuelve id, fecha, deporte, duración, distancia y FC. Para el detalle de una sesión " +
        "—y en fuerza, LAS SERIES: ejercicio, repeticiones y peso— usa garmin_activity con su " +
        "id. Para histórico largo y análisis, get_activities de intervals sigue siendo mejor.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Cuántas traer (1-50, por defecto 10)." },
          from: { type: "string", description: "Desde, YYYY-MM-DD. Opcional." },
          to: { type: "string", description: "Hasta, YYYY-MM-DD. Opcional." },
          sport: {
            type: "string",
            description:
              "Filtra por tipo de Garmin: running, cycling, strength_training… Opcional.",
          },
        },
      },
      annotations: { readOnlyHint: true, title: "Actividades de Garmin" },
      run: (args) => garmin.actividades(args),
    },
    {
      name: "garmin_activity",
      title: "Una actividad, con sus series",
      description:
        "El detalle de una actividad de Garmin y, si fue de FUERZA, sus series: ejercicio, " +
        "repeticiones, peso y tiempo, una a una, más el volumen total levantado. Este dato no " +
        "existe en intervals.icu, donde una sesión de fuerza es un bloque de minutos: es lo " +
        "que hace falta para subir una escalera de carga variable a variable. La columna «enum " +
        "de Garmin» es lo que hay que pasar como 'category' y 'exercise' al prescribir para " +
        "que el reloj enseñe el nombre del ejercicio.",
      inputSchema: {
        type: "object",
        properties: {
          activity_id: { type: "number", description: "Id de la actividad." },
        },
        required: ["activity_id"],
      },
      annotations: { readOnlyHint: true, title: "Actividad de Garmin" },
      run: (args) => garmin.actividad(args),
    },
    {
      name: "garmin_list_calendar",
      title: "Calendario de Garmin",
      description:
        "Qué hay escrito en el calendario de GARMIN entre dos fechas: entrenos programados, " +
        "actividades hechas y notas, con el id del entreno y el de la programación. " +
        "IMPRESCINDIBLE antes de programar nada en Garmin: list_events solo ve el calendario " +
        "de intervals.icu, así que lo que esté escrito aquí le parece un hueco vacío y la " +
        "semana se escribe dos veces. Son dos calendarios distintos y hay que mirar los dos. " +
        "Garmin sirve el calendario mes a mes: el rango se limita a 6 meses.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: 'Desde, YYYY-MM-DD (o "hoy"). Por defecto, hoy.' },
          to: {
            type: "string",
            description: "Hasta, YYYY-MM-DD. Por defecto, 13 días después de 'from'.",
          },
          debug: {
            type: "boolean",
            description:
              "Añade qué claves trae Garmin en cada tipo de item (solo los nombres, no los " +
              "valores). Sirve cuando una columna sale vacía y hay que saber dónde mirar.",
          },
        },
      },
      annotations: { readOnlyHint: true, title: "Calendario de Garmin" },
      run: (args) => garmin.calendario(args),
    },
    {
      name: "garmin_get_workout",
      title: "Leer un entreno de Garmin",
      description:
        "Un entreno de Garmin paso a paso, tal y como está guardado: tipo de paso, duración o " +
        "distancia, objetivo y la etiqueta que se leerá en el reloj. Es la única forma de " +
        "comprobar que lo escrito llegó íntegro: la duración total NO delata un paso perdido " +
        "si ese paso acababa con el botón de vuelta. Úsala después de crear un entreno que " +
        "importe, y para ver si algún paso saldrá sin nombre propio.",
      inputSchema: {
        type: "object",
        properties: {
          workout_id: { type: "number", description: "Id del entreno." },
        },
        required: ["workout_id"],
      },
      annotations: { readOnlyHint: true, title: "Leer entreno de Garmin" },
      run: (args) => garmin.verEntreno(args),
    },
    {
      name: "garmin_create_workout",
      title: "Crear entreno en Garmin",
      description:
        "Crea un entreno estructurado DIRECTAMENTE en Garmin Connect y lo programa si le das " +
        "fecha. Es la ruta por defecto: los pasos llegan al reloj tal como los escribes. Aquí " +
        "\"400m\", \"400mtr\" y 400 son METROS. Objetivos absolutos (watts, bpm, pace) o " +
        "zonas Z1-Z5; los rangos, como lista [min, max] (también \"140-155\" o " +
        "\"4:55-5:05/km\"). Los porcentajes (power_pct, hr_pct, pace_pct) se convierten con " +
        "los umbrales de Garmin y la respuesta dice cuál usó; si falta el umbral, no escribe " +
        "el entreno en vez de inventarlo. Garmin no tiene rampas dentro de un paso. Después, " +
        "garmin_get_workout y compara el número de pasos.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nombre del entreno: es lo que verás en el reloj." },
          sport: {
            type: "string",
            description: "Run, Ride, Swim, Walk, Hike, WeightTraining, Yoga, Rowing, Other…",
          },
          steps: {
            type: "array",
            description:
              'Pasos. Cada uno con duración ("duration": "10m") o distancia ("distance": ' +
              '"400mtr"), "label" (lo que se lee en el reloj), "intensity" (warmup, active, ' +
              'rest, cooldown) y un objetivo opcional: "watts", "bpm", "pace" ("4:30/km"), ' +
              '"zone" ("Z2"), "cadence", o en porcentaje "power_pct", "hr_pct" y "pace_pct" ' +
              "(en pace_pct, más porcentaje es más rápido). Para series: " +
              '{"repeat": 6, "steps": [...]}. En FUERZA, un paso lleva "reps" (repeticiones), ' +
              '"weight_kg" y el ejercicio del catálogo de Garmin en "category" y "exercise" ' +
              "(los enums que devuelve garmin_activity): sin ellos el reloj enseña un nombre " +
              "genérico por buena que sea la etiqueta.",
            items: { type: "object" },
          },
          date: {
            type: "string",
            description:
              'Opcional. YYYY-MM-DD (o "hoy") para dejarlo programado en el calendario de ' +
              "Garmin. Sin fecha queda en la biblioteca, sin llegar al reloj.",
          },
          description: { type: "string", description: "Nota del entreno, opcional." },
          allow_duplicate: {
            type: "boolean",
            description:
              "Falso por defecto: si ya hay un entreno con ese nombre, no crea otro y lo dice. " +
              "Garmin no tiene clave de idempotencia y un reintento tras un timeout duplicaría " +
              "la sesión.",
          },
        },
        required: ["name", "sport", "steps"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Crear entreno en Garmin" },
      run: (args) => garmin.crearEntreno(args),
    },
    {
      name: "garmin_schedule_workout",
      title: "Programar entreno de Garmin",
      description:
        "Pone un entreno que ya existe en Garmin en una fecha del calendario, para que el " +
        "reloj lo recoja en la próxima sincronización. OJO: lo programado aquí NO aparece en " +
        "intervals.icu ni en list_events, y su carga no entra en los CTL/ATL proyectados de " +
        "intervals. Para ver lo programado en Garmin, garmin_list_calendar.",
      inputSchema: {
        type: "object",
        properties: {
          workout_id: {
            type: "number",
            description: "Id del entreno (lo devuelve garmin_create_workout o el listado).",
          },
          date: { type: "string", description: 'Fecha YYYY-MM-DD (también vale "hoy").' },
        },
        required: ["workout_id", "date"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Programar en Garmin" },
      run: (args) => garmin.programarEntreno(args),
    },
    {
      name: "garmin_list_workouts",
      title: "Entrenos en Garmin",
      description:
        "Lista la biblioteca de entrenos de Garmin, con su id, para poder programarlos o " +
        "borrarlos. Los más recientes primero.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Cuántos traer (1-50, por defecto 10)." },
        },
      },
      annotations: { readOnlyHint: true, title: "Entrenos en Garmin" },
      run: (args) => garmin.listarEntrenos(args),
    },
    {
      name: "garmin_delete_workout",
      title: "Borrar entreno de Garmin",
      description:
        "Borra un entreno de la biblioteca de Garmin. Si estaba programado, desaparece " +
        "también del calendario. No toca nada de intervals.icu ni actividades ya hechas. " +
        "Sin confirm=true no borra: dice de qué entreno se trata para que se pueda comprobar " +
        "que el id es el correcto. No hay papelera.",
      inputSchema: {
        type: "object",
        properties: {
          workout_id: { type: "number", description: "Id del entreno que se borra." },
          confirm: {
            type: "boolean",
            description: "Falso por defecto: solo dice qué entreno es. true borra de verdad.",
          },
        },
        required: ["workout_id"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, title: "Borrar entreno de Garmin" },
      run: (args) => garmin.borrarEntreno(args),
    },
  ];

  return todas.filter(
    (t) =>
      (config.intervals || !HERRAMIENTAS_INTERVALS.has(t.name)) &&
      // La página pública calcula con intervals: sin él no se publica nada.
      ((conPublico && config.intervals) || !HERRAMIENTAS_PUBLICO.has(t.name)),
  );
}
