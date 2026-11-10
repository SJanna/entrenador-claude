/**
 * Caché en memoria del isolate, con TTL corto.
 *
 * Por qué no la Cache API: en dominios `*.workers.dev` sus operaciones son
 * no-ops, que es justo donde vive esta app. Un Map por isolate sí funciona en
 * todas partes y cubre el caso real: abrir el panel, cerrarlo y volver a
 * abrirlo en el mismo minuto, o que el panel y Claude pidan lo mismo a la vez.
 *
 * Es una caché de conveniencia, no una fuente de verdad:
 *  - el isolate se recicla cuando quiera y eso solo cuesta una petición más;
 *  - `fresh` la salta entera (el botón de refrescar del panel lo usa);
 *  - nunca se cachean escrituras ni el contrato (que sale de D1 y es barato).
 *
 * App de un solo atleta con una sola contraseña: no hay datos de terceros que
 * se puedan cruzar entre peticiones.
 */

interface Entrada {
  expira: number;
  valor: unknown;
}

const CACHE = new Map<string, Entrada>();
const MAX_ENTRADAS = 64;

/** Descarta lo caducado y, si aún sobra, lo más viejo. */
function podar(): void {
  const ahora = Date.now();
  for (const [clave, entrada] of CACHE) {
    if (entrada.expira <= ahora) CACHE.delete(clave);
  }
  while (CACHE.size > MAX_ENTRADAS) {
    const primera = CACHE.keys().next();
    if (primera.done) break;
    CACHE.delete(primera.value);
  }
}

/**
 * Devuelve lo cacheado si sigue vivo; si no, ejecuta `fn` y lo guarda.
 * Un fallo de `fn` no se cachea: el siguiente intento vuelve a pedirlo.
 */
export async function cacheado<T>(
  clave: string,
  ttlMs: number,
  fresh: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (fresh) CACHE.delete(clave);
  else {
    const entrada = CACHE.get(clave);
    if (entrada && entrada.expira > Date.now()) return entrada.valor as T;
  }
  const valor = await fn();
  CACHE.set(clave, { expira: Date.now() + ttlMs, valor });
  podar();
  return valor;
}

/** Para los tests: deja la caché vacía. */
export function vaciarCache(): void {
  CACHE.clear();
}
