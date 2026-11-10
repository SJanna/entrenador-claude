/**
 * Datos de mentira (pero verosímiles) para las capturas del panel: 150 días de
 * actividades y bienestar, un contrato con reglas protegidas, diario y
 * material, y un Garmin falso para el calendario.
 *
 * Nada de esto es del atleta: es un banco de pruebas para mirar el diseño con
 * pantallas llenas. Lo empaqueta y lo usa scripts/captura.mjs.
 */

// @ts-expect-error apoyo en .mjs, sin tipos
import { d1EnMemoria } from "../test/apoyo-d1.mjs";
import app from "../src/index";
import type { Env } from "../src/env";
import { addDays, weekdayMonday0 } from "../src/dates";
import { ContractStore } from "../src/contract/store";
import { DiarioStore, parsearDefiniciones, validarValor } from "../src/diario/store";
import { MaterialStore, validarEntrada } from "../src/material/store";
import { GarminAlmacen } from "../src/garmin/almacen";
import { HistoricoStore } from "../src/historico/store";
import { esAPie } from "../src/historico/calculos";
import type { Actividad } from "../src/garmin/actividades";
import type { DiaBienestar } from "../src/garmin/bienestar";

export const HOY = "2026-11-09";
const SECRETO = "firma-de-capturas";
export const PASSWORD = "contrasena-capturas";

/** Aleatorio reproducible: las capturas salen iguales cada vez. */
let semilla = 7;
function azar(): number {
  semilla = (semilla * 16807) % 2147483647;
  return semilla / 2147483647;
}

function act(id: number, fecha: string, deporte: string, nombre: string, min: number, km: number, fc: number, carga: number): Actividad {
  return {
    id, fecha, hora: "05:30", deporte, nombre, segundos: min * 60, segundosMov: min * 60 - 30,
    distanciaM: km * 1000, fcMedia: fc, fcMax: fc + 18, desnivelM: Math.round(km * 4), carga,
    efectoAerobico: 3, series: null,
  } as unknown as Actividad;
}

