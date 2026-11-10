/**
 * El contrato de entrenamiento vive aquí: la app es la fuente de verdad.
 * Reemplaza la zona de sistema 2099 del calendario de intervals.icu.
 *
 * Garantías:
 *  - Todo cambio pasa por un commit atómico (D1 batch = transacción):
 *    log append-only + cambios + bump de versión, o nada.
 *  - El log NUNCA se actualiza ni se borra: solo INSERT y SELECT.
 *  - Las reglas y los pendientes con `vence` caducan solos: al leer, los
 *    vencidos se retiran y se registra la baja en el log en el mismo batch.
 *  - Los campos de texto del contrato tienen LÍMITE DE LONGITUD (LIMITES):
 *    superarlo rechaza el commit entero. La narrativa larga va en `mensaje`,
 *    que no tiene límite y se guarda íntegro en el log. Sin esto el contrato
 *    creció 8.000 caracteres al día hasta dejar de caber en una lectura.
 *  - EL CÓDIGO TOLERA UN ESQUEMA ATRASADO. Un despliegue puede llegar antes
 *    que su migración —pasó el 04/09/2026: el código de la 0006 salió a
 *    producción sin aplicarla y `get_contract` devolvió «no such column:
 *    vence», dejando al entrenador sin la lectura que el protocolo exige
 *    ANTES de prescribir. La lectura obligatoria no puede depender de que
 *    alguien se acuerde de migrar: se comprueba qué columnas existen de
 *    verdad (COLUMNAS_0006) y, si faltan, el contrato se lee igual con la
 *    función correspondiente desactivada y un aviso visible en la cabecera.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Límites duros por campo, en caracteres. Se aplican al escribir, nunca al
 * leer: lo que ya está en producción por encima del límite sigue leyéndose y
 * la vista compacta lo recorta. `mensaje` no tiene límite a propósito: es el
 * sitio correcto para todo lo que hasta ahora se colaba en el estado.
 */
import { addDays } from "../dates";

/**
 * Un pendiente sin `vence` explícito caduca solo a los tantos días de la última
 * vez que se tocó.
 *
 * Nace del contrato real del 16/09/2026: 47 pendientes abiertos, el más viejo
 * de hacía cinco semanas, y ninguno con fecha de caducidad porque ponerla es
 * opcional y nadie la pone. Cada uno cuesta una línea en TODAS las lecturas, y
 * el ancho de la vista compacta se reparte entre todas las entradas: un backlog
 * que solo crece acaba dejando las reglas en setenta caracteres.
 *
 * Se cuenta desde la última vez que se tocó, no desde que se creó, para que
 * trabajar un pendiente lo renueve. A los 60 días ya sale marcado ESTANCADO:
 * ese es el aviso, esto es la consecuencia. Y no se pierde nada —el cierre va
 * al log, que es append-only—, así que un pendiente caducado por error se
 * recupera leyéndolo y volviéndolo a abrir.
 */
export const DIAS_CADUCIDAD_PENDIENTE = 90;

export const LIMITES = {
  "estado.valor": 300,
  "reglas.resumen": 300,
  "reglas.contenido": 1500,
  "pendientes.texto": 400,
  "pendientes.resumen": 400,
  "carreras.notas": 600,
  "disparadores.accion_texto": 1500,
} as const;

/**
 * Columnas que añade la migración 0006. Si faltan, el contrato se sigue
 * leyendo: se apagan los resúmenes y la caducidad de pendientes, y nada más.
 * Se comprueban una a una (no «la 0006 sí/no») porque una migración puede
 * quedarse a medias y dejar unas columnas puestas y otras no.
 */
export const COLUMNAS_0006 = [
  "reglas.resumen",
  "pendientes.resumen",
  "pendientes.vence",
  "pendientes.actualizado_en",
] as const;

/** Par columna/valor para construir SQL que se salta lo que no existe. */
type Campo = [columna: string, valor: unknown];

/** Solo los campos cuya columna existe de verdad en la tabla. */
function conColumna(tabla: string, campos: Campo[], hay: Set<string>): Campo[] {
  return campos.filter(([columna]) => hay.has(`${tabla}.${columna}`));
}

/** INSERT que omite las columnas que el esquema todavía no tiene. */
function sqlInsert(tabla: string, campos: Campo[], hay: Set<string>): [string, unknown[]] {
  const usados = conColumna(tabla, campos, hay);
  return [
    `INSERT INTO ${tabla} (${usados.map(([c]) => c).join(", ")}) ` +
      `VALUES (${usados.map((_, i) => `?${i + 1}`).join(", ")})`,
    usados.map(([, valor]) => valor),
  ];
}

/** UPDATE ... SET con el mismo criterio; `where` usa los ?N que siguen. */
function sqlUpdate(
  tabla: string,
  campos: Campo[],
  where: (siguiente: number) => [string, unknown[]],
  hay: Set<string>,
): [string, unknown[]] {
  const usados = conColumna(tabla, campos, hay);
  const [condicion, bindsWhere] = where(usados.length + 1);
  return [
    `UPDATE ${tabla} SET ${usados.map(([c], i) => `${c} = ?${i + 1}`).join(", ")} WHERE ${condicion}`,
    [...usados.map(([, valor]) => valor), ...bindsWhere],
  ];
}

export interface Regla {
  id: string;
  tema: string;
  contenido: string;
  /** Mandato operativo en ≤300 caracteres; NULL en las anteriores a la migración 0006. */
  resumen: string | null;
  vence: string | null;
  estado: string;
  creada_en: string;
  creada_version: number;
  finalizada_en: string | null;
  finalizada_version: number | null;
  motivo_baja: string | null;
  /** 1 = doble llave (migración 0009): solo se toca con la frase textual del atleta. */
  protegida?: number | null;
}

export interface EstadoEntry {
  clave: string;
  valor: string;
  actualizado_en: string;
}

export interface LogEntry {
  id: number;
  fecha: string;
  version: number | null;
  mensaje: string;
  detalles: string | null;
  creado_en: string;
}

export interface Pendiente {
  id: number;
  texto: string;
  resumen: string | null;
  vence: string | null;
  estado: string;
  creado_en: string;
  /** NULL = nunca modificado desde que se creó (cuenta desde `creado_en`). */
  actualizado_en: string | null;
  resuelto_en: string | null;
}

export interface Disparador {
  id: number;
  fecha: string;
  accion: string;
  estado: string;
  creado_en: string;
  finalizado_en: string | null;
}

export interface Condicion {
  id: number;
  texto: string;
  desde: string | null;
  hasta: string | null;
  estado: string;
  creado_en: string;
  cerrado_en: string | null;
}

