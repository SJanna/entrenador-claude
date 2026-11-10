/**
 * Normalización de claves escritas a mano. La comparten el diario y el
 * material: en los dos, lo que el atleta teclea en una conversación tiene que
 * caer en la misma fila que lo que tecleó en otra ("Recuperación", "recuperacion"
 * y "RECUPERACIÓN" son la misma categoría), o el inventario se fragmenta y el
 * agente deja de encontrar la mitad de las cosas justo cuando las necesita.
 */

const CLAVE_MAX = 40;
const ACENTOS: Record<string, string> = { á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u", ñ: "n" };

/** "Dolor del tobillo" → "dolor_del_tobillo". Vacío si no queda nada utilizable. */
export function normalizarClave(texto: unknown): string {
  const base = String(texto ?? "")
    .trim()
    .toLowerCase()
    .replace(/[áéíóúüñ]/g, (c) => ACENTOS[c] ?? c)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base.slice(0, CLAVE_MAX);
}