export async function montar(): Promise<{ env: Env; fetchApp: (r: Request) => Promise<Response> }> {
  const db = d1EnMemoria();
  const store = new HistoricoStore(db);
  const desde = addDays(HOY, -150);
  const lista: Actividad[] = [];
  const detalles: Array<{ id: number; desacople: number | null; mejores: Record<string, number> | null }> = [];
  let id = 1000;
  for (let d = desde; d <= HOY; d = addDays(d, 1)) {
    const dow = weekdayMonday0(d);
    const progreso = (150 - (Date.parse(HOY) - Date.parse(d)) / 86400000) / 150; // 0 → 1
    const descarga = d >= "2026-11-02" && d <= "2026-11-08";
    if (dow === 6) {
      const km = Math.round((descarga ? 16 : 12 + progreso * 10) * 10) / 10;
      lista.push(act(++id, d, "running", "Tirada larga", Math.round(km * 7.4), km, 143, Math.round(km * 9)));
      detalles.push({ id, desacople: Math.round((3 + azar() * 4) * 10) / 10, mejores: { 400: 120, 1000: 330, 5000: 1750, 10000: 3600 } });
    } else if (dow === 1 || dow === 4) {
      const km = Math.round((7 + progreso * 3 + azar()) * 10) / 10;
      lista.push(act(++id, d, "running", dow === 1 ? "Rodaje 60'" : "Control a 140", 60, km, 141, 70));
      detalles.push({ id, desacople: null, mejores: { 400: 118 + Math.round(azar() * 10), 1000: 325, 5000: 1700 + Math.round(azar() * 60) } });
      lista.push(act(++id, d, "strength_training", dow === 1 ? "Fuerza piernas (casa)" : "Movilidad de tobillo (casa)", dow === 1 ? 45 : 18, 0, 105, 25));
    } else if (dow === 0 || dow === 2) {
      lista.push(act(++id, d, "lap_swimming", "Natación · clase", 50, 1.6, 120, 35));
      if (dow === 2) lista.push(act(++id, d, "running", "Trote 20'", 20, 3.3, 138, 22));
    } else if (dow === 3 && azar() > 0.3) {
      lista.push(act(++id, d, "walking", "Caminata", 45, 4.1, 98, 8));
    } else if (dow === 5) {
      lista.push(act(++id, d, "strength_training", "Colgado 3 × 10 s (parque)", 12, 0, 92, 6));
    }
  }
  // La marca buena, para que el panel tenga algo que destacar.
  detalles.push({ id: lista.find((a) => a.fecha === "2026-10-11")?.id ?? id, desacople: 2.1, mejores: { 400: 87, 800: 191, 1000: 252, 5000: 1408, 10000: 2950, 21097: 6655 } });
  for (let i = 0; i < lista.length; i += 40) await store.guardarActividades(lista.slice(i, i + 40), esAPie);
  for (const d of detalles) await store.guardarDetalle(d.id, { estado: "ok", desacople: d.desacople, mejores: d.mejores });
  await store.fijarCursor("actividades_completas", "1");
  await store.fijarCursor("ultima_sync", `${HOY}T11:00:00.000Z`);

  for (let d = addDays(HOY, -120); d <= HOY; d = addDays(d, 1)) {
    const dia = {
      fecha: d, fallos: [], pasos: 9000, fcReposo: Math.round(49 + azar() * 4), estresMedio: 30,
      bodyBatteryAlto: Math.round(70 + azar() * 25), bodyBatteryBajo: 20, minutosIntensidad: 60,
      sueñoSegundos: Math.round((6.4 + azar() * 1.4) * 3600), sueñoProfundo: null, sueñoLigero: null, sueñoRem: null,
      sueñoDespierto: null, sueñoPuntuacion: Math.round(68 + azar() * 20), sueñoCalidad: null, spo2Medio: null,
      respiracionMedia: null, readiness: Math.round(55 + azar() * 35), readinessNivel: "MODERATE", readinessFrase: null,
      recuperacionMin: null, hrvNoche: Math.round(36 + azar() * 9), hrvSemana: 40, hrvEstado: "BALANCED",
      estadoEntreno: "PRODUCTIVE", cargaAguda: null, cargaCronica: null, ratioCarga: null, vo2max: 51,
    } as unknown as DiaBienestar;
    if (d === HOY) Object.assign(dia, { readiness: 41, readinessNivel: "MODERATE", fcReposo: 56, hrvNoche: 33, sueñoSegundos: 26100, sueñoPuntuacion: 82, bodyBatteryAlto: 91 });
    await store.guardarDia(dia);
  }

  // Contrato.
  const contrato = new ContractStore(db, () => HOY);
  await contrato.commit({
    mensaje: "Arranque del contrato de las capturas.",
    cita_textual: "Sí, protege la vuelta progresiva del tobillo.",
    reglas: [
      { accion: "crear", tema: "tobillo", protegida: true, vence: "nunca", resumen: "Vuelta progresiva tras el esguince de tobillo: un nivel cada vez, una variable por semana; nada de saltos ni trail técnico.", contenido: "Escalera 0-4 del perfil. Subir exige dos semanas limpias, sin dolor a las 48 h y sin hinchazón. Reglas de parada: dolor >3/10, hinchazón, sensación de inestabilidad." },
      { accion: "crear", tema: "jerarquía", vence: "2027-08-22", resumen: "Objetivo A = ultra BAQ → CTG: correr en asfalto, constancia y durabilidad mandan; fuerza de tren inferior, no negociable.", contenido: "La natación se suma sin quitarle nada al running. La bici es volumen sin impacto." },
      { accion: "crear", tema: "rodaje fácil", vence: "2027-01-31", resumen: "Techo 165 ppm, sin mínimo ni límite de ritmo. Al sol manda el techo: el ritmo cae 45-60 s/km y es cumplir.", contenido: "Medido con el óptico; la banda de pecho decide si hay duda." },
      { accion: "crear", tema: "calidad", vence: "2027-08-22", resumen: "Máx. 1 día duro de calidad por semana; una tirada de 2 h o más también es día duro.", contenido: "Nunca dos exigentes el mismo día." },
      { accion: "crear", tema: "fuerza", vence: "2027-08-22", resumen: "Fuerza 2/sem en casa; nunca la víspera de calidad o de tirada larga.", contenido: "Mancuernas en casa, barras en el parque: nunca mezcladas." },
    ],
    estado: {
      nivel_tobillo: "2 desde 02/11 (rodaje en llano hasta 60 min). Siguiente: cuestas suaves, si las dos semanas salen limpias.",
      bloque: "Semana de descarga del 2 al 8 de noviembre; vuelve la progresión el lunes 9.",
      fc_reposo_base: "52 ppm sobre 120 días; rango normal 48-53.",
    },
    pendientes: [
      { accion: "añadir", texto: "Test de umbral en llano de madrugada antes del 30/11.", vence: "2026-11-30" },
      { accion: "añadir", texto: "Comprar guantes acolchados para las salidas largas en bici." },
    ],
    disparadores: [
      { accion: "añadir", fecha: "2026-11-09", accion_texto: "Evaluar las dos semanas del nivel 2 del tobillo con el dolor a las 48 h." },
      { accion: "añadir", fecha: "2026-11-16", accion_texto: "Revisar el desacople de la tirada larga del domingo." },
    ],
    condiciones: [{ accion: "añadir", texto: "Calor fuerte esta semana: rodajes antes de las 6:00.", desde: "2026-11-09", hasta: "2026-11-15" }],
    carreras: [
      { accion: "añadir", nombre: "Ultra de 120 km", fecha: "2027-11-14", distancia_km: 120, prioridad: "A", estado: "confirmada" },
      { accion: "añadir", nombre: "Trail de la Sierra", fecha: "2026-11-29", distancia_km: 25.5, desnivel_m: 1299, prioridad: "B", estado: "confirmada" },
    ],
  });

  // Diario.
  const diario = new DiarioStore(db);
  const ahora = new Date().toISOString();
  for (const campo of parsearDefiniciones([
    { campo: "dolor_tobillo", etiqueta: "Dolor del tobillo", tipo: "numero", minimo: 0, maximo: 10, descripcion: "Tobillo derecho, al apoyar. 0 nada, 10 insoportable." },
    { campo: "dolor_aquiles", etiqueta: "Dolor del Aquiles", tipo: "numero", minimo: 0, maximo: 10, descripcion: "Tendón de Aquiles. 0 nada, 10 insoportable." },
  ])) await diario.definir(campo, ahora);
  const campos = new Map((await diario.campos()).map((c) => [c.campo, c]));
  await diario.escribir(HOY, [validarValor(campos.get("dolor_tobillo")!, 1)], ahora);
  for (let i = 1; i < 28; i++) {
    const fecha = addDays(HOY, -i);
    // El Aquiles protesta los lunes, después de la tirada larga.
    const aquiles = weekdayMonday0(fecha) === 0 ? 2 + Math.round(azar()) : azar() > 0.8 ? 1 : 0;
    await diario.escribir(fecha, [
      validarValor(campos.get("dolor_aquiles")!, aquiles),
      validarValor(campos.get("dolor_tobillo")!, azar() > 0.85 ? 1 : 0),
    ], ahora);
  }

  // Material.
  const material = new MaterialStore(db);
  for (const m of [
    { categoria: "Running", nombre: "Zapatillas de rodaje", detalle: "Las de todos los días" },
    { categoria: "Running", nombre: "Chaleco de hidratación 2 L" },
    { categoria: "Fuerza", nombre: "Mancuernas ajustables", detalle: "2-12 kg, en casa" },
    { categoria: "Fuerza", nombre: "Barras del parque", detalle: "En el parque del barrio" },
    { categoria: "Recuperación", nombre: "Pistola de masaje" },
  ]) await material.guardar(validarEntrada(m), ahora);

  // Garmin enlazado con un token que no caduca, y un fetch falso para el calendario.
  await new GarminAlmacen(db, SECRETO).guardar({
    tokens: { accessToken: "a", refreshToken: "r", expiraEn: Date.now() + 1e10 },
    displayName: "atleta-capturas", diClientId: "c",
  });
  const fetchReal = globalThis.fetch;
  globalThis.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = String(entrada instanceof Request ? entrada.url : entrada);
    if (url.includes("/calendar-service/year/")) {
      return new Response(JSON.stringify({ calendarItems: [
        { itemType: "workout", title: "Rodaje 60'", date: HOY, workoutId: 1, id: 91, duration: 3600, sportTypeKey: "running" },
        { itemType: "workout", title: "Fuerza piernas (casa)", date: addDays(HOY, 1), workoutId: 2, id: 92, duration: 2700, sportTypeKey: "strength_training" },
        { itemType: "workout", title: "Umbral 3 × 6'", date: addDays(HOY, 3), workoutId: 3, id: 93, duration: 3300, sportTypeKey: "running" },
        { itemType: "workout", title: "Tirada larga 2 h", date: addDays(HOY, 6), workoutId: 4, id: 94, duration: 7200, sportTypeKey: "running" },
      ] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("connectapi.garmin.com")) return new Response(null, { status: 204 });
    return fetchReal(entrada as RequestInfo, init);
  }) as typeof fetch;

  const env = {
    DB: db, APP_PASSWORD: PASSWORD, SESSION_SECRET: SECRETO, INTERVALS_TZ: "America/Bogota",
    INTERVALS_EN_ENTRENADOR: "no",
  } as unknown as Env;
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  return { env, fetchApp: (r: Request) => app.fetch(r, env, ctx) as Promise<Response> };
}