export interface Carrera {
  id: number;
  nombre: string;
  fecha: string | null;
  distancia_km: number | null;
  desnivel_m: number | null;
  prioridad: string | null;
  estado: string;
  resultado: string | null;
  notas: string | null;
  creado_en: string;
  actualizado_en: string;
}

export interface ContractSnapshot {
  version: number;
  ultimoCommit: string;
  hoy: string;
  /** Columnas de la 0006 que faltan en la base. Vacío = esquema al día. */
  columnasAusentes: string[];
  reglas: Regla[];
  bajasAutomaticas: Regla[];
  pendientesVencidosHoy: Pendiente[];
  estado: EstadoEntry[];
  pendientes: Pendiente[];
  disparadores: Disparador[];
  disparadoresVencidos: Disparador[];
  condiciones: Condicion[];
  carreras: Carrera[];
}

// ---- Cambios estructurados que acepta un commit ----

export interface CambioRegla {
  accion: "crear" | "modificar" | "retirar";
  id?: string;
  tema?: string;
  contenido?: string;
  resumen?: string | null;
  vence?: string | null; // YYYY-MM-DD o "nunca"/null
  motivo?: string;
  /** Doble llave: crearla o cambiar la marca exige `cita_textual` en el commit. */
  protegida?: boolean;
}

export interface CambioPendiente {
  accion: "añadir" | "anadir" | "actualizar" | "resolver";
  id?: number;
  texto?: string;
  resumen?: string | null;
  vence?: string | null;
}

export interface CambioDisparador {
  accion: "añadir" | "anadir" | "completar" | "cancelar";
  id?: number;
  fecha?: string;
  accion_texto?: string;
}

export interface CambioCondicion {
  accion: "añadir" | "anadir" | "cerrar";
  id?: number;
  texto?: string;
  desde?: string | null;
  hasta?: string | null;
}

export interface CambioCarrera {
  accion: "añadir" | "anadir" | "actualizar" | "cancelar" | "completar";
  id?: number;
  nombre?: string;
  fecha?: string | null;
  distancia_km?: number | null;
  desnivel_m?: number | null;
  prioridad?: string | null;
  estado?: string;
  resultado?: string | null;
  notas?: string | null;
}

export interface CommitInput {
  mensaje: string;
  /**
   * Frase textual del atleta que autoriza tocar una regla protegida. Va al log
   * tal cual, delante del mensaje. Sin ella, cualquier cambio sobre una regla
   * protegida se rechaza y no se escribe nada.
   */
  cita_textual?: string;
  fecha?: string; // día del acuerdo; por defecto hoy
  reglas?: CambioRegla[];
  estado?: Record<string, string | number | null>;
  pendientes?: CambioPendiente[];
  disparadores?: CambioDisparador[];
  condiciones?: CambioCondicion[];
  carreras?: CambioCarrera[];
}

export interface CommitResult {
  version: number;
  resumen: string[];
  /** Cosas que no bloquean el commit pero conviene saber (carrera duplicada…). */
  avisos: string[];
}

export class ContractError extends Error {}

function nowIso(): string {
  return new Date().toISOString();
}

/** 3416 → "3.416", como se escribe en español. */
export function formatoMiles(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Caracteres de verdad (puntos de código), no unidades UTF-16. */
export function longitud(texto: string): number {
  let n = 0;
  for (const _ of texto) n += 1;
  return n;
}

/**
 * Rechaza un texto que supera su límite. El error nombra el campo, cuántos
 * caracteres tiene y cuál es el tope, y dice dónde va lo largo: en `mensaje`.
 * Se lanza ANTES de escribir nada, así que el commit se rechaza entero.
 */
/**
 * Una clave de estado es un NOMBRE, no un numero ni una letra suelta.
 *
 * El v168 recibio 'estado' como cadena en vez de como objeto. Object.entries de
 * una cadena la recorre caracter a caracter: se escribieron 309 claves basura
 * («0», «1», «2»…) y la clave real no se escribio. El commit fue atomico y
 * valido, asi que nada fallo; solo quedo un contrato lleno de basura.
 */
export function claveDeEstadoValida(clave: string): boolean {
  return clave.length >= 2 && /\p{L}/u.test(clave) && !/^\d+$/.test(clave);
}

export function comprobarLimite(campo: string, valor: string, limite: number): void {
  const n = longitud(valor);
  if (n <= limite) return;
  throw new ContractError(
    `'${campo}' tiene ${formatoMiles(n)} caracteres y el límite es ${formatoMiles(limite)}. ` +
      "Commit rechazado entero: no se ha escrito nada y la versión no cambia. " +
      "En el contrato solo cabe el mandato operativo (qué hacer); la narrativa larga " +
      "—contexto, razonamiento, precedentes, lo que pasó— va en 'mensaje', que no " +
      "tiene límite y se guarda íntegro en el log (get_log lo recupera cuando haga falta).",
  );
}

/**
 * El commit pide guardar algo que el esquema todavía no puede guardar. Se
 * lanza ANTES de escribir nada, así que el commit se rechaza entero y el
 * mensaje dice qué falta y cómo arreglarlo, en vez de un D1_ERROR crudo.
 */
function exigirColumna(hay: Set<string>, columna: string, campo: string): void {
  if (hay.has(columna)) return;
  throw new ContractError(
    `No se puede escribir '${campo}': la base de datos todavía no tiene la columna ` +
      `${columna}, que añade la migración ${columna === "reglas.protegida" ? "0009" : "0006"}. Aplícala con 'npm run db:migrate' y repite ` +
      "el commit. No se ha escrito nada y la versión no cambia; el resto del contrato " +
      "(reglas, estado, disparadores, condiciones, carreras) funciona con normalidad.",
  );
}

function validDate(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!DATE_RE.test(text)) {
    throw new ContractError(`'${field}' debe tener formato YYYY-MM-DD (recibido ${JSON.stringify(value)}).`);
  }
  return text;
}

/**
 * ¿El batch se cayó porque otro commit se llevó esta versión? Lo garantiza el
 * índice único parcial de `log(version)` (migración 0003).
 */
function esVersionDuplicada(exc: unknown): boolean {
  const texto = exc instanceof Error ? `${exc.message}` : String(exc);
  return /UNIQUE constraint failed: log\.version/i.test(texto);
}

/** Marca de las reglas que no caducan por fecha sino cuando pasa algo. */
export const PREFIJO_CONDICION = "cond:";

/** Lo que cabe en la condición: es una etiqueta, no el contenido de la regla. */
export const LIMITE_CONDICION = 120;

/** ¿Este 'vence' es una condición en vez de una fecha? */
export function venceEsCondicion(vence: string | null | undefined): boolean {
  return typeof vence === "string" && vence.startsWith(PREFIJO_CONDICION);
}

