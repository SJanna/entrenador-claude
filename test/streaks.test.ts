import { describe, expect, it } from "vitest";
import {
  agregarDias,
  calcularRachas,
  densificar,
  esDescansoExplicito,
  lunesDe,
  rachasDeDias,
  type ActividadRacha,
  type BienestarRacha,
  type EventoRacha,
} from "../src/streaks/compute";
import { formatRachas } from "../src/streaks/format";

function act(fecha: string, minutos: number, extra: Partial<ActividadRacha> = {}): ActividadRacha {
  return { fecha, deporte: "Run", segundos: minutos * 60, carga: 30, ...extra };
}
function ev(fecha: string, categoria: string, extra: Partial<EventoRacha> = {}): EventoRacha {
  return { fecha, categoria, nombre: "", ...extra };
}
function dia(resultado: ReturnType<typeof calcularRachas>, fecha: string) {
  const encontrado = resultado.dias.find((d) => d.fecha === fecha);
  if (!encontrado) throw new Error(`falta el día ${fecha} en la rejilla`);
  return encontrado;
}

describe("rachas · movimiento", () => {
  it("cuenta días seguidos y hoy sin entrenar no rompe la racha", () => {
    const r = calcularRachas({
      hoy: "2026-03-10",
      desde: "2026-03-01",
      actividades: [act("2026-03-08", 30), act("2026-03-09", 20)],
    });
    expect(r.movimiento.actual).toBe(2);
    expect(r.movimiento.desde).toBe("2026-03-08");
    expect(r.movimiento.pendiente).toBe(true);
    expect(dia(r, "2026-03-10").estado).toBe("pendiente");
  });

  it("hoy con actividad suma y deja de estar pendiente", () => {
    const r = calcularRachas({
      hoy: "2026-03-10",
      desde: "2026-03-01",
      actividades: [act("2026-03-08", 30), act("2026-03-09", 20), act("2026-03-10", 16)],
    });
    expect(r.movimiento.actual).toBe(3);
    expect(r.movimiento.pendiente).toBe(false);
  });

  it("respeta el umbral de 15 min y no suma dos actividades cortas del mismo día", () => {
    const r = calcularRachas({
      hoy: "2026-03-10",
      desde: "2026-03-01",
      actividades: [act("2026-03-09", 10), act("2026-03-09", 10)],
    });
    expect(dia(r, "2026-03-09").sesiones).toBe(2);
    expect(dia(r, "2026-03-09").segundos).toBe(1200);
    expect(dia(r, "2026-03-09").activo).toBe(false);
    expect(r.movimiento.mejor).toBe(0);
  });

  it("varias actividades el mismo día son un solo día de racha", () => {
    const r = calcularRachas({
      hoy: "2026-03-10",
      desde: "2026-03-01",
      actividades: [act("2026-03-09", 30), act("2026-03-09", 40, { deporte: "WeightTraining" })],
    });
    expect(dia(r, "2026-03-09").deportes).toEqual(["Run", "WeightTraining"]);
    expect(r.movimiento.mejor).toBe(1);
  });

  it("marca la racha como truncada cuando llega al borde de la ventana", () => {
    const r = calcularRachas({
      hoy: "2026-03-03",
      desde: "2026-03-01",
      actividades: [act("2026-03-01", 30), act("2026-03-02", 30), act("2026-03-03", 30)],
    });
    expect(r.movimiento.actual).toBe(3);
    expect(r.movimiento.truncada).toBe(true);
  });

  it("ignora actividades fuera de la ventana", () => {
    const r = calcularRachas({
      hoy: "2026-03-03",
      desde: "2026-03-02",
      actividades: [act("2026-02-27", 30), act("2026-03-02", 30)],
    });
    expect(r.dias).toHaveLength(2);
    expect(r.movimiento.mejor).toBe(1);
  });
});

