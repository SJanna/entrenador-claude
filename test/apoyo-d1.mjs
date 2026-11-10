/**
 * D1 de mentira sobre SQLite de verdad (`node:sqlite`), para ejercitar
 * ContractStore en los unitarios sin levantar wrangler.
 *
 * Existe por el fallo del 04/09/2026: el código de la migración 0006 llegó a
 * producción antes que la migración, y `get_contract` —la lectura que el
 * protocolo exige ANTES de prescribir— murió con «no such column: vence».
 * Ningún test lo cazó porque todos corrían contra el esquema al día. Con esto
 * se puede montar la base parada en cualquier migración y comprobar que el
 * código de hoy sigue leyendo la base de ayer.
 *
 * Va en .mjs, como el e2e, porque el proyecto se tipa con los tipos de
 * Workers y no con los de Node: meter @types/node por un apoyo de test
 * arriesga los globales del código que sí se despliega.
 *
 * Imita lo que ContractStore usa de D1 y nada más: prepare/bind/all/first/run
 * y batch transaccional.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRACIONES = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

class Sentencia {
  constructor(db, sql, binds = []) {
    this.db = db;
    this.sql = sql;
    this.binds = binds;
  }

  bind(...valores) {
    return new Sentencia(this.db, this.sql, valores);
  }

  ejecutar() {
    // SQLite no acepta undefined ni booleanos; D1 tampoco los recibiría.
    const valores = this.binds.map((v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v));
    const stmt = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)) return stmt.all(...valores);
    stmt.run(...valores);
    return [];
  }

  async all() {
    return { results: this.ejecutar(), success: true };
  }

  async first() {
    return this.ejecutar()[0] ?? null;
  }

  async run() {
    this.ejecutar();
    return { success: true };
  }
}

/**
 * Base en memoria con las migraciones aplicadas en orden, opcionalmente
 * saltándose algunas: `{ salta: ["0006"] }` reproduce producción el 04/09.
 */
export function d1EnMemoria({ salta = [] } = {}) {
  const db = new DatabaseSync(":memory:");
  const ficheros = readdirSync(MIGRACIONES).filter((f) => f.endsWith(".sql")).sort();
  const aplicadas = [];
  for (const fichero of ficheros) {
    if (salta.some((prefijo) => fichero.startsWith(prefijo))) continue;
    db.exec(readFileSync(join(MIGRACIONES, fichero), "utf8"));
    aplicadas.push(fichero);
  }
  return {
    aplicadas,
    prepare: (sql) => new Sentencia(db, sql),
    async batch(sentencias) {
      // D1.batch es transaccional: o entran todas o no entra ninguna.
      db.exec("BEGIN");
      try {
        const salida = [];
        for (const s of sentencias) salida.push(await s.all());
        db.exec("COMMIT");
        return salida;
      } catch (exc) {
        db.exec("ROLLBACK");
        throw exc;
      }
    },
    /** Para asertar sobre las filas sin pasar por el store. */
    filas: (sql) => db.prepare(sql).all(),
  };
}
