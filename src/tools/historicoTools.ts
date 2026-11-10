/**
 * Herramientas del histórico de Garmin (D1): lo que antes daba intervals.icu.
 *
 * Cada respuesta empieza por la COBERTURA: cuántas actividades y días hay
 * detrás del número. Un CTL calculado sobre tres semanas, o una «mejor marca»
 * sacada de la mitad del histórico, es un número plausible y falso.
 */

import { addDays, mondayOf } from "../dates";
import type { GarminCliente } from "../garmin/cliente";
import {
  DISTANCIAS_MARCA,
  banda,
  esCarrera,
  hms,
  marcasHistoricas,
  ritmo,
  semanas,
  serieCarga,
  type Banda,
} from "../historico/calculos";
import { PRESUPUESTO_POR_DEFECTO, sincronizarHistorico } from "../historico/sincronizar";
import { agregarDias, densificar, rachasDeDias, UMBRALES } from "../streaks/compute";
import { formatRachas } from "../streaks/format";
import type { Calendario } from "../garmin/calendario";
import type { Cobertura, HistoricoStore } from "../historico/store";

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

function entero(v: unknown, def: number, min: number, max: number): number {
  const n = Math.round(Number(v ?? def));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export function lineaCobertura(c: Cobertura): string {
  const partes = [
    `Histórico de Garmin: ${c.actividades} actividades` +
      (c.primera ? ` (${c.primera} → ${c.ultima})` : ""),
    `${c.detallesPendientes} sin series todavía`,
    `bienestar ${c.diasBienestar} días${c.bienestarDesde ? ` desde ${c.bienestarDesde}` : ""}`,
  ];
  const aviso: string[] = [];
  if (!c.cargaInicialCompleta) aviso.push("la carga inicial de actividades no ha terminado");
  if (c.detallesPendientes > 0) aviso.push("faltan series de algunas actividades (marcas y desacople incompletos)");
  if (c.objetivoBienestar && (!c.bienestarDesde || c.bienestarDesde > c.objetivoBienestar)) {
    aviso.push(`el bienestar aún no llega al objetivo (${c.objetivoBienestar})`);
  }
  return (
    partes.join(" · ") +
    (c.ultimaSync ? ` · última sync ${c.ultimaSync.slice(0, 16).replace("T", " ")} UTC` : "") +
    (aviso.length
      ? `\n⚠ HISTÓRICO INCOMPLETO: ${aviso.join("; ")}. Lo que dependa de eso se dice como provisional; ` +
        "garmin_sync adelanta la carga."
      : "")
  );
}

function fmtBanda(nombre: string, b: Banda | null, unidad: string, dec = 0): string {
  if (!b) return `${nombre}: sin datos suficientes (menos de 3 días).`;
  const f = (x: number) => x.toFixed(dec);
  return (
    `${nombre}: mediana ${f(b.mediana)}${unidad} · media ${f(b.media)} ± ${f(b.sd)} · ` +
    `p10-p90 ${f(b.p10)}-${f(b.p90)} · ${b.n} días`
  );
}

export class HistoricoTools {
  constructor(
    private readonly store: HistoricoStore,
    private readonly cliente: GarminCliente,
    private readonly hoy: () => string,
  ) {}

  private async guard(fn: () => Promise<string>): Promise<string> {
    if (!(await this.store.disponible())) {
      return (
        "Error: el histórico de Garmin no existe todavía en esta base (falta la migración 0010). " +
        "Aplica las migraciones: npm run db:migrate."
      );
    }
    try {
      return await fn();
    } catch (exc) {
      return `Error: ${exc instanceof Error ? exc.message : String(exc)}`;
    }
  }

  sync(args: Record<string, unknown>): Promise<string> {
    return this.guard(async () => {
      const presupuesto = entero(args.budget ?? args.presupuesto, PRESUPUESTO_POR_DEFECTO, 6, 25);
      const r = await sincronizarHistorico(this.cliente, this.store, this.hoy(), { presupuesto });
      const lineas = [
        `Sincronización con Garmin: ${r.llamadas} llamadas de ${presupuesto}.`,
        `  actividades nuevas ${r.actividadesNuevas} · series leídas ${r.detalles} · días de bienestar ${r.dias} · pesos ${r.pesos}`,
      ];
      if (r.parado) lineas.push(`  Parada: ${r.parado}.`);
      if (r.errores.length) lineas.push("  Errores puntuales:", ...r.errores.map((e) => `    · ${e}`));
      lineas.push("", lineaCobertura(await this.store.cobertura()));
      return lineas.join("\n");
    });
  }

  semanal(args: Record<string, unknown>): Promise<string> {
    return this.guard(async () => {
      const n = entero(args.weeks ?? args.semanas, 8, 1, 52);
      const hoy = this.hoy();
      const desdeSemanas = addDays(mondayOf(hoy), -7 * (n - 1));
      const todas = await this.store.actividades();
      const cobertura = await this.store.cobertura();
      const inicio = todas[0]?.fecha ?? hoy;
      const carga = serieCarga(todas, inicio, hoy);
      const porFecha = new Map(carga.dias.map((d) => [d.fecha, d]));
      const lineas = [lineaCobertura(cobertura), ""];
      lineas.push("semana (lun) | ses | horas | km correr | km a pie | desnivel | carga | CTL | ATL | TSB");
      for (const s of semanas(todas, desdeSemanas, hoy)) {
        const fin = addDays(s.lunes, 6) > hoy ? hoy : addDays(s.lunes, 6);
        const c = porFecha.get(fin);
        lineas.push(
          [
            s.lunes + (addDays(s.lunes, 6) > hoy ? "*" : " "),
            String(s.sesiones).padStart(3),
            (s.segundos / 3600).toFixed(1).padStart(5),
            s.kmCarrera.toFixed(1).padStart(9),
            s.kmAPie.toFixed(1).padStart(8),
            `${Math.round(s.desnivel)} m`.padStart(8),
            String(Math.round(s.carga)).padStart(5),
            c ? c.ctl.toFixed(0).padStart(3) : "  —",
            c ? c.atl.toFixed(0).padStart(3) : "  —",
            c ? c.tsb.toFixed(0).padStart(3) : "  —",
          ].join(" | "),
        );
      }
      const hoyC = porFecha.get(hoy);
      lineas.push("", "* semana en curso.");
      if (hoyC) {
        lineas.push(
          `Hoy: CTL ${hoyC.ctl.toFixed(0)} · ATL ${hoyC.atl.toFixed(0)} · TSB ${hoyC.tsb.toFixed(0)} ` +
            "(medias de 42 y 7 días sobre la carga de Garmin).",
        );
      }
      lineas.push(
        "OJO: la escala es la de la carga de Garmin (activityTrainingLoad), NO la de intervals.icu: " +
          "estos CTL no se comparan con los que se leían antes de intervals, solo entre sí.",
      );
      if (carga.fiableDesde > hoy) {
        lineas.push(`⚠ CTL poco fiable hasta ${carga.fiableDesde}: arranca en 0 con la primera actividad.`);
      }
      if (carga.sinCarga) lineas.push(`${carga.sinCarga} actividades de 10 min o más sin carga de Garmin: no suman.`);
      return lineas.join("\n");
    });
  }

  marcas(args: Record<string, unknown>): Promise<string> {
    return this.guard(async () => {
      const desde = typeof args.from === "string" && FECHA.test(args.from) ? args.from : undefined;
      const todas = await this.store.actividades({ desde });
      const lineas = [lineaCobertura(await this.store.cobertura()), ""];
      lineas.push(`Mejores marcas en carrera a pie${desde ? ` desde ${desde}` : " (histórico entero)"}, sacadas de las series:`);
      const m = marcasHistoricas(todas, 3);
      for (const dist of DISTANCIAS_MARCA) {
        const lista = m.get(dist) ?? [];
        if (!lista.length) continue;
        const nombre = dist >= 1000 ? `${(dist / 1000).toLocaleString("es")} km` : `${dist} m`;
        lineas.push(
          `  ${nombre.padEnd(9)} ` +
            lista
              .map((x) => `${hms(x.segundos)} (${ritmo(x.segundos, dist)}, ${x.fecha}, ${x.actividad})`)
              .join(" · "),
        );
      }
      if (lineas.length === 3) lineas.push("  (todavía no hay series de carrera leídas)");
      const fc = todas
        .filter((a) => a.fc_max_serie || a.fc_max)
        .map((a) => ({ v: (a.fc_max_serie ?? a.fc_max) as number, a }))
        .sort((x, y) => y.v - x.v)
        .slice(0, 5);
      if (fc.length) {
        lineas.push(
          "",
          "FC máxima: los 5 valores más altos (sostenidos 2 muestras cuando hay series; óptico de " +
            "muñeca incluido, así que un pico aislado es sospechoso):",
          ...fc.map((x) => `  ${x.v} ppm · ${x.a.fecha} · ${x.a.deporte} · ${x.a.id}`),
        );
      }
      lineas.push(
        "",
        "Resolución: ~2.000 muestras por actividad (unos segundos entre muestras en las largas): " +
          "las marcas cortas van con ±3-5 s. Marcas más rápidas que 2:30/km se descartan como GPS.",
      );
      return lineas.join("\n");
    });
  }

  bienestar(args: Record<string, unknown>): Promise<string> {
    return this.guard(async () => {
      const dias = entero(args.days ?? args.dias, 120, 7, 365);
      const hoy = this.hoy();
      const filas = await this.store.bienestar(addDays(hoy, -dias + 1), hoy);
      const lineas = [lineaCobertura(await this.store.cobertura()), ""];
      lineas.push(`Bandas sobre los últimos ${dias} días (lo que haya leído):`);
      lineas.push(fmtBanda("  FC en reposo", banda(filas.map((f) => f.fc_reposo)), " ppm"));
      lineas.push(fmtBanda("  VFC nocturna", banda(filas.map((f) => f.hrv_noche)), " ms"));
      lineas.push(fmtBanda("  Sueño", banda(filas.map((f) => (f.sueno_seg ? f.sueno_seg / 3600 : null))), " h", 1));
      const pesos = filas.filter((f) => f.peso_kg);
      if (pesos.length) {
        const p = pesos.map((f) => f.peso_kg as number);
        lineas.push(
          `  Peso: último ${p[p.length - 1]} kg (${pesos[pesos.length - 1]!.fecha}) · ` +
            `mín ${Math.min(...p)} · máx ${Math.max(...p)} · ${p.length} pesadas`,
        );
      } else {
        lineas.push("  Peso: sin pesadas en Garmin en esta ventana.");
      }
      lineas.push(
        "  Una banda calculada con menos días que la ventana pedida es provisional: dilo. Ningún " +
          "corte se pone en la propia mediana: suspendería la mitad de los días sanos.",
      );
      const ultimos = filas.slice(-14);
      if (ultimos.length) {
        lineas.push("", "fecha      | FCrep | VFC | sueño | punt | readiness | aguda/crónica");
        for (const f of ultimos) {
          lineas.push(
            [
              f.fecha,
              String(f.fc_reposo ?? "—").padStart(5),
              String(f.hrv_noche ?? "—").padStart(3),
              (f.sueno_seg ? (f.sueno_seg / 3600).toFixed(1) : "—").padStart(5),
              String(f.sueno_puntuacion ?? "—").padStart(4),
              String(f.readiness ?? "—").padStart(9),
              f.carga_aguda !== null && f.carga_cronica !== null ? `${f.carga_aguda}/${f.carga_cronica}` : "—",
            ].join(" | "),
          );
        }
      }
      return lineas.join("\n");
    });
  }

  /**
   * Rachas con las mismas reglas que get_streaks (src/streaks/compute.ts), pero
   * sobre el histórico de Garmin: actividades de D1, sueño de D1 y el
   * calendario de Garmin para saber qué estaba programado y qué descanso estaba
   * escrito. Un día vacío sigue siendo un día perdido, no un descanso.
   */
  rachas(
    args: Record<string, unknown>,
    calendario: (desde: string, hasta: string) => Promise<Calendario>,
  ): Promise<string> {
    return this.guard(async () => {
      const dias = entero(args.days, 120, 14, 365);
      const minutos = entero(args.min_minutos, Math.round(UMBRALES.minSegundos / 60), 1, 120);
      const hoy = this.hoy();
      const desde = addDays(hoy, -(dias - 1));
      const [acts, bien, cal] = await Promise.all([
        this.store.actividades({ desde, hasta: hoy }),
        this.store.bienestar(desde, hoy),
        calendario(desde, hoy).catch(() => null),
      ]);
      const eventos = (cal?.items ?? [])
        .filter((i) => i.activityId === null)
        .map((i) => ({
          fecha: i.fecha,
          // Lo programado es sesión; lo demás (notas) puede declarar descanso.
          categoria: i.workoutId !== null || i.tipo === "workout" ? "WORKOUT" : "NOTE",
          nombre: i.titulo,
          segundos: i.duracionSegundos,
        }));
      const agregados = agregarDias({
        hoy,
        desde,
        actividades: acts.map((a) => ({ fecha: a.fecha, deporte: a.deporte, segundos: a.segundos, carga: a.carga })),
        eventos,
        bienestar: bien.map((b) => ({ fecha: b.fecha, sueno_secs: b.sueno_seg })),
      });
      const r = rachasDeDias(densificar(desde, hoy, agregados), {
        hoy,
        umbrales: { minSegundos: minutos * 60 },
      });
      return (
        lineaCobertura(await this.store.cobertura()) +
        (cal ? "" : "\n⚠ El calendario de Garmin no se pudo leer: el cumplimiento del plan y los descansos escritos no cuentan.") +
        "\n\n" +
        formatRachas(r)
      );
    });
  }

  buscar(args: Record<string, unknown>): Promise<string> {
    return this.guard(async () => {
      const desde = typeof args.from === "string" && FECHA.test(args.from) ? args.from : undefined;
      const hasta = typeof args.to === "string" && FECHA.test(args.to) ? args.to : undefined;
      const deporte = String(args.sport ?? "").trim().toLowerCase();
      const minKm = Number(args.min_km ?? 0) || 0;
      const minMin = Number(args.min_minutes ?? 0) || 0;
      const limite = entero(args.limit, 30, 1, 200);
      let lista = await this.store.actividades({ desde, hasta });
      if (deporte === "correr" || deporte === "run") lista = lista.filter((a) => esCarrera(a.deporte));
      else if (deporte) lista = lista.filter((a) => a.deporte.includes(deporte));
      lista = lista.filter(
        (a) => (a.distancia_m ?? 0) / 1000 >= minKm && (a.segundos ?? 0) / 60 >= minMin,
      );
      const total = lista.length;
      const km = lista.reduce((s, a) => s + (a.distancia_m ?? 0), 0) / 1000;
      const horas = lista.reduce((s, a) => s + (a.segundos ?? 0), 0) / 3600;
      const lineas = [
        lineaCobertura(await this.store.cobertura()),
        "",
        `${total} actividades · ${km.toFixed(1)} km · ${horas.toFixed(1)} h` +
          (total > limite ? ` (se enseñan las ${limite} más recientes)` : ""),
        "fecha      | deporte | nombre | tiempo | km | ritmo | FC | desnivel | carga | desacople | id",
      ];
      for (const a of lista.slice(-limite).reverse()) {
        lineas.push(
          [
            a.fecha,
            a.deporte,
            (a.nombre ?? "").slice(0, 28),
            a.segundos ? hms(a.segundos) : "—",
            a.distancia_m ? (a.distancia_m / 1000).toFixed(2) : "—",
            a.segundos && a.distancia_m && esCarrera(a.deporte) ? ritmo(a.segundos, a.distancia_m) : "—",
            a.fc_media ? Math.round(a.fc_media) : "—",
            a.desnivel_m ? `${Math.round(a.desnivel_m)} m` : "—",
            a.carga ? Math.round(a.carga) : "—",
            a.desacople_pct !== null && a.desacople_pct !== undefined
              ? `${a.desacople_pct.toFixed(1)}%`
              : a.detalle_estado === "pendiente"
                ? "pendiente"
                : "—",
            a.id,
          ].join(" | "),
        );
      }
      lineas.push(
        "",
        "Desacople = Pa:FC de la primera mitad frente a la segunda, en tiempo en movimiento; solo con " +
          "40 min o más. En terreno con mucha pendiente sale inflado: no lo leas sin mirar el desnivel.",
      );
      return lineas.join("\n");
    });
  }
}