describe("rachas · cumplimiento", () => {
  it("el descanso explícito cuenta como cumplido y el día vacío rompe", () => {
    const r = calcularRachas({
      hoy: "2026-03-05",
      desde: "2026-03-01",
      actividades: [act("2026-03-01", 40), act("2026-03-03", 30)],
      eventos: [
        ev("2026-03-01", "WORKOUT", { segundos: 2400 }),
        ev("2026-03-02", "NOTE", { nombre: "Descanso total" }),
      ],
    });
    expect(dia(r, "2026-03-02").estado).toBe("descanso");
    expect(dia(r, "2026-03-03").cumple).toBe(true); // extra no programado
    expect(dia(r, "2026-03-04").estado).toBe("fallado"); // ni plan ni actividad
    expect(r.cumplimiento.mejor).toBe(3);
    expect(r.cumplimiento.actual).toBe(0);
    expect(r.cumplimiento.pendiente).toBe(true);
  });

  it("HOLIDAY, SICK e INJURED no rompen la racha", () => {
    const r = calcularRachas({
      hoy: "2026-03-04",
      desde: "2026-03-01",
      actividades: [act("2026-03-01", 40)],
      eventos: [
        ev("2026-03-02", "HOLIDAY", { nombre: "Viaje" }),
        ev("2026-03-03", "SICK", { nombre: "Gripe" }),
      ],
    });
    expect(r.cumplimiento.actual).toBe(3);
  });

  it("una nota de 'descanso activo' es sesión, no descanso", () => {
    const r = calcularRachas({
      hoy: "2026-03-04",
      desde: "2026-03-01",
      actividades: [act("2026-03-01", 40)],
      eventos: [ev("2026-03-02", "NOTE", { nombre: "Descanso activo: 30 min caminando" })],
    });
    expect(dia(r, "2026-03-02").descansoExplicito).toBe(false);
    expect(dia(r, "2026-03-02").estado).toBe("fallado");
  });

  it("un WORKOUT llamado 'descanso' sigue siendo sesión programada", () => {
    expect(esDescansoExplicito({ fecha: "2026-03-02", categoria: "WORKOUT", nombre: "Descanso" })).toBe(false);
    expect(esDescansoExplicito({ fecha: "2026-03-02", categoria: "NOTE", nombre: "Día libre" })).toBe(true);
  });

  it("da por hecha la sesión programada al 60 % aunque no llegue al umbral", () => {
    const r = calcularRachas({
      hoy: "2026-03-03",
      desde: "2026-03-01",
      // Caminata programada de 20 min, hecha en 13: no llega a los 15 min de
      // la racha de movimiento, pero cumple lo programado.
      actividades: [act("2026-03-02", 13, { deporte: "Walk", carga: 4 })],
      eventos: [ev("2026-03-02", "WORKOUT", { segundos: 1200 })],
    });
    expect(dia(r, "2026-03-02").activo).toBe(false);
    expect(dia(r, "2026-03-02").cumple).toBe(true);
    expect(dia(r, "2026-03-02").estado).toBe("descanso");
  });

  it("saltarse la sesión programada rompe el cumplimiento", () => {
    const r = calcularRachas({
      hoy: "2026-03-03",
      desde: "2026-03-01",
      actividades: [act("2026-03-02", 5, { carga: 1 })],
      eventos: [ev("2026-03-02", "WORKOUT", { segundos: 2400 })],
    });
    expect(dia(r, "2026-03-02").estado).toBe("fallado");
  });
});

describe("rachas · semanas", () => {
  it("cuenta semanas de lunes a domingo y la semana en curso no rompe", () => {
    const actividades = [
      // Semana del 27-jul: 3 días activos.
      act("2026-07-27", 30), act("2026-07-29", 30), act("2026-07-31", 30),
      // Semana del 3-ago: 3 días activos.
      act("2026-08-03", 30), act("2026-08-05", 30), act("2026-08-07", 30),
      // Semana en curso (10-ago): solo 1 día, aún incompleta.
      act("2026-08-10", 30),
    ];
    const r = calcularRachas({ hoy: "2026-08-11", desde: "2026-07-27", actividades });
    expect(r.semanas.map((s) => s.lunes)).toEqual(["2026-07-27", "2026-08-03", "2026-08-10"]);
    expect(r.semanas[2]!.enCurso).toBe(true);
    expect(r.semanal.actual).toBe(2);
    expect(r.semanal.pendiente).toBe(true);
  });

  it("descarta la primera semana si la ventana la corta por la mitad", () => {
    const r = calcularRachas({
      hoy: "2026-08-11",
      desde: "2026-07-29", // miércoles
      actividades: [act("2026-08-03", 30), act("2026-08-05", 30), act("2026-08-07", 30)],
    });
    expect(r.semanas.map((s) => s.lunes)).toEqual(["2026-08-03", "2026-08-10"]);
  });

  it("lunesDe cruza el cambio de mes", () => {
    expect(lunesDe("2026-03-01")).toBe("2026-02-23"); // domingo
    expect(lunesDe("2026-08-10")).toBe("2026-08-10"); // ya es lunes
  });
});

