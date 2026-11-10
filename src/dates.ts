/**
 * Aritmética de fechas ISO (YYYY-MM-DD) sin líos de zona horaria: se opera
 * siempre en UTC sobre la fecha civil, nunca sobre un instante local.
 *
 * Vive suelto, fuera de tools/ y de streaks/, porque lo usan los dos y así no
 * hay importaciones circulares.
 */

/** Suma `days` (puede ser negativo) a una fecha YYYY-MM-DD. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d! + days));
  return date.toISOString().slice(0, 10);
}

/** Día de la semana con el lunes como 0 (domingo = 6). */
export function weekdayMonday0(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0 = domingo
  return (day + 6) % 7;
}

/** Lunes de la semana de `iso`. */
export function mondayOf(iso: string): string {
  return addDays(iso, -weekdayMonday0(iso));
}
