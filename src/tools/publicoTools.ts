/**
 * set_plan_publico: lo que la página pública de progreso no puede deducir sola.
 *
 *  - Los km de carrera planificados de cada semana. Garmin planifica por tiempo,
 *    así que este número no existe en ningún otro sitio. Se congela el lunes.
 *  - Las fechas de las temporadas y el día D, que se mueven si falla un gate.
 *  - Los hitos manuales: la primera salida de noche, o una maratón que el GPS
 *    midió en 42,1 km.
 *
 * Todo o nada, como contract_commit: si un cambio no vale, no se escribe
 * ninguno. Sin argumentos, enseña lo que hay.
 */

import { addDays, mondayOf } from "../dates";
import {
  CLAVES_HITO,
  HITOS,
  diasEntre,
  erroresTemporadas,
  esFecha,
  esLunes,
  motivoCongelado,
  redondear,
  type PlanSemana,
  type Temporada,
} from "../publico/compute";
import { PublicoStore, type CambiosPublicos } from "../publico/store";

const DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

function diaSemana(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00Z`).getUTCDay();
  return DIAS[(d + 6) % 7]!;
}

function km(valor: number): string {
  return `${String(redondear(valor)).replace(".", ",")} km`;
}

export class PublicoTools {
  constructor(
    private store: PublicoStore,
    private hoy: () => string,
  ) {}

  async setPlanPublico(args: Record<string, unknown>, ahora: string): Promise<string> {
    try {
      const cambios = await this.validar(args);
      const hayCambios = Boolean(
        cambios.diaD || cambios.temporadas?.length || cambios.plan?.length || cambios.hitos?.length,
      );
      if (hayCambios) await this.store.aplicar(cambios, ahora);
      return (hayCambios ? `${this.describirCambios(cambios)}\n\n` : "") + (await this.estado());
    } catch (exc) {
      return `Error: ${exc instanceof Error ? exc.message : String(exc)}\nNo se ha escrito nada.`;
    }
  }

  private async validar(args: Record<string, unknown>): Promise<CambiosPublicos> {
    const hoy = this.hoy();
    const errores: string[] = [];
    const cfg = await this.store.config();
    const cambios: CambiosPublicos = {};

    // ------------------------------------------------- día D y temporadas
    let diaD = cfg.diaD;
    if (args.dia_d !== undefined && args.dia_d !== null) {
      const nuevo = String(args.dia_d).trim();
      if (!esFecha(nuevo)) errores.push(`dia_d tiene que ser YYYY-MM-DD (recibido ${JSON.stringify(args.dia_d)})`);
      else if (nuevo !== cfg.diaD) {
        diaD = nuevo;
        cambios.diaD = nuevo;
      }
    }

    const temporadas = new Map<number, Temporada>(cfg.temporadas.map((t) => [t.numero, { ...t }]));
    const tocadas = new Set<number>();
    const entrada = args.temporadas;
    if (entrada !== undefined && entrada !== null) {
      if (!Array.isArray(entrada)) errores.push("temporadas tiene que ser una lista");
      else {
        for (const bruto of entrada) {
          const t = (bruto ?? {}) as Record<string, unknown>;
          const numero = Number(t.numero);
          const actual = temporadas.get(numero);
          if (!actual) {
            errores.push(`temporada ${JSON.stringify(t.numero)}: solo existen de la 0 a la 4`);
            continue;
          }
          if (t.nombre !== undefined) actual.nombre = String(t.nombre).trim();
          if (t.desde !== undefined) actual.desde = String(t.desde).trim();
          if (t.hasta !== undefined) actual.hasta = String(t.hasta).trim();
          tocadas.add(numero);
        }
      }
    }
    // Mover el día D arrastra el final de la T4, salvo que venga escrito aparte.
    const t4 = temporadas.get(4);
    if (cambios.diaD && t4 && !(Array.isArray(entrada) && entrada.some((t) => Number(t?.numero) === 4 && t?.hasta !== undefined))) {
      t4.hasta = diaD;
      tocadas.add(4);
    }
    if (cambios.diaD || tocadas.size) {
      errores.push(...erroresTemporadas([...temporadas.values()], diaD));
      cambios.temporadas = [...tocadas].sort().map((n) => temporadas.get(n)!);
    }

    // --------------------------------------------------------- plan semanal
    if (args.semanas !== undefined && args.semanas !== null) {
      if (!Array.isArray(args.semanas)) errores.push("semanas tiene que ser una lista");
      else {
        const existentes = new Set((await this.store.plan()).map((p) => p.lunes));
        const plan: PlanSemana[] = [];
        for (const bruto of args.semanas) {
          const s = (bruto ?? {}) as Record<string, unknown>;
          const lunes = String(s.lunes ?? "").trim();
          const valor = Number(s.km);
          if (!esFecha(lunes)) {
            errores.push(`semana ${JSON.stringify(s.lunes)}: 'lunes' tiene que ser YYYY-MM-DD`);
            continue;
          }
          if (!esLunes(lunes)) {
            errores.push(`semana ${lunes}: es ${diaSemana(lunes)}; el lunes de esa semana es ${mondayOf(lunes)}`);
            continue;
          }
          if (!Number.isFinite(valor) || valor < 0 || valor > 400) {
            errores.push(`semana ${lunes}: km entre 0 y 400 (recibido ${JSON.stringify(s.km)})`);
            continue;
          }
          const congelada = motivoCongelado(lunes, hoy, existentes.has(lunes));
          if (congelada) {
            errores.push(`semana ${lunes}: ${congelada}. El plan de una semana empezada no se reescribe.`);
            continue;
          }
          plan.push({ lunes, km: redondear(valor) });
        }
        cambios.plan = plan;
      }
    }

    // ---------------------------------------------------------------- hitos
    if (args.hitos !== undefined && args.hitos !== null) {
      if (!Array.isArray(args.hitos)) errores.push("hitos tiene que ser una lista");
      else {
        cambios.hitos = [];
        for (const bruto of args.hitos) {
          const h = (bruto ?? {}) as Record<string, unknown>;
          const clave = String(h.clave ?? "").trim();
          if (!CLAVES_HITO.includes(clave)) {
            errores.push(`hito ${JSON.stringify(h.clave)}: claves válidas ${CLAVES_HITO.join(", ")}`);
            continue;
          }
          if (h.fecha === null) {
            cambios.hitos.push({ clave, fecha: null });
            continue;
          }
          const fecha = String(h.fecha ?? "").trim();
          if (!esFecha(fecha)) errores.push(`hito ${clave}: fecha YYYY-MM-DD, o null para quitarlo`);
          else if (fecha > hoy) errores.push(`hito ${clave}: ${fecha} es futuro; un hito se marca cuando cae`);
          else cambios.hitos.push({ clave, fecha });
        }
      }
    }

    if (errores.length) throw new Error(errores.map((e) => `· ${e}`).join("\n"));
    return cambios;
  }

  private describirCambios(c: CambiosPublicos): string {
    const lineas = ["Escrito:"];
    if (c.diaD) lineas.push(`  día D → ${c.diaD} (${diaSemana(c.diaD)})`);
    for (const t of c.temporadas ?? []) lineas.push(`  T${t.numero} ${t.nombre}: ${t.desde} → ${t.hasta}`);
    for (const p of c.plan ?? []) lineas.push(`  semana ${p.lunes}: ${km(p.km)} planificados`);
    for (const h of c.hitos ?? []) {
      lineas.push(h.fecha ? `  hito ${h.clave}: ${h.fecha}` : `  hito ${h.clave}: quitado`);
    }
    lineas.push("La página lo enseña tras el próximo cálculo (cron de las 03:00, o «Publicar ya» en Ajustes del panel).");
    return lineas.join("\n");
  }

  private async estado(): Promise<string> {
    const hoy = this.hoy();
    const [cfg, plan, manuales] = await Promise.all([
      this.store.config(),
      this.store.plan(),
      this.store.hitosManuales(),
    ]);
    const lineas = [
      "PÁGINA PÚBLICA · lo que no sale de los datos",
      `Día D: ${cfg.diaD} (${diaSemana(cfg.diaD)}) · faltan ${diasEntre(hoy, cfg.diaD)} días`,
      "",
      "Temporadas:",
      ...cfg.temporadas.map(
        (t) =>
          `  T${t.numero} ${t.nombre.padEnd(12)} ${t.desde} → ${t.hasta}` +
          (t.desde <= hoy && hoy <= t.hasta ? "  ← ahora" : ""),
      ),
      "",
    ];
    const lunesHoy = mondayOf(hoy);
    const recientes = plan.filter((p) => p.lunes >= addDays(lunesHoy, -28));
    lineas.push("Km planificados (últimas 4 semanas y siguientes):");
    if (!recientes.length) lineas.push("  (ninguno)");
    for (const p of recientes) {
      const estado =
        p.lunes > hoy ? `editable hasta el domingo ${addDays(p.lunes, -1)}` : "congelado";
      lineas.push(`  ${p.lunes}  ${km(p.km).padStart(9)}  · ${estado}`);
    }
    const siguiente = addDays(lunesHoy, 7);
    if (!plan.some((p) => p.lunes === siguiente)) {
      lineas.push(`  ${siguiente}  sin plan todavía · se congela ese lunes`);
    }
    lineas.push("", "Hitos manuales:");
    if (!manuales.length) lineas.push("  (ninguno)");
    for (const h of manuales) {
      const def = HITOS.find((x) => x.clave === h.clave);
      lineas.push(`  ${h.clave} (${def?.etiqueta ?? "?"}): ${h.fecha}`);
    }
    lineas.push(
      "",
      "Los hitos por distancia caen solos con la primera actividad de carrera que los alcanza " +
        "desde el inicio de la T1; marcarlos a mano solo hace falta si el GPS se quedó corto.",
    );
    return lineas.join("\n");
  }
}