describe("rachas · sueño y avisos", () => {
  it("cuenta noches seguidas por encima del umbral", () => {
    const bienestar: BienestarRacha[] = [
      { fecha: "2026-03-01", sueno_secs: 6 * 3600 },
      { fecha: "2026-03-02", sueno_secs: 7.5 * 3600 },
      { fecha: "2026-03-03", sueno_secs: 7.2 * 3600 },
      { fecha: "2026-03-04", sueno_secs: 8 * 3600 },
    ];
    const r = calcularRachas({ hoy: "2026-03-04", desde: "2026-03-01", actividades: [], bienestar });
    expect(r.sueno.actual).toBe(3);
    expect(r.sueno.mejor).toBe(3);
  });

  it("una noche sin datos rompe la racha de sueño, pero la de hoy solo la deja pendiente", () => {
    const bienestar: BienestarRacha[] = [
      { fecha: "2026-03-01", sueno_secs: 8 * 3600 },
      { fecha: "2026-03-02", sueno_secs: null },
      { fecha: "2026-03-03", sueno_secs: 7.5 * 3600 },
      { fecha: "2026-03-04", sueno_secs: null },
    ];
    const r = calcularRachas({ hoy: "2026-03-04", desde: "2026-03-01", actividades: [], bienestar });
    expect(r.sueno.actual).toBe(1);
    expect(r.sueno.pendiente).toBe(true);
  });

  it("avisa cuando encadenas días apretando sin uno suave", () => {
    const actividades = Array.from({ length: 11 }, (_, i) =>
      act(`2026-03-${String(i + 1).padStart(2, "0")}`, 60, { carga: 60 }),
    );
    const r = calcularRachas({ hoy: "2026-03-11", desde: "2026-03-01", actividades });
    expect(r.aviso).not.toBeNull();
    expect(r.aviso!.dias).toBe(11);
    expect(r.movimiento.actual).toBe(11);
  });

  it("el aviso salta por la mañana, antes de entrenar", () => {
    // Diez días duros cerrados y hoy todavía sin actividad: es exactamente
    // cuando el aviso sirve para algo.
    const actividades = Array.from({ length: 10 }, (_, i) =>
      act(`2026-03-${String(i + 1).padStart(2, "0")}`, 60, { carga: 60 }),
    );
    const r = calcularRachas({ hoy: "2026-03-11", desde: "2026-03-01", actividades });
    expect(r.aviso).not.toBeNull();
    expect(r.aviso!.dias).toBe(10);
    expect(dia(r, "2026-03-11").estado).toBe("pendiente");
  });

  it("un día suave corta el aviso aunque la racha siga viva", () => {
    const actividades = Array.from({ length: 11 }, (_, i) =>
      act(`2026-03-${String(i + 1).padStart(2, "0")}`, 60, { carga: i === 5 ? 10 : 60 }),
    );
    const r = calcularRachas({ hoy: "2026-03-11", desde: "2026-03-01", actividades });
    expect(r.aviso).toBeNull();
    expect(r.movimiento.actual).toBe(11);
  });
});