/** Cómo se lee un 'vence' en una respuesta: fecha, «nunca», o la condición. */
export function venceLegible(vence: string | null | undefined): string {
  if (!vence) return "nunca";
  return venceEsCondicion(vence)
    ? `por condición: ${vence.slice(PREFIJO_CONDICION.length)}`
    : vence;
}

function normalizeVence(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const crudo = String(value).trim();
  const text = crudo.toLowerCase();
  if (!text || text === "nunca" || text === "never") return null;

  // Vencimiento por condición: R008, R011 y R019 no caducan en una fecha, pero
  // salían como «vence nunca», que es justo lo contrario de lo que pasa.
  const marca = /^(cond|condicion|condición)\s*:/i.exec(crudo);
  if (marca) {
    const condicion = crudo.slice(marca[0].length).trim();
    if (!condicion) {
      throw new ContractError(
        "Un vencimiento por condición necesita LA CONDICIÓN: 'vence' como " +
          '«cond: hasta que el test fije el LTHR». Una condición sin decir cuál ' +
          "es lo mismo que «nunca», que es el problema que esto viene a arreglar.",
      );
    }
    comprobarLimite("vence (la condición)", condicion, LIMITE_CONDICION);
    return `${PREFIJO_CONDICION}${condicion}`;
  }
  if (/^(cond|condicion|condición)$/i.test(crudo)) {
    throw new ContractError(
      "Falta la condición: escribe 'vence' como «cond: hasta que el test fije el LTHR».",
    );
  }
  return validDate(value, "vence");
}

/** Texto opcional: undefined = no tocar, null/"" = vaciar, si no, recortado y con tope. */
function textoOpcional(
  value: unknown,
  campo: keyof typeof LIMITES,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const texto = String(value).trim();
  if (!texto) return null;
  comprobarLimite(campo, texto, LIMITES[campo]);
  return texto;
}

/** Tipo de un filtro `desde`/`hasta` del log: fecha, versión, o nada. */
export function tipoFiltroLog(value: unknown): { fecha: string } | { version: number } | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return { version: Math.trunc(value) };
  const texto = String(value).trim();
  if (DATE_RE.test(texto)) return { fecha: texto };
  const m = /^v?(\d+)$/i.exec(texto);
  if (m) return { version: parseInt(m[1]!, 10) };
  throw new ContractError(
    `'desde'/'hasta' aceptan una fecha YYYY-MM-DD o una versión (133 o "v133"); recibido ${JSON.stringify(value)}.`,
  );
}

/**
 * Doble llave. Devuelve la cita si la hay y es usable; si no, lanza un error
 * que dice exactamente qué falta. La cita es del atleta, no del entrenador: no
 * se acepta una paráfrasis corta tipo «ok» o «sí», que es lo que cuesta menos
 * inventarse.
 */
function exigirCita(cita: string | undefined, que: string): string {
  const texto = String(cita ?? "").trim();
  if (texto.length < 12) {
    throw new ContractError(
      `${que} es una regla PROTEGIDA (doble llave): solo cambia con la frase textual del ` +
        "atleta en 'cita_textual', copiada tal cual la dijo en esta conversación (12 " +
        "caracteres o más). No se ha escrito nada. Si el atleta no lo ha dicho, no se toca: " +
        "pregúntale.",
    );
  }
  return texto;
}

/** Una restricción médica no caduca sola por calendario: nunca o por condición. */
function comprobarVenceProtegida(vence: string | null, id: string): void {
  if (vence && !vence.startsWith(PREFIJO_CONDICION)) {
    throw new ContractError(
      `La regla protegida ${id} no puede vencer por fecha (${vence}): se retiraría sola sin ` +
        "que el atleta lo diga. Usa vence 'nunca' o una condición («cond: alta médica»).",
    );
  }
}

export class ContractStore {
  constructor(
    private db: D1Database,
    private today: () => string,
  ) {}

  /**
   * Qué columnas tienen de verdad `reglas` y `pendientes`, preguntándoselo a
   * la base. Se cachea en la instancia (que vive una petición), así que son
   * como mucho dos lecturas de catálogo por request: barato al lado de
   * quedarse sin la lectura obligatoria del contrato.
   */
  private columnasPromesa: Promise<Set<string>> | null = null;

  private columnas(): Promise<Set<string>> {
    if (!this.columnasPromesa) {
      this.columnasPromesa = this.db
        .prepare(
          "SELECT 'reglas.' || name AS col FROM pragma_table_info('reglas') " +
            "UNION ALL SELECT 'pendientes.' || name AS col FROM pragma_table_info('pendientes')",
        )
        .all<{ col: string }>()
        .then((r) => new Set(r.results.map((fila) => fila.col)));
    }
    return this.columnasPromesa;
  }

  /** Columnas de la 0006 que faltan; vacío si el esquema está al día. */
  async columnasAusentes(): Promise<string[]> {
    const hay = await this.columnas();
    return COLUMNAS_0006.filter((columna) => !hay.has(columna));
  }

  // ------------------------------------------------------------- lecturas

  async version(): Promise<number> {
    const row = await this.db
      .prepare("SELECT valor FROM meta WHERE clave = 'version'")
      .first<{ valor: string }>();
    return parseInt(row?.valor ?? "0", 10) || 0;
  }

  /**
   * Lee el contrato completo. Si hay reglas o pendientes vencidos, los da de
   * baja en el mismo momento (batch atómico) y lo deja registrado en el log,
   * como exige §2.3 del contrato.
   */
  async snapshot(): Promise<ContractSnapshot> {
    const hoy = this.today();
    const ausentes = await this.columnasAusentes();
    await this.expirarVencidas(hoy, ausentes);

    const resultados = await this.db.batch([
        this.db.prepare("SELECT clave, valor FROM meta"),
        this.db.prepare("SELECT * FROM reglas ORDER BY id"),
        this.db.prepare("SELECT * FROM estado ORDER BY clave"),
        this.db.prepare("SELECT * FROM pendientes WHERE estado = 'abierto' ORDER BY id"),
        this.db.prepare("SELECT * FROM disparadores WHERE estado = 'pendiente' ORDER BY fecha"),
        this.db.prepare("SELECT * FROM condiciones WHERE estado = 'activa' ORDER BY id"),
        this.db.prepare(
          "SELECT * FROM carreras WHERE estado IN ('candidata','confirmada') ORDER BY fecha",
        ),
        this.db.prepare(
          "SELECT * FROM reglas WHERE estado = 'expirada' AND finalizada_en = ?1 ORDER BY id",
        ).bind(hoy),
        this.db.prepare(
          "SELECT * FROM pendientes WHERE estado = 'vencido' AND resuelto_en = ?1 ORDER BY id",
        ).bind(hoy),
      ]);
    const [meta, reglas, estado, pendientes, disparadores, condiciones, carreras, bajasHoy, pendVencidos] =
      resultados as [
        D1Result, D1Result, D1Result, D1Result, D1Result, D1Result, D1Result, D1Result, D1Result,
      ];

    const metaMap = new Map(
      (meta.results as Array<{ clave: string; valor: string }>).map((r) => [r.clave, r.valor]),
    );

    const todasReglas = reglas.results as unknown as Regla[];
    const disparadoresAll = disparadores.results as unknown as Disparador[];
    return {
      version: parseInt(metaMap.get("version") ?? "0", 10) || 0,
      ultimoCommit: metaMap.get("ultimo_commit") ?? "",
      hoy,
      columnasAusentes: ausentes,
      reglas: todasReglas.filter((r) => r.estado === "activa"),
      bajasAutomaticas: bajasHoy.results as unknown as Regla[],
      pendientesVencidosHoy: pendVencidos.results as unknown as Pendiente[],
      estado: estado.results as unknown as EstadoEntry[],
      pendientes: pendientes.results as unknown as Pendiente[],
      disparadores: disparadoresAll.filter((d) => d.fecha > hoy),
      disparadoresVencidos: disparadoresAll.filter((d) => d.fecha <= hoy),
      condiciones: condiciones.results as unknown as Condicion[],
      carreras: carreras.results as unknown as Carrera[],
    };
  }

