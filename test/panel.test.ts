/**
 * El panel es ~1000 líneas de JavaScript dentro de un template string, así que
 * `tsc` no mira ahí dentro: un paréntesis de más se despliega tan campante y en
 * el móvil sale una página en blanco, sin error visible.
 *
 * Estos tests son la red que faltaba. No prueban comportamiento —para eso está
 * el e2e—, sino que el HTML que servimos es sintácticamente válido y que sigue
 * llevando las piezas de las que depende el resto de la app.
 */

import { describe, expect, it } from "vitest";
import { appPage } from "../src/web/app";

const html = appPage();

/** El contenido del único <script> de la página. */
function scriptDelPanel(): string {
  const abre = html.indexOf("<script>");
  const cierra = html.indexOf("</script>", abre);
  expect(abre, "la página debe llevar un <script>").toBeGreaterThan(-1);
  expect(cierra, "el <script> debe estar cerrado").toBeGreaterThan(abre);
  return html.slice(abre + "<script>".length, cierra);
}

describe("panel web", () => {
  it("el JavaScript embebido compila", () => {
    const codigo = scriptDelPanel();
    expect(codigo.length).toBeGreaterThan(1000);
    // `new Function` COMPILA sin ejecutar: detecta errores de sintaxis sin
    // necesitar un DOM. Si esto pasa, el navegador tampoco se atragantará.
    expect(() => new Function(codigo)).not.toThrow();
  });

  it("no deja un </script> suelto que corte la página a la mitad", () => {
    // Cualquier cadena que contenga "</script>" cierra el bloque ahí mismo y el
    // resto del panel se pinta como texto.
    expect(html.split("</script>").length).toBe(2);
  });

  it("sirve las piezas que el resto de la app espera", () => {
    for (const anzuelo of [
      'id="contenido"',
      'id="tabs"',
      'id="version-chip"',
      'id="fecha-hoy"',
      'id="refrescar"',
      'rel="manifest"',
    ]) {
      expect(html, `falta ${anzuelo}`).toContain(anzuelo);
    }
  });

  it("pide cada bloque de datos a una ruta de la API", () => {
    const codigo = scriptDelPanel();
    for (const ruta of ["/hoy", "/semana?", "/progreso?", "/rachas", "/contract", "/log?", "/diario?", "/material", "/app/garmin/estado"]) {
      expect(codigo, `el panel ya no pide ${ruta}`).toContain(ruta);
    }
  });

  it("no lee nada de intervals.icu: todo sale de Garmin, el contrato y el diario", () => {
    const codigo = scriptDelPanel();
    for (const ruta of ["/events", "/wellness", "/activities", "/streaks", "/import/"]) {
      expect(codigo, `el panel aún pide ${ruta}`).not.toContain(`"${ruta}`);
    }
    expect(html.toLowerCase()).not.toContain("intervals");
  });

  it("lleva la identidad: tipografías propias, pintas y nav de cinco pestañas", () => {
    expect(html).toContain("/fuentes/bungee.woff2");
    expect(html).toContain('class="pintas"');
    const codigo = scriptDelPanel();
    for (const id of ["hoy", "semana", "progreso", "contrato", "mas"]) {
      expect(codigo).toContain(`id: "${id}"`);
    }
  });

  it("no arrastra recursos externos: todo va embebido", () => {
    // Sin CDNs: el panel tiene que abrir con una sola petición, incluso con
    // mala cobertura, y no depende de que un tercero siga en pie.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet/i);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});