describe("rachas · agregar y clasificar por separado", () => {
  it("agregarDias no aplica umbrales y densifica el rango", () => {
    const dias = agregarDias({
      hoy: "2026-03-04",
      desde: "2026-03-01",
      actividades: [act("2026-03-02", 10), act("2026-03-02", 30, { deporte: "Ride" })],
      eventos: [ev("2026-03-03", "WORKOUT", { segundos: 1800 })],
      bienestar: [{ fecha: "2026-03-02", sueno_secs: 7 * 3600 }],
    });
    expect(dias).toHaveLength(4);
    expect(dias.map((d) => d.fecha)).toEqual([
      "2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04",
    ]);
    const segundo = dias[1]!;
    expect(segundo.sesiones).toBe(2);
    expect(segundo.segundosMax).toBe(1800);
    expect(segundo.deportes).toEqual(["Run", "Ride"]);
    expect(segundo.suenoSecs).toBe(25200);
    expect(dias[2]!.segundosProgramados).toBe(1800);
    // Sin juicio: el agregado no tiene ni 'activo' ni 'estado'.
    expect("activo" in segundo).toBe(false);
  });

  it("el mismo agregado da rachas distintas si cambia el umbral", () => {
    const entrada = {
      hoy: "2026-03-03",
      desde: "2026-03-01",
      actividades: [act("2026-03-01", 12), act("2026-03-02", 12)],
    };
    const dias = agregarDias(entrada);
    expect(rachasDeDias(dias, { hoy: "2026-03-03" }).movimiento.mejor).toBe(0);
    expect(
      rachasDeDias(dias, { hoy: "2026-03-03", umbrales: { minSegundos: 600 } }).movimiento.mejor,
    ).toBe(2);
  });

  it("densificar rellena los huecos que D1 no tenga", () => {
    const guardados = agregarDias({
      hoy: "2026-03-05",
      desde: "2026-03-05",
      actividades: [act("2026-03-05", 40)],
    });
    const completos = densificar("2026-03-01", "2026-03-05", guardados);
    expect(completos).toHaveLength(5);
    expect(completos[0]!.sesiones).toBe(0);
    expect(completos[4]!.sesiones).toBe(1);
  });
});

describe("rachas · texto para el MCP", () => {
  // Ventana de dos semanas justas: lunes 27-jul → domingo 9-ago, hoy lunes 10.
  function texto() {
    const r = calcularRachas({
      hoy: "2026-08-10",
      desde: "2026-07-27",
      actividades: [
        act("2026-08-05", 40), act("2026-08-06", 40), act("2026-08-07", 40),
        act("2026-08-08", 40), act("2026-08-09", 40),
      ],
      eventos: [ev("2026-08-04", "NOTE", { nombre: "Descanso" })],
      bienestar: [{ fecha: "2026-08-09", sueno_secs: 8 * 3600 }],
    });
    return formatRachas(r);
  }

  it("cabecera, tabla y advertencia", () => {
    const salida = texto();
    expect(salida).toContain("Rachas · 2026-07-27 → 2026-08-10");
    expect(salida).toMatch(/movimiento\s+5\s+5\s+2026-08-05/);
    expect(salida).toContain("nunca uses la racha");
  });

  it("dibuja el calendario por semanas de lunes a domingo", () => {
    const salida = texto();
    // Semana del 3-ago: descanso el martes, activo de miércoles a domingo.
    expect(salida).toContain("2026-08-03  .o#####");
    // La semana en curso solo tiene el lunes, y hoy sigue abierto.
    expect(salida).toContain("2026-08-10  ?");
    expect(salida).toContain("Hoy (2026-08-10) sigue abierto en:");
  });

  it("marca con ≥ la racha que llega al borde de la ventana", () => {
    const r = calcularRachas({
      hoy: "2026-08-10",
      desde: "2026-08-08",
      actividades: [act("2026-08-08", 30), act("2026-08-09", 30), act("2026-08-10", 30)],
    });
    expect(formatRachas(r)).toMatch(/movimiento\s+≥3/);
  });
});

describe("rachas · casos límite", () => {
  it("sin datos devuelve ceros sin romperse", () => {
    const r = calcularRachas({ hoy: "2026-03-05", desde: "2026-03-01", actividades: [] });
    expect(r.movimiento.actual).toBe(0);
    expect(r.movimiento.mejor).toBe(0);
    expect(r.semanal.actual).toBe(0);
    expect(r.dias).toHaveLength(5);
  });

  it("tolera una ventana invertida quedándose solo con hoy", () => {
    const r = calcularRachas({ hoy: "2026-03-01", desde: "2026-03-10", actividades: [] });
    expect(r.dias).toHaveLength(1);
    expect(r.desde).toBe("2026-03-01");
  });
});