  /**
   * Reglas activas y pendientes abiertos cuyo `vence` ya pasó → expirados +
   * log, atómico.
   *
   * Esto se dispara en una LECTURA, así que dos lecturas simultáneas (Claude y
   * el panel a la vez, por ejemplo) pueden encontrar las mismas entradas
   * vencidas. Cada sentencia está escrita para que la segunda no duplique nada:
   *
   *  - el INSERT del log solo escribe si algo sigue vivo, y va ANTES de los
   *    UPDATE que lo expiran (dentro de un batch el orden manda);
   *  - los UPDATE llevan `AND estado = 'activa'` / `'abierto'`, así que la
   *    segunda vez no tocan ninguna fila;
   *  - el bump de versión es monótono: nunca la baja ni la sube dos veces.
   */
  private async expirarVencidas(hoy: string, ausentes: string[]): Promise<void> {
    // Sin la columna no hay pendientes con vencimiento que buscar, y
    // preguntarlo rompería la lectura entera: es lo que pasó el 04/09/2026.
    const pendientesCaducan = !ausentes.includes("pendientes.vence");
    const consultas = [
      this.db
        .prepare(
          "SELECT * FROM reglas WHERE estado = 'activa' AND vence IS NOT NULL " +
            "AND vence NOT LIKE 'cond:%' AND vence < ?1",
        )
        .bind(hoy),
    ];
    // La caducidad por inactividad necesita saber cuándo se tocó cada uno.
    const porInactividad = pendientesCaducan && !ausentes.includes("pendientes.actualizado_en");
    if (pendientesCaducan) {
      const limite = addDays(hoy, -DIAS_CADUCIDAD_PENDIENTE);
      consultas.push(
        this.db
          .prepare(
            porInactividad
              ? `SELECT * FROM pendientes
                  WHERE estado = 'abierto'
                    AND ((vence IS NOT NULL AND vence NOT LIKE 'cond:%' AND vence < ?1)
                      OR ((vence IS NULL OR vence LIKE 'cond:%')
                          AND COALESCE(actualizado_en, creado_en) < ?2))`
              : "SELECT * FROM pendientes WHERE estado = 'abierto' AND vence IS NOT NULL " +
                "AND vence NOT LIKE 'cond:%' AND vence < ?1",
          )
          .bind(...(porInactividad ? [hoy, limite] : [hoy])),
      );
    }
    const resultados = (await this.db.batch(consultas)) as D1Result[];
    const reglas = resultados[0]!.results as unknown as Regla[];
    const pendientes = (resultados[1]?.results ?? []) as unknown as Pendiente[];
    if (!reglas.length && !pendientes.length) return;

    const version = (await this.version()) + 1;
    const ts = nowIso();
    const nombres = [
      ...reglas.map((r) => `${r.id} (vencía ${r.vence})`),
      ...pendientes.map((p) =>
        p.vence
          ? `pendiente #${p.id} (vencía ${p.vence})`
          : `pendiente #${p.id} (${DIAS_CADUCIDAD_PENDIENTE} días sin tocarse desde ` +
            `${p.actualizado_en ?? p.creado_en})`,
      ),
    ].join(", ");

    // Guardas del INSERT: ¿sigue viva alguna de las entradas que vamos a expirar?
    const guardas: string[] = [];
    const binds: unknown[] = [];
    let n = 5;
    if (reglas.length) {
      const marcadores = reglas.map(() => `?${++n}`).join(", ");
      guardas.push(`SELECT 1 FROM reglas WHERE estado = 'activa' AND id IN (${marcadores})`);
      binds.push(...reglas.map((r) => r.id));
    }
    if (pendientes.length) {
      const marcadores = pendientes.map(() => `?${++n}`).join(", ");
      guardas.push(`SELECT 1 FROM pendientes WHERE estado = 'abierto' AND id IN (${marcadores})`);
      binds.push(...pendientes.map((p) => p.id));
    }

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          "INSERT INTO log (fecha, version, mensaje, detalles, creado_en) " +
            "SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (" +
            guardas.join(" UNION ALL ") +
            ")",
        )
        .bind(
          hoy,
          version,
          `Baja automática por vencimiento: ${nombres}`,
          JSON.stringify({
            tipo: "expiracion_automatica",
            reglas: reglas.map((r) => r.id),
            pendientes: pendientes.map((p) => p.id),
          }),
          ts,
          ...binds,
        ),
      ...reglas.map((r) =>
        this.db
          .prepare(
            "UPDATE reglas SET estado = 'expirada', finalizada_en = ?1, finalizada_version = ?2, " +
              "motivo_baja = 'vencimiento automático' WHERE id = ?3 AND estado = 'activa'",
          )
          .bind(hoy, version, r.id),
      ),
      ...pendientes.map((p) =>
        this.db
          .prepare(
            "UPDATE pendientes SET estado = 'vencido', resuelto_en = ?1 WHERE id = ?2 AND estado = 'abierto'",
          )
          .bind(hoy, p.id),
      ),
      this.db
        .prepare(
          "UPDATE meta SET valor = ?1 WHERE clave = 'version' AND CAST(valor AS INTEGER) < ?2",
        )
        .bind(String(version), version),
      this.db.prepare("UPDATE meta SET valor = ?1 WHERE clave = 'ultimo_commit'").bind(hoy),
    ];
    try {
      await this.db.batch(statements);
    } catch (exc) {
      // Otra lectura simultánea se adelantó y el índice único de versión rechazó
      // esta: la baja YA está registrada, así que no hay nada que arreglar.
      if (!esVersionDuplicada(exc)) throw exc;
    }
  }

  /**
   * Inserta una entrada histórica en el log (importación), sin bump de versión.
   * Sigue siendo append-only: solo INSERT.
   */
  async appendHistoricalLog(fecha: string, mensaje: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO log (fecha, version, mensaje, detalles, creado_en) VALUES (?1, NULL, ?2, ?3, ?4)",
      )
      .bind(
        validDate(fecha, "fecha"),
        mensaje,
        JSON.stringify({ tipo: "importado_de_intervals" }),
        nowIso(),
      )
      .run();
  }

  /**
   * Garantiza que la versión no retroceda respecto al snapshot antiguo de
   * intervals: tras importar un v10, el siguiente commit será v11+.
   */
  async ensureVersionFloor(minimo: number): Promise<void> {
    if (!Number.isFinite(minimo) || minimo <= 0) return;
    const actual = await this.version();
    if (actual < minimo) {
      await this.db
        .prepare("UPDATE meta SET valor = ?1 WHERE clave = 'version'")
        .bind(String(Math.trunc(minimo)))
        .run();
    }
  }

  // Todas las lecturas del log son SELECT: el log no se toca.

  async log(limit = 30, antesDe?: string): Promise<LogEntry[]> {
    const clamped = Math.max(1, Math.min(200, limit));
    if (antesDe) {
      const before = validDate(antesDe, "antes_de");
      const rows = await this.db
        .prepare("SELECT * FROM log WHERE fecha < ?1 ORDER BY id DESC LIMIT ?2")
        .bind(before, clamped)
        .all<LogEntry>();
      return rows.results;
    }
    const rows = await this.db
      .prepare("SELECT * FROM log ORDER BY id DESC LIMIT ?1")
      .bind(clamped)
      .all<LogEntry>();
    return rows.results;
  }

  /** Las `limit` entradas anteriores a la de id `id`: paginación sin huecos. */
  async logAntesDeId(limit: number, id: number): Promise<LogEntry[]> {
    const clamped = Math.max(1, Math.min(200, limit));
    const rows = await this.db
      .prepare("SELECT * FROM log WHERE id < ?1 ORDER BY id DESC LIMIT ?2")
      .bind(Math.trunc(id), clamped)
      .all<LogEntry>();
    return rows.results;
  }

  async logTotal(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS n FROM log").first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async logPorVersion(version: number): Promise<LogEntry | null> {
    if (!Number.isFinite(version)) throw new ContractError("'version' debe ser un número.");
    return this.db
      .prepare("SELECT * FROM log WHERE version = ?1")
      .bind(Math.trunc(version))
      .first<LogEntry>();
  }

  /**
   * Entradas entre `desde` y `hasta` (ambos inclusive), cada uno una fecha o
   * una versión. Se puede dar solo uno de los dos.
   */
  async logRango(desde: unknown, hasta: unknown, limit = 200): Promise<LogEntry[]> {
    const d = tipoFiltroLog(desde);
    const h = tipoFiltroLog(hasta);
    const clamped = Math.max(1, Math.min(200, limit));
    const where: string[] = [];
    const binds: unknown[] = [];
    if (d) {
      binds.push("fecha" in d ? d.fecha : d.version);
      where.push(`${"fecha" in d ? "fecha" : "version"} >= ?${binds.length}`);
    }
    if (h) {
      binds.push("fecha" in h ? h.fecha : h.version);
      where.push(`${"fecha" in h ? "fecha" : "version"} <= ?${binds.length}`);
    }
    binds.push(clamped);
    const rows = await this.db
      .prepare(
        `SELECT * FROM log${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ` +
          `ORDER BY id DESC LIMIT ?${binds.length}`,
      )
      .bind(...binds)
      .all<LogEntry>();
    return rows.results;
  }

  /** Entradas cuyo mensaje o detalles contienen el texto (sin distinguir mayúsculas ASCII). */
  async logBuscar(texto: string, limit = 40): Promise<LogEntry[]> {
    const patron = `%${texto.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const clamped = Math.max(1, Math.min(200, limit));
    const rows = await this.db
      .prepare(
        "SELECT * FROM log WHERE mensaje LIKE ?1 ESCAPE '\\' OR detalles LIKE ?1 ESCAPE '\\' " +
          "ORDER BY id DESC LIMIT ?2",
      )
      .bind(patron, clamped)
      .all<LogEntry>();
    return rows.results;
  }

  // -------------------------------------------------------------- commits

  /**
   * Commit atómico: valida todo primero (formatos Y límites de longitud),
   * luego un único batch con el log, los cambios y el bump de versión. Si
   * algo no valida, no se escribe nada y la versión no se mueve.
   */
  async commit(input: CommitInput): Promise<CommitResult> {
    const mensaje = String(input.mensaje ?? "").trim();
    if (!mensaje) {
      throw new ContractError(
        "Falta 'mensaje': todo commit registra en el log qué se acordó y por qué.",
      );
    }
    const hoy = this.today();
    const fecha = input.fecha ? validDate(input.fecha, "fecha") : hoy;
    const ts = nowIso();
    const statements: D1PreparedStatement[] = [];
    const resumen: string[] = [];
    const avisos: string[] = [];

    // Qué puede guardar de verdad la base ahora mismo: si el despliegue va por
    // delante de su migración, se escribe lo que quepa y se rechaza con un
    // mensaje claro solo lo que pida una columna que aún no existe.
    const hay = await this.columnas();

    // --- Reglas ---
    const reglasActuales = await this.db.prepare("SELECT * FROM reglas").all<Regla>();
    const porId = new Map(reglasActuales.results.map((r) => [r.id, r]));
    const version = (await this.version()) + 1;
    /** La cita que autorizó tocar una regla protegida, si hizo falta. */
    let citaUsada: string | null = null;

    for (const cambio of input.reglas ?? []) {
      const accion = cambio.accion;
      if (accion === "crear") {
        let id = (cambio.id ?? "").trim().toUpperCase();
        if (!id) {
          // Autonumera: R + siguiente número libre.
          const nums = [...porId.keys()]
            .map((k) => parseInt(k.replace(/^R/i, ""), 10))
            .filter((n) => Number.isFinite(n));
          id = `R${String(Math.max(0, ...nums) + 1).padStart(3, "0")}`;
        }
        if (porId.has(id)) {
          throw new ContractError(
            `La regla ${id} ya existe. Usa accion 'modificar' o deja 'id' vacío para autonumerar.`,
          );
        }
        const tema = String(cambio.tema ?? "").trim();
        const contenido = String(cambio.contenido ?? "").trim();
        if (!tema || !contenido) {
          throw new ContractError(`La regla nueva ${id} necesita 'tema' y 'contenido'.`);
        }
        comprobarLimite(`reglas[${id}].contenido`, contenido, LIMITES["reglas.contenido"]);
        const resumenRegla = textoOpcional(cambio.resumen, "reglas.resumen") ?? null;
        if (resumenRegla !== null) exigirColumna(hay, "reglas.resumen", `reglas[${id}].resumen`);
        const vence = normalizeVence(cambio.vence);
        const protegida = cambio.protegida === true;
        if (protegida) {
          exigirColumna(hay, "reglas.protegida", `reglas[${id}].protegida`);
          citaUsada = exigirCita(input.cita_textual, `La regla nueva ${id}`);
          comprobarVenceProtegida(vence, id);
        }
        const [sqlAlta, bindsAlta] = sqlInsert("reglas", [
          ["id", id], ["tema", tema], ["contenido", contenido], ["resumen", resumenRegla],
          ["vence", vence], ["estado", "activa"], ["creada_en", fecha], ["creada_version", version],
          ["protegida", protegida ? 1 : 0],
        ], hay);
        statements.push(this.db.prepare(sqlAlta).bind(...bindsAlta));
        porId.set(id, {
          id, tema, contenido, resumen: resumenRegla, vence, estado: "activa", creada_en: fecha,
          creada_version: version, finalizada_en: null, finalizada_version: null, motivo_baja: null,
          protegida: protegida ? 1 : 0,
        });
        resumen.push(`+${id}${protegida ? " 🔒" : ""} ${tema} (vence ${vence ?? "nunca"})`);
      } else if (accion === "modificar") {
        const id = String(cambio.id ?? "").trim().toUpperCase();
        const actual = porId.get(id);
        if (!actual) throw new ContractError(`No existe la regla ${id || "(sin id)"} para modificar.`);
        if (actual.estado !== "activa") {
          throw new ContractError(
            `La regla ${id} está '${actual.estado}'. Crea una nueva en su lugar.`,
          );
        }
        const tema = cambio.tema !== undefined ? String(cambio.tema).trim() : actual.tema;
        const contenido =
          cambio.contenido !== undefined ? String(cambio.contenido).trim() : actual.contenido;
        if (cambio.contenido !== undefined) {
          comprobarLimite(`reglas[${id}].contenido`, contenido, LIMITES["reglas.contenido"]);
        }
        const resumenRegla = textoOpcional(cambio.resumen, "reglas.resumen");
        if (resumenRegla !== undefined) exigirColumna(hay, "reglas.resumen", `reglas[${id}].resumen`);
        const vence = cambio.vence !== undefined ? normalizeVence(cambio.vence) : actual.vence;
        const eraProtegida = Number(actual.protegida ?? 0) === 1;
        const protegida = cambio.protegida !== undefined ? cambio.protegida === true : eraProtegida;
        if (eraProtegida || protegida) {
          if (cambio.protegida !== undefined) {
            exigirColumna(hay, "reglas.protegida", `reglas[${id}].protegida`);
          }
          citaUsada = exigirCita(input.cita_textual, `La regla ${id}`);
          if (protegida) comprobarVenceProtegida(vence, id);
        }
        const [sqlMod, bindsMod] = sqlUpdate("reglas", [
          ["tema", tema],
          ["contenido", contenido],
          ["resumen", resumenRegla === undefined ? (actual.resumen ?? null) : resumenRegla],
          ["vence", vence],
          ["protegida", protegida ? 1 : 0],
        ], (n) => [`id = ?${n}`, [id]], hay);
        statements.push(this.db.prepare(sqlMod).bind(...bindsMod));
        resumen.push(`~${id} ${tema}`);
      } else if (accion === "retirar") {
        const id = String(cambio.id ?? "").trim().toUpperCase();
        const actual = porId.get(id);
        if (!actual) throw new ContractError(`No existe la regla ${id || "(sin id)"} para retirar.`);
        if (actual.estado !== "activa") {
          throw new ContractError(`La regla ${id} ya está '${actual.estado}'.`);
        }
        if (Number(actual.protegida ?? 0) === 1) {
          citaUsada = exigirCita(input.cita_textual, `La regla ${id}`);
        }
        statements.push(
          this.db
            .prepare(
              "UPDATE reglas SET estado = 'retirada', finalizada_en = ?1, finalizada_version = ?2, " +
                "motivo_baja = ?3 WHERE id = ?4",
            )
            .bind(fecha, version, String(cambio.motivo ?? "").trim() || mensaje, id),
        );
        resumen.push(`-${id} ${actual.tema}`);
      } else {
        throw new ContractError(
          `Acción de regla desconocida: ${JSON.stringify(accion)}. Usa crear | modificar | retirar.`,
        );
      }
    }

    // --- Estado ---
    const estadoEntrada = input.estado ?? {};
    if (typeof estadoEntrada !== "object" || estadoEntrada === null || Array.isArray(estadoEntrada)) {
      throw new ContractError(
        `'estado' tiene que ser un objeto {clave: valor} y ha llegado ` +
          `${Array.isArray(estadoEntrada) ? "una lista" : `un ${typeof estadoEntrada}`}. ` +
          "Una cadena se recorre carácter a carácter y escribe una clave por letra: así se " +
          "colaron 309 claves basura en el v168, sin que nada fallara.",
      );
    }
    for (const [clave, valor] of Object.entries(estadoEntrada)) {
      const key = clave.trim();
      if (!key) continue;
      if (!claveDeEstadoValida(key)) {
        throw new ContractError(
          `Clave de estado no válida: ${JSON.stringify(key)}. Una clave es un nombre ` +
            "(«bloque», «umbral»), de dos caracteres o más y con alguna letra. Un número " +
            "o un carácter suelto es la firma de haber pasado 'estado' como cadena en vez de " +
            "como objeto, que es lo que llenó el contrato de basura en el v168.",
        );
      }
      if (valor === null) {
        statements.push(this.db.prepare("DELETE FROM estado WHERE clave = ?1").bind(key));
        resumen.push(`estado −${key}`);
      } else {
        const texto = String(valor);
        comprobarLimite(`estado.${key}`, texto, LIMITES["estado.valor"]);
        statements.push(
          this.db
            .prepare(
              "INSERT INTO estado (clave, valor, actualizado_en) VALUES (?1, ?2, ?3) " +
                "ON CONFLICT(clave) DO UPDATE SET valor = ?2, actualizado_en = ?3",
            )
            .bind(key, texto, fecha),
        );
        resumen.push(`estado ${key}=${texto}`);
      }
    }

    // --- Pendientes ---
    for (const cambio of input.pendientes ?? []) {
      if (cambio.accion === "añadir" || cambio.accion === "anadir") {
        const texto = String(cambio.texto ?? "").trim();
        if (!texto) throw new ContractError("Un pendiente nuevo necesita 'texto'.");
        comprobarLimite("pendientes[].texto", texto, LIMITES["pendientes.texto"]);
        const resumenPend = textoOpcional(cambio.resumen, "pendientes.resumen") ?? null;
        if (resumenPend !== null) exigirColumna(hay, "pendientes.resumen", "pendientes[].resumen");
        const vence = normalizeVence(cambio.vence);
        if (vence !== null) exigirColumna(hay, "pendientes.vence", "pendientes[].vence");
        const [sqlAlta, bindsAlta] = sqlInsert("pendientes", [
          ["texto", texto], ["resumen", resumenPend], ["vence", vence],
          ["estado", "abierto"], ["creado_en", fecha], ["actualizado_en", fecha],
        ], hay);
        statements.push(this.db.prepare(sqlAlta).bind(...bindsAlta));
        resumen.push(`+pendiente: ${texto.slice(0, 40)}${vence ? ` (vence ${vence})` : ""}`);
      } else if (cambio.accion === "actualizar") {
        // Conserva el id: los pendientes se citan por id desde reglas y
        // disparadores, y resolver+recrear dejaría esas citas huérfanas.
        const id = Number(cambio.id);
        if (!Number.isFinite(id)) throw new ContractError("'actualizar' necesita el 'id' del pendiente.");
        const actual = await this.db
          .prepare("SELECT * FROM pendientes WHERE id = ?1")
          .bind(id)
          .first<Pendiente>();
        if (!actual) throw new ContractError(`No existe el pendiente #${id}.`);
        if (actual.estado !== "abierto") {
          throw new ContractError(`El pendiente #${id} está '${actual.estado}': solo se actualizan los abiertos.`);
        }
        const texto = cambio.texto !== undefined ? String(cambio.texto).trim() : actual.texto;
        if (!texto) throw new ContractError(`El pendiente #${id} no puede quedarse sin 'texto'.`);
        if (cambio.texto !== undefined) {
          comprobarLimite(`pendientes[#${id}].texto`, texto, LIMITES["pendientes.texto"]);
        }
        const resumenPend = textoOpcional(cambio.resumen, "pendientes.resumen");
        if (resumenPend !== undefined) exigirColumna(hay, "pendientes.resumen", `pendientes[#${id}].resumen`);
        const vence = cambio.vence !== undefined ? normalizeVence(cambio.vence) : (actual.vence ?? null);
        if (cambio.vence !== undefined) exigirColumna(hay, "pendientes.vence", `pendientes[#${id}].vence`);
        const [sqlMod, bindsMod] = sqlUpdate("pendientes", [
          ["texto", texto],
          ["resumen", resumenPend === undefined ? (actual.resumen ?? null) : resumenPend],
          ["vence", vence],
          ["actualizado_en", fecha],
        ], (n) => [`id = ?${n} AND estado = 'abierto'`, [id]], hay);
        statements.push(this.db.prepare(sqlMod).bind(...bindsMod));
        resumen.push(`~pendiente #${id}: ${(resumenPend ?? texto).slice(0, 40)}`);
      } else if (cambio.accion === "resolver") {
        const id = Number(cambio.id);
        if (!Number.isFinite(id)) throw new ContractError("'resolver' necesita el 'id' del pendiente.");
        statements.push(
          this.db
            .prepare(
              "UPDATE pendientes SET estado = 'resuelto', resuelto_en = ?1 WHERE id = ?2 AND estado = 'abierto'",
            )
            .bind(fecha, id),
        );
        resumen.push(`✓pendiente #${id}`);
      } else {
        throw new ContractError(
          `Acción de pendiente desconocida: ${JSON.stringify(cambio.accion)}. Usa añadir | actualizar | resolver.`,
        );
      }
    }

    // --- Disparadores ---
    for (const cambio of input.disparadores ?? []) {
      if (cambio.accion === "añadir" || cambio.accion === "anadir") {
        const dueDate = validDate(cambio.fecha, "disparadores[].fecha");
        const accionTexto = String(cambio.accion_texto ?? "").trim();
        if (!accionTexto) throw new ContractError("Un disparador necesita 'accion_texto'.");
        comprobarLimite(
          `disparadores[${dueDate}].accion_texto`,
          accionTexto,
          LIMITES["disparadores.accion_texto"],
        );
        statements.push(
          this.db
            .prepare(
              "INSERT INTO disparadores (fecha, accion, estado, creado_en) VALUES (?1, ?2, 'pendiente', ?3)",
            )
            .bind(dueDate, accionTexto, fecha),
        );
        resumen.push(`+disparador ${dueDate}: ${accionTexto.slice(0, 40)}`);
      } else if (cambio.accion === "completar" || cambio.accion === "cancelar") {
        const id = Number(cambio.id);
        if (!Number.isFinite(id)) {
          throw new ContractError(`'${cambio.accion}' necesita el 'id' del disparador.`);
        }
        const estado = cambio.accion === "completar" ? "completado" : "cancelado";
        statements.push(
          this.db
            .prepare(
              "UPDATE disparadores SET estado = ?1, finalizado_en = ?2 WHERE id = ?3 AND estado = 'pendiente'",
            )
            .bind(estado, fecha, id),
        );
        resumen.push(`✓disparador #${id} ${estado}`);
      } else {
        throw new ContractError(`Acción de disparador desconocida: ${JSON.stringify(cambio.accion)}.`);
      }
    }

    // --- Condiciones especiales ---
    for (const cambio of input.condiciones ?? []) {
      if (cambio.accion === "añadir" || cambio.accion === "anadir") {
        const texto = String(cambio.texto ?? "").trim();
        if (!texto) throw new ContractError("Una condición nueva necesita 'texto'.");
        const desde = cambio.desde ? validDate(cambio.desde, "condiciones[].desde") : null;
        const hasta = cambio.hasta ? validDate(cambio.hasta, "condiciones[].hasta") : null;
        statements.push(
          this.db
            .prepare(
              "INSERT INTO condiciones (texto, desde, hasta, estado, creado_en) VALUES (?1, ?2, ?3, 'activa', ?4)",
            )
            .bind(texto, desde, hasta, fecha),
        );
        resumen.push(`+condición: ${texto.slice(0, 40)}`);
      } else if (cambio.accion === "cerrar") {
        const id = Number(cambio.id);
        if (!Number.isFinite(id)) throw new ContractError("'cerrar' necesita el 'id' de la condición.");
        statements.push(
          this.db
            .prepare(
              "UPDATE condiciones SET estado = 'cerrada', cerrado_en = ?1 WHERE id = ?2 AND estado = 'activa'",
            )
            .bind(fecha, id),
        );
        resumen.push(`✓condición #${id} cerrada`);
      } else {
        throw new ContractError(`Acción de condición desconocida: ${JSON.stringify(cambio.accion)}.`);
      }
    }

    // --- Carreras ---
    // Una carrera, una ficha. Tres fichas de la misma media maratón dijeron
    // cosas contradictorias; si la fecha coincide con otra activa, se avisa.
    const carrerasActivas = (
      await this.db
        .prepare("SELECT * FROM carreras WHERE estado IN ('candidata','confirmada')")
        .all<Carrera>()
    ).results;
    const avisarDuplicado = (fechaCarrera: string | null, nombre: string, propioId: number | null) => {
      if (!fechaCarrera) return;
      const mismas = carrerasActivas.filter((c) => c.fecha === fechaCarrera && c.id !== propioId);
      if (!mismas.length) return;
      avisos.push(
        `⚠ «${nombre}» comparte fecha (${fechaCarrera}) con ${mismas
          .map((c) => (c.id < 0 ? `«${c.nombre}» (alta en este mismo commit)` : `#${c.id} «${c.nombre}» (${c.estado})`))
          .join(", ")}. Si es la misma carrera, usa 'actualizar' sobre esa ficha en vez de tener ` +
          "dos: fichas duplicadas acaban diciendo cosas distintas.",
      );
    };
    for (const cambio of input.carreras ?? []) {
      if (cambio.accion === "añadir" || cambio.accion === "anadir") {
        const nombre = String(cambio.nombre ?? "").trim();
        if (!nombre) throw new ContractError("Una carrera nueva necesita 'nombre'.");
        const raceDate = cambio.fecha ? validDate(cambio.fecha, "carreras[].fecha") : null;
        const notas = textoOpcional(cambio.notas, "carreras.notas") ?? null;
        const estado = cambio.estado ?? "candidata";
        avisarDuplicado(raceDate, nombre, null);
        statements.push(
          this.db
            .prepare(
              "INSERT INTO carreras (nombre, fecha, distancia_km, desnivel_m, prioridad, estado, notas, creado_en, actualizado_en) " +
                "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            )
            .bind(
              nombre,
              raceDate,
              cambio.distancia_km ?? null,
              cambio.desnivel_m ?? null,
              cambio.prioridad ?? null,
              estado,
              notas,
              fecha,
            ),
        );
        // Para que dos altas con la misma fecha en el mismo commit también avisen.
        carrerasActivas.push({
          id: -(carrerasActivas.length + 1), nombre, fecha: raceDate, distancia_km: null,
          desnivel_m: null, prioridad: null, estado, resultado: null, notas, creado_en: fecha,
          actualizado_en: fecha,
        });
        resumen.push(`+carrera: ${nombre}${raceDate ? ` (${raceDate})` : ""}`);
      } else if (["actualizar", "cancelar", "completar"].includes(cambio.accion)) {
        const id = Number(cambio.id);
        if (!Number.isFinite(id)) {
          throw new ContractError(`'${cambio.accion}' necesita el 'id' de la carrera.`);
        }
        const actual = await this.db
          .prepare("SELECT * FROM carreras WHERE id = ?1")
          .bind(id)
          .first<Carrera>();
        if (!actual) throw new ContractError(`No existe la carrera #${id}.`);
        const estado =
          cambio.accion === "cancelar"
            ? "cancelada"
            : cambio.accion === "completar"
              ? "completada"
              : (cambio.estado ?? actual.estado);
        const raceDate =
          cambio.fecha !== undefined
            ? cambio.fecha
              ? validDate(cambio.fecha, "carreras[].fecha")
              : null
            : actual.fecha;
        const nombre = cambio.nombre !== undefined ? String(cambio.nombre).trim() : actual.nombre;
        const notas = textoOpcional(cambio.notas, "carreras.notas");
        if (cambio.accion === "actualizar" && cambio.fecha !== undefined && raceDate !== actual.fecha) {
          avisarDuplicado(raceDate, nombre, id);
        }
        statements.push(
          this.db
            .prepare(
              "UPDATE carreras SET nombre = ?1, fecha = ?2, distancia_km = ?3, desnivel_m = ?4, " +
                "prioridad = ?5, estado = ?6, resultado = ?7, notas = ?8, actualizado_en = ?9 WHERE id = ?10",
            )
            .bind(
              nombre,
              raceDate,
              cambio.distancia_km !== undefined ? cambio.distancia_km : actual.distancia_km,
              cambio.desnivel_m !== undefined ? cambio.desnivel_m : actual.desnivel_m,
              cambio.prioridad !== undefined ? cambio.prioridad : actual.prioridad,
              estado,
              cambio.resultado !== undefined ? cambio.resultado : actual.resultado,
              notas === undefined ? actual.notas : notas,
              fecha,
              id,
            ),
        );
        resumen.push(`~carrera #${id} ${estado}`);
      } else {
        throw new ContractError(`Acción de carrera desconocida: ${JSON.stringify(cambio.accion)}.`);
      }
    }

    // --- Log + versión (siempre, aunque el commit solo lleve mensaje) ---
    const detalles = {
      reglas: input.reglas ?? [],
      estado: input.estado ?? {},
      pendientes: input.pendientes ?? [],
      disparadores: input.disparadores ?? [],
      condiciones: input.condiciones ?? [],
      carreras: input.carreras ?? [],
    };
    statements.push(
      this.db
        .prepare(
          "INSERT INTO log (fecha, version, mensaje, detalles, creado_en) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(
          fecha,
          version,
          citaUsada ? `CITA TEXTUAL DEL ATLETA: «${citaUsada}»\n\n${mensaje}` : mensaje,
          JSON.stringify(citaUsada ? { ...detalles, cita_textual: citaUsada } : detalles),
          ts,
        ),
      this.db.prepare("UPDATE meta SET valor = ?1 WHERE clave = 'version'").bind(String(version)),
      this.db.prepare("UPDATE meta SET valor = ?1 WHERE clave = 'ultimo_commit'").bind(fecha),
    );

    try {
      await this.db.batch(statements);
    } catch (exc) {
      if (esVersionDuplicada(exc)) {
        // Otro commit se llevó esta versión mientras preparábamos la nuestra.
        // El batch se ha deshecho entero: no hay nada escrito a medias.
        throw new ContractError(
          `Otro commit se adelantó y ocupó la versión v${version}. No se ha escrito nada: ` +
            "vuelve a lanzar el mismo contract_commit y se aplicará sobre la versión nueva.",
        );
      }
      throw exc;
    }
    return { version, resumen, avisos };
  }
}
