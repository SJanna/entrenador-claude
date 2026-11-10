import { describe, expect, it } from "vitest";
import { ESTANCADOS_AVISO, saludContrato } from "../src/tools/contractTools";
import {
  comprobarLimite,
  formatoMiles,
  LIMITES,
  tipoFiltroLog,
  type Carrera,
  type ContractSnapshot,
  type EstadoEntry,
  type LogEntry,
  type Pendiente,
  type Regla,
} from "../src/contract/store";
import {
  ANCHO_MAX,
  ANCHO_MIN,
  anchoCompacto,
  lineaIndiceLog,
  lineasEntradaLog,
  PRESUPUESTO_COMPACTO,
  recortar,
  renderContract,
} from "../src/tools/contractTools";

const HOY = "2026-09-03";

function prosa(n: number, semilla = "x"): string {
  const palabras = ["tobillo", "carga", "semana", "ritmo", "cuesta", "descanso", "umbral", semilla];
  let out = "";
  let i = 0;
  while (out.length < n) out += `${palabras[i++ % palabras.length]} `;
  return out.slice(0, n).trim();
}

function regla(p: Partial<Regla> & { id: string }): Regla {
  return {
    tema: "tema", contenido: prosa(1200, p.id), resumen: null, vence: null, estado: "activa",
    creada_en: "2026-08-11", creada_version: 1, finalizada_en: null, finalizada_version: null,
    motivo_baja: null, ...p,
  };
}
function pendiente(p: Partial<Pendiente> & { id: number }): Pendiente {
  return {
    texto: prosa(900, `p${p.id}`), resumen: null, vence: null, estado: "abierto",
    creado_en: "2026-08-20", actualizado_en: null, resuelto_en: null, ...p,
  };
}
function estado(clave: string, valor: string, actualizado_en = "2026-09-01"): EstadoEntry {
  return { clave, valor, actualizado_en };
}
function carrera(p: Partial<Carrera> & { id: number }): Carrera {
  return {
    nombre: `Carrera ${p.id}`, fecha: "2026-10-10", distancia_km: 21.1, desnivel_m: 200,
    prioridad: "B", estado: "candidata", resultado: null, notas: null,
    creado_en: "2026-08-11", actualizado_en: "2026-08-11", ...p,
  };
}
function snapshot(p: Partial<ContractSnapshot> = {}): ContractSnapshot {
  return {
    version: 135, ultimoCommit: HOY, hoy: HOY, columnasAusentes: [], reglas: [], bajasAutomaticas: [],
    pendientesVencidosHoy: [], estado: [], pendientes: [], disparadores: [],
    disparadoresVencidos: [], condiciones: [], carreras: [], ...p,
  };
}

/** Un contrato con la forma del de producción el 03/09/2026: todo sin resumen y largo. */
function contratoHinchado(): ContractSnapshot {
  return snapshot({
    reglas: Array.from({ length: 39 }, (_, i) => regla({ id: `R${String(i + 1).padStart(3, "0")}` })),
    pendientes: Array.from({ length: 28 }, (_, i) => pendiente({ id: i + 1 })),
    estado: Array.from({ length: 23 }, (_, i) => estado(`clave_${i}`, prosa(400, `e${i}`))),
    disparadores: Array.from({ length: 19 }, (_, i) => ({
      id: i + 1, fecha: "2026-10-01", accion: prosa(1100, `d${i}`), estado: "pendiente",
      creado_en: "2026-08-11", finalizado_en: null,
    })),
    carreras: Array.from({ length: 7 }, (_, i) => carrera({ id: i + 1, fecha: `2026-1${i % 2}-0${i + 1}`, notas: prosa(500) })),
  });
}

