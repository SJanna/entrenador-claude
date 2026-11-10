/**
 * La identidad visual de «zancada»: arena y tinta, tres acentos (mar, coral, sol), Bungee para cifras y
 * títulos, Silkscreen para etiquetas e Inter para leer. Tarjetas de borde
 * grueso, teclas con sombra dura y la franja de pintas arriba.
 *
 * Un solo sitio para los tokens: el panel, el login y la página de Garmin
 * leen de aquí, así que cambiar un color no deja una pantalla huérfana.
 */

import { FUENTES } from "./fuentes";

export const NOMBRE_APP = "zancada";

/** Colores de la identidad. El modo noche replica el de la página pública. */
export const COLORES = {
  arena: "#F6EBD3",
  superficie: "#FFF8EA",
  tinta: "#1E1A14",
  apagado: "#665A45",
  mar: "#0E6F79",
  coral: "#C23A1A",
  sol: "#F2B705",
  crema: "#F4EBD6",
  dim: "#E2CFA6",
} as const;

/** Las fuentes se sirven aparte con caché larga: la página no las arrastra. */
export function fuenteWoff2(nombre: string): Uint8Array<ArrayBuffer> | null {
  const b64 = FUENTES[nombre];
  if (!b64) return null;
  const binario = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binario.length));
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

export const CSS_BASE = `
@font-face { font-family: Bungee; src: url(/fuentes/bungee.woff2) format("woff2"); font-display: swap; }
@font-face { font-family: Silkscreen; src: url(/fuentes/silkscreen.woff2) format("woff2"); font-display: swap; }
@font-face { font-family: Inter; src: url(/fuentes/inter.woff2) format("woff2"); font-weight: 100 900; font-display: swap; }
:root {
  color-scheme: light;
  --arena: ${COLORES.arena}; --sup: ${COLORES.superficie}; --tinta: ${COLORES.tinta};
  --apagado: ${COLORES.apagado}; --mar: ${COLORES.mar}; --coral: ${COLORES.coral};
  --sol: ${COLORES.sol}; --crema: ${COLORES.crema}; --dim: ${COLORES.dim};
  --negro: #1E1A14; --sobre-negro: #F4EBD6; --enlace-negro: #8CC3C2;
  --bien: #CFF3EF; --blanco: #FFFFFF;
  --nada: #B9A77E; --agua: #0891B2; --fuerza: #7A6A3A;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --arena: #0B1E26; --sup: #12303A; --tinta: #F4EBD6; --apagado: #A9B9B8;
    --mar: #3CC8C8; --coral: #FF7B54; --sol: #F2C14E; --crema: #12303A; --dim: #2A4A55;
    --negro: #061218; --sobre-negro: #F4EBD6; --bien: #1D4F55; --blanco: #0B1E26;
    --nada: #6F8A8C; --agua: #4FC3E0; --fuerza: #C9B27A;
  }
}
* { box-sizing: border-box; margin: 0; }
html { -webkit-text-size-adjust: 100%; }
body {
  font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--arena); color: var(--tinta);
  font-size: 15px; line-height: 1.45; min-height: 100dvh;
}
a { color: var(--mar); }
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 3px solid var(--sol); outline-offset: 2px; }
.pintas {
  height: 14px;
  background:
    linear-gradient(135deg, var(--tinta) 25%, transparent 25%) -7px 0 / 14px 14px,
    linear-gradient(225deg, var(--tinta) 25%, transparent 25%) -7px 0 / 14px 14px,
    var(--crema);
}
.bungee { font-family: Bungee, system-ui, sans-serif; font-weight: 400; }
.etq {
  font-family: Silkscreen, ui-monospace, monospace; font-size: 11px;
  letter-spacing: .02em; color: var(--apagado); text-transform: uppercase;
}
.tarjeta {
  border: 2px solid var(--tinta); border-radius: 12px; background: var(--sup);
  padding: 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0;
}
.tecla {
  min-height: 44px; padding: 0 14px; border: 2px solid var(--tinta); border-radius: 8px;
  background: var(--sup); color: var(--tinta); cursor: pointer;
  font-family: Silkscreen, ui-monospace, monospace; font-size: 11px;
  box-shadow: 0 3px 0 var(--tinta); transition: transform .06s, box-shadow .06s;
}
.tecla:active { transform: translateY(3px); box-shadow: 0 0 0 var(--tinta); }
.tecla[aria-pressed="true"], .tecla[aria-selected="true"] {
  background: var(--tinta); color: var(--arena); box-shadow: none; transform: translateY(3px);
}
.tecla.primaria {
  background: var(--coral); color: var(--crema); font-family: Bungee, sans-serif; font-size: 15px;
}
.tecla:disabled { opacity: .5; cursor: default; }
.campo {
  min-height: 46px; padding: 0 12px; border: 2px solid var(--tinta); border-radius: 8px;
  background: var(--blanco); color: var(--tinta); width: 100%; font-size: 16px;
}
textarea.campo { padding: 10px 12px; min-height: 84px; }
`;
