/**
 * El diario subjetivo (D1) sin depender de intervals.icu.
 *
 * Es el único sensor de una lesión sin pruebas de imagen: dolor 0-10 el mismo
 * día y a las 48 h, síntomas sí/no. Antes solo se escribía con set_wellness y
 * se leía en get_wellness, las dos de intervals: una instalación solo con
 * Garmin se quedaba sin él. Estas dos herramientas son el diario a secas.
 */

import { addDays } from "../dates";
import {
  DiarioStore,
  descripcionEscala,
  formatearValor,
  normalizarClave,
  parsearDefiniciones,
  validarValor,
  type ValorDiario,
} from "../diario/store";

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

export class DiarioTools {
  constructor(
    private readonly store: DiarioStore,
    private readonly hoy: () => string,
  ) {}

  private fecha(v: unknown): string {
    const t = String(v ?? "").trim().toLowerCase();
    if (!t || t === "hoy") return this.hoy();
    if (t === "ayer") return addDays(this.hoy(), -1);
    if (!FECHA.test(t)) throw new Error(`Fecha no válida: ${JSON.stringify(v)} (YYYY-MM-DD).`);
    return t;
  }

  async escribir(args: Record<string, unknown>): Promise<string> {
    try {
      const dia = this.fecha(args.date);
      const ahora = new Date().toISOString();
      const definidos: string[] = [];
      if (args.definir !== null && args.definir !== undefined) {
        for (const campo of parsearDefiniciones(args.definir)) {
          await this.store.definir(campo, ahora);
          definidos.push(`${campo.campo} (${descripcionEscala(campo)})`);
        }
      }
      const declarados = new Map((await this.store.campos()).map((c) => [c.campo, c]));
      const valores: ValorDiario[] = [];
      const campos = args.campos;
      if (campos !== null && campos !== undefined) {
        if (typeof campos !== "object" || Array.isArray(campos)) {
          throw new Error("'campos' debe ser un objeto {clave: valor}, p. ej. {\"dolor_lesion\": 3}.");
        }
        for (const [bruta, valor] of Object.entries(campos as Record<string, unknown>)) {
          const campo = declarados.get(normalizarClave(bruta));
          if (!campo) {
            throw new Error(
              `'${bruta}' no está declarado, así que NO se ha escrito nada. ` +
                (declarados.size ? `Declarados: ${[...declarados.keys()].join(", ")}. ` : "") +
                "Decláralo en la misma llamada con 'definir'.",
            );
          }
          valores.push(validarValor(campo, valor));
        }
      }
      if (!valores.length && !definidos.length) {
        throw new Error("Nada que escribir: pasa 'campos' o 'definir'.");
      }
      await this.store.escribir(dia, valores, ahora);
      const out = [`Diario del ${dia}:`];
      if (definidos.length) out.push(`  campos declarados: ${definidos.join(" · ")}`);
      for (const v of valores) {
        out.push(`  ${v.campo} = ${formatearValor(declarados.get(v.campo), v)}`);
      }
      return out.join("\n");
    } catch (exc) {
      return `Error: ${exc instanceof Error ? exc.message : String(exc)}`;
    }
  }

  async leer(args: Record<string, unknown>): Promise<string> {
    try {
      const dias = Math.min(120, Math.max(1, Math.round(Number(args.days ?? 14)) || 14));
      const hasta = this.hoy();
      const desde = addDays(hasta, -dias + 1);
      const campos = await this.store.campos();
      if (!campos.length) {
        return (
          "El diario no tiene campos declarados. Si hay una lesión o algo que vigilar, declara " +
            "su escala con diary_set (definir) antes del primer registro."
        );
      }
      const datos = await this.store.leer(desde, hasta);
      const lineas = [
        `Diario ${desde} → ${hasta}:`,
        ...campos.map((c) => `  ${c.campo}: ${descripcionEscala(c)}${c.descripcion ? ` · ${c.descripcion}` : ""}`),
        "",
        ["fecha     ", ...campos.map((c) => c.etiqueta)].join(" | "),
      ];
      for (let d = desde; d <= hasta; d = addDays(d, 1)) {
        const dia = datos.get(d);
        if (!dia) continue;
        lineas.push([d, ...campos.map((c) => formatearValor(c, dia.get(c.campo)))].join(" | "));
      }
      if (lineas.length === campos.length + 3) lineas.push("(sin registros en la ventana)");
      lineas.push("", "Un día sin fila es un día sin registro, no un cero.");
      return lineas.join("\n");
    } catch (exc) {
      return `Error: ${exc instanceof Error ? exc.message : String(exc)}`;
    }
  }
}