describe("vista compacta", () => {
  it("cabe en el presupuesto con el contrato hinchado y no pierde ninguna entrada", () => {
    const snap = contratoHinchado();
    const texto = renderContract(snap, { material: ["MATERIAL DISPONIBLE (33):", "Running: " + prosa(900)] });
    expect(texto.length).toBeLessThan(PRESUPUESTO_COMPACTO);
    for (const r of snap.reglas) expect(texto).toMatch(new RegExp(`^${r.id} tema \\| vence nunca \\| `, "m"));
    for (const p of snap.pendientes) expect(texto).toMatch(new RegExp(`^#${p.id} `, "m"));
    for (const d of snap.disparadores) expect(texto).toMatch(new RegExp(`^#${d.id} 2026-10-01 → `, "m"));
    for (const c of snap.carreras) expect(texto).toContain(`#${c.id} [B] · Carrera ${c.id}`);
    for (const e of snap.estado) expect(texto).toMatch(new RegExp(`^${e.clave}: `, "m"));
    expect(texto).toContain("SIN 'resumen': 39 reglas y 28 pendientes");
    expect(texto).toMatch(/…\[\+\d/);
    // El recorte se estrecha hasta caber, pero nunca por debajo del mínimo.
    const ancho = anchoCompacto(snap, []);
    expect(ancho).toBeGreaterThanOrEqual(ANCHO_MIN);
    expect(ancho).toBeLessThan(ANCHO_MAX);
  });

  it("termina siempre con la línea [TAMAÑO], que mide el contrato completo", () => {
    const snap = contratoHinchado();
    const texto = renderContract(snap);
    const ultima = texto.split("\n").pop()!;
    expect(ultima.startsWith("[TAMAÑO] ")).toBe(true);
    expect(ultima).toMatch(/reglas \d{2}\.\d{3}/);
    expect(ultima).toMatch(/total \d{2,3}\.\d{3} caracteres \(contrato completo\) · esta respuesta \d/);
    // 39 reglas × ~1.200 + 28 pendientes × ~900 + … supera los 60.000: avisa.
    expect(texto).toContain("⚠ TAMAÑO");
    for (const vista of [
      renderContract(snap, { detalle: "R001" }),
      renderContract(snap, { seccion: "reglas", detalle: true }),
      renderContract(snap, { seccion: "estado" }),
      renderContract(snap, { detalle: true }),
    ]) {
      expect(vista.split("\n").pop()!.startsWith("[TAMAÑO] ")).toBe(true);
    }
  });

  it("con todo corto no recorta nada ni avisa", () => {
    const snap = snapshot({
      reglas: [regla({ id: "R001", contenido: "Correr suave", resumen: "Correr suave" })],
      pendientes: [pendiente({ id: 13, texto: "Comprar bastones", resumen: null })],
      estado: [estado("nivel_tobillo", "1")],
    });
    const texto = renderContract(snap);
    expect(texto).not.toMatch(/…\[\+\d/);
    expect(texto).not.toContain("⚠ TAMAÑO");
    expect(texto).toContain("R001 tema | vence nunca | Correr suave");
    expect(texto).toContain("#13 Comprar bastones  (desde 2026-08-20)");
    expect(texto).toContain("SIN 'resumen': 1 pendiente;");
  });

  it("muestra el resumen entero y esconde el contenido; el detalle lo trae", () => {
    const snap = snapshot({
      reglas: [
        regla({ id: "R024", tema: "fc_reposo", resumen: "Corte de FC en reposo: 54 ppm. Por encima, sesión suave.", contenido: prosa(1400, "R024") }),
        regla({ id: "R025", contenido: prosa(1400, "R025") }),
      ],
    });
    const compacta = renderContract(snap);
    expect(compacta).toContain("R024 fc_reposo | vence nunca | Corte de FC en reposo: 54 ppm. Por encima, sesión suave.");
    expect(compacta).not.toContain("↳");
    expect(compacta).toContain("SIN 'resumen': 1 regla;");

    const detalle = renderContract(snap, { detalle: "R024" });
    expect(detalle).toContain("detalle de R024");
    expect(detalle).toContain("REGLA R024 fc_reposo | vence nunca | creada 2026-08-11 (v1)");
    expect(detalle).toContain(`contenido: ${snap.reglas[0]!.contenido}`);
    expect(detalle).not.toContain("R025");

    const seccion = renderContract(snap, { seccion: "reglas", detalle: true });
    expect(seccion).toContain("sección reglas completa");
    expect(seccion).toContain(`↳ ${snap.reglas[0]!.contenido}`);
    expect(seccion).toContain(`R025 tema | vence nunca | ${snap.reglas[1]!.contenido}`);
    expect(seccion).not.toContain("PENDIENTES");
  });

  it("resuelve ids numéricos en todas las secciones y claves de estado por nombre", () => {
    const snap = snapshot({
      pendientes: [pendiente({ id: 13, texto: "Comprar bastones plegables para el trail" })],
      disparadores: [{ id: 13, fecha: "2026-09-20", accion: "Reabrir el peso", estado: "pendiente", creado_en: HOY, finalizado_en: null }],
      estado: [estado("nivel_tobillo", "0 · 4 kg")],
      condiciones: [{ id: 13, texto: "Viaje a Bogotá, solo rodajes", desde: "2026-09-10", hasta: null, estado: "activa", creado_en: HOY, cerrado_en: null }],
    });
    const ambos = renderContract(snap, { detalle: "#13" });
    expect(ambos).toContain("CONDICIÓN #13 [2026-09-10 → sin fecha de fin] Viaje a Bogotá, solo rodajes");
    expect(ambos).toContain("PENDIENTE #13");
    expect(ambos).toContain("texto: Comprar bastones plegables para el trail");
    expect(ambos).toContain("DISPARADOR #13 · 2026-09-20");
    const solo = renderContract(snap, { seccion: "disparadores", detalle: 13 });
    expect(solo).toContain("DISPARADOR #13");
    expect(solo).not.toContain("PENDIENTE #13");
    expect(renderContract(snap, { detalle: "Nivel_Tobillo" })).toContain("ESTADO nivel_tobillo · actualizado 2026-09-01\n0 · 4 kg");
    expect(() => renderContract(snap, { detalle: "R999" })).toThrow(/No hay ninguna entrada activa con id "R999"/);
    expect(() => renderContract(snap, { seccion: "otra" as never })).toThrow(/Sección desconocida/);
  });

  it("marca ESTANCADO lo que lleva más de 60 días sin tocarse, con su fecha", () => {
    const snap = snapshot({
      pendientes: [
        pendiente({ id: 1, texto: "Viejo", creado_en: "2026-06-10" }),
        pendiente({ id: 2, texto: "Viejo pero tocado", creado_en: "2026-06-10", actualizado_en: "2026-08-30" }),
        pendiente({ id: 3, texto: "Reciente", creado_en: "2026-08-01" }),
      ],
      estado: [estado("vieja", "1", "2026-06-01"), estado("nueva", "2", "2026-08-15")],
    });
    const texto = renderContract(snap);
    // A 85 días le quedan 5 para caducar por inactividad, y eso se ve venir en
    // su propia línea: la caducidad no se lleva nada por sorpresa.
    expect(texto).toContain(
      "#1 Viejo  (desde 2026-06-10 · ESTANCADO: sin modificar desde 2026-06-10, 85 días · " +
        "⚠ CADUCA EN 5 DÍAS: tócalo, ciérralo o ponle 'vence')",
    );
    expect(texto).toContain("#2 Viejo pero tocado  (desde 2026-06-10 · tocado 2026-08-30)");
    expect(texto).toContain("#3 Reciente  (desde 2026-08-01)");
    expect(texto).toContain("vieja: 1  (actualizado 2026-06-01 · ESTANCADO 94 días)");
    expect(texto).toContain("nueva: 2  (actualizado 2026-08-15)");
  });

  it("señala carreras con la misma fecha y enseña el vencimiento de los pendientes", () => {
    const snap = snapshot({
      carreras: [
        carrera({ id: 5, nombre: "Media de Bogotá", fecha: "2026-10-25", estado: "confirmada" }),
        carrera({ id: 8, nombre: "Media Bogotá (sin decidir)", fecha: "2026-10-25" }),
        carrera({ id: 9, nombre: "10K", fecha: "2026-09-20" }),
      ],
      pendientes: [pendiente({ id: 4, texto: "Inscribirse", vence: "2026-09-30" })],
    });
    const texto = renderContract(snap);
    expect(texto).toContain("#5 [B] · Media de Bogotá · 2026-10-25 · 21.1km · +200m · confirmada · faltan 52 días · ⚠ misma fecha que #8 (¿ficha duplicada?)");
    expect(texto).toContain("#8 [B] · Media Bogotá (sin decidir) · 2026-10-25 · 21.1km · +200m · candidata · faltan 52 días · ⚠ misma fecha que #5");
    expect(texto).not.toContain("#9 [B] · 10K · 2026-09-20 · 21.1km · +200m · candidata · faltan 17 días · ⚠");
    expect(texto).toContain("#4 Inscribirse  (desde 2026-08-20 · vence 2026-09-30)");
  });

  it("los disparadores vencidos van enteros aunque la vista sea compacta", () => {
    const largo = prosa(1300, "urgente");
    const snap = snapshot({
      disparadoresVencidos: [{ id: 20, fecha: "2026-09-01", accion: largo, estado: "pendiente", creado_en: HOY, finalizado_en: null }],
      disparadores: [{ id: 21, fecha: "2026-12-01", accion: prosa(1300, "luego"), estado: "pendiente", creado_en: HOY, finalizado_en: null }],
    });
    const texto = renderContract(snap);
    expect(texto).toContain(`#20 2026-09-01 → ${largo}`);
    expect(texto).toMatch(/^#21 2026-12-01 → .*…\[\+\d/m);
  });

  it("anuncia las bajas automáticas de pendientes vencidos", () => {
    const snap = snapshot({
      pendientesVencidosHoy: [pendiente({ id: 7, texto: "Decidir la media", vence: "2026-09-02", estado: "vencido", resuelto_en: HOY })],
    });
    const texto = renderContract(snap);
    expect(texto).toContain("BAJAS AUTOMÁTICAS REGISTRADAS HOY (1):");
    expect(texto).toContain("pendiente #7 Decidir la media · vencía 2026-09-02 → cerrado como vencido");
  });
});

describe("recortar", () => {
  it("corta por palabra y dice cuánto falta", () => {
    const texto = "una frase con varias palabras que se corta por el espacio más cercano al ancho";
    const corto = recortar(texto, 30);
    expect(corto).toBe("una frase con varias palabras …[+49]");
    expect(recortar(texto, null)).toBe(texto);
    expect(recortar("corto", 30)).toBe("corto");
    expect(recortar("  con   espacios\n y saltos ", 300)).toBe("con espacios y saltos");
  });

  it("cuenta caracteres, no bytes ni unidades UTF-16", () => {
    const emoji = "😀".repeat(100);
    expect(recortar(emoji, 80)).toBe(`${"😀".repeat(80)} …[+20]`);
  });
});

describe("límites de longitud", () => {
  it("el error nombra el campo, la longitud, el límite y dónde va la narrativa", () => {
    const largo = prosa(3416);
    expect(() => comprobarLimite("estado.errores_entrenador", largo, LIMITES["estado.valor"])).toThrow(
      /'estado\.errores_entrenador' tiene 3\.416 caracteres y el límite es 300\. .*rechazado entero.*'mensaje'.*log/,
    );
    expect(() => comprobarLimite("estado.x", prosa(300), 300)).not.toThrow();
    expect(() => comprobarLimite("estado.x", prosa(301), 300)).toThrow(/301 caracteres/);
  });

  it("formatea miles a la española", () => {
    expect(formatoMiles(300)).toBe("300");
    expect(formatoMiles(3416)).toBe("3.416");
    expect(formatoMiles(185205)).toBe("185.205");
  });

  it("los límites son los del encargo", () => {
    expect(LIMITES).toEqual({
      "estado.valor": 300,
      "reglas.resumen": 300,
      "reglas.contenido": 1500,
      "pendientes.texto": 400,
      "pendientes.resumen": 400,
      "carreras.notas": 600,
      "disparadores.accion_texto": 1500,
    });
  });
});

describe("log", () => {
  const entrada = (p: Partial<LogEntry>): LogEntry => ({
    id: 165, fecha: "2026-09-03", version: 133, mensaje: "PODA 2/3 · REGLAS. " + prosa(2000),
    detalles: JSON.stringify({ reglas: [{ accion: "modificar", id: "R024", contenido: "x" }], estado: { a: "1", b: null }, pendientes: [] }),
    creado_en: "2026-09-03T10:00:00Z", ...p,
  });

  it("el índice es una línea corta por entrada", () => {
    const linea = lineaIndiceLog(entrada({}));
    expect(linea.startsWith("v133 · 2026-09-03 · PODA 2/3 · REGLAS. ")).toBe(true);
    expect(linea).toContain("…[+");
    expect(linea.endsWith("[reglas 1, estado 2]")).toBe(true);
    expect(linea.length).toBeLessThan(150);
    expect(lineaIndiceLog(entrada({ version: null, detalles: JSON.stringify({ tipo: "importado_de_intervals" }), mensaje: "R018 vieja" })))
      .toBe("hist. · 2026-09-03 · R018 vieja [histórico importado]");
    expect(lineaIndiceLog(entrada({ detalles: JSON.stringify({ tipo: "expiracion_automatica", reglas: ["R001"] }), mensaje: "Baja automática" })))
      .toBe("v133 · 2026-09-03 · Baja automática [baja automática]");
  });

  it("la entrada completa lleva el mensaje íntegro y los cambios uno a uno", () => {
    const e = entrada({});
    const lineas = lineasEntradaLog(e);
    expect(lineas[0]).toBe("v133 · 2026-09-03 · #165");
    expect(lineas[1]).toBe(`  ${e.mensaje}`);
    expect(lineas).toContain("  · reglas · modificar · id=R024 · contenido=x");
    expect(lineas).toContain("  · estado · a = 1");
    expect(lineas).toContain("  · estado · b = (borrada)");
    expect(lineasEntradaLog(entrada({ detalles: JSON.stringify({ tipo: "expiracion_automatica", reglas: ["R001"], pendientes: [13] }) })))
      .toContain("  cambios → baja automática: reglas R001 · pendientes #13");
  });

  it("desde/hasta distinguen fecha de versión", () => {
    expect(tipoFiltroLog("2026-08-01")).toEqual({ fecha: "2026-08-01" });
    expect(tipoFiltroLog(120)).toEqual({ version: 120 });
    expect(tipoFiltroLog("v120")).toEqual({ version: 120 });
    expect(tipoFiltroLog("")).toBe(null);
    expect(() => tipoFiltroLog("ayer")).toThrow(/YYYY-MM-DD o una versión/);
  });
});

/**
 * La salud del contrato: lo que la tabla de caracteres no cuenta.
 *
 * El 16/09/2026 el contrato real medía 112.788 caracteres con 157 entradas, y
 * el aviso de tamaño decía «poda». Comprimir textos no era la cura: el ancho de
 * la vista compacta se reparte entre las entradas, así que con suficientes
 * entradas una regla de 2.500 caracteres se ve en 70 y deja de gobernar. Lo
 * único que devuelve ancho es cerrar entradas.
 */
describe("salud del contrato", () => {
  const base = {
    version: 1,
    ultimoCommit: "2026-09-16",
    hoy: "2026-09-16",
    columnasAusentes: [],
    reglas: [],
    bajasAutomaticas: [],
    pendientesVencidosHoy: [],
    estado: [],
    pendientes: [],
    disparadores: [],
    disparadoresVencidos: [],
    condiciones: [],
    carreras: [],
  };

  const pendiente = (id: number, desde: string) => ({
    id,
    texto: `pendiente ${id}`,
    resumen: null,
    vence: null,
    estado: "abierto",
    creado_en: desde,
    actualizado_en: null,
    resuelto_en: null,
  });

  const disparador = (id: number, fecha: string) => ({
    id,
    fecha,
    accion: `accion ${id}`,
    estado: "abierto",
    creado_en: "2026-01-01",
    finalizado_en: null,
  });

  it("un contrato sano no dice nada", () => {
    expect(saludContrato({ ...base, pendientes: [pendiente(1, "2026-09-15")] }, 300)).toEqual([]);
  });

  it("avisa cuando los pendientes llevan meses parados", () => {
    const pendientes = Array.from({ length: 6 }, (_, i) => pendiente(i, "2026-05-01"));
    const salud = saludContrato({ ...base, pendientes }, 300);
    expect(salud.join("\n")).toContain("6 de 6 pendientes");
    expect(salud.join("\n")).toContain("'vence'");
  });

  it("no avisa por unos pocos parados", () => {
    // 68 días: ya ESTANCADO, pero lejos todavía de caducar.
    const pendientes = Array.from({ length: ESTANCADOS_AVISO - 1 }, (_, i) => pendiente(i, "2026-07-10"));
    expect(saludContrato({ ...base, pendientes }, 300)).toEqual([]);
  });

  it("avisa de los que están a punto de caducar, para poder rescatarlos", () => {
    const pendientes = [pendiente(1, "2026-06-25"), pendiente(2, "2026-09-10")];
    const salud = saludContrato({ ...base, pendientes }, 300).join("\n");
    expect(salud).toContain("1 pendiente caduca en menos de 14 días");
    expect(salud).toContain("rescata los que sigan importando");
  });

  it("llama cola a una cola de disparadores en la misma fecha", () => {
    // El caso real: doce disparadores para el 2026-09-20, once empezando por
    // «AL ESCRIBIR LA SEMANA DEL 21/09».
    const disparadores = [
      ...Array.from({ length: 12 }, (_, i) => disparador(i, "2026-09-20")),
      disparador(99, "2026-10-01"),
    ];
    const salud = saludContrato({ ...base, disparadores }, 300).join("\n");
    expect(salud).toContain("12 disparadores caen el 2026-09-20");
    expect(salud).toContain("fúndelos");
  });

  it("dos disparadores el mismo día no son una cola", () => {
    const disparadores = [disparador(1, "2026-09-20"), disparador(2, "2026-09-20")];
    expect(saludContrato({ ...base, disparadores }, 300)).toEqual([]);
  });

  it("avisa cuando el recorte toca suelo, y dice qué NO lo arregla", () => {
    const salud = saludContrato(base, 60).join("\n");
    expect(salud).toContain("cerca del mínimo");
    expect(salud).toContain("Comprimir textos NO devuelve ancho");
  });

  it("cuenta todas las entradas, no solo las de una sección", () => {
    const salud = saludContrato(
      {
        ...base,
        reglas: [{ id: "R1", tema: "t", contenido: "c", resumen: null, vence: "nunca", creado_en: "2026-01-01", actualizado_en: null, estado: "activa" }] as never,
        pendientes: [pendiente(1, "2026-01-01"), pendiente(2, "2026-01-01"), pendiente(3, "2026-01-01"), pendiente(4, "2026-01-01"), pendiente(5, "2026-01-01")],
      },
      60,
    ).join("\n");
    expect(salud).toContain("6 entradas");
  });
});
