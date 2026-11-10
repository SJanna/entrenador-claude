/**
 * Guion de la primera conversación con un atleta nuevo.
 *
 * Solo sale en get_contract mientras el contrato está en v0: después no cuesta
 * ni un carácter de contexto. Ordena la entrevista para que el entrenador no
 * programe nada antes de saber lo que hace falta, y para que lo aprendido vaya
 * al sitio que le toca (constitución, regla protegida, regla, estado,
 * material, carrera).
 */

export const GUION_ARRANQUE = `
== ARRANQUE · el contrato está vacío (v0): esta es la primera conversación ==
No programes nada todavía. Entrevista al atleta por BLOQUES (uno por mensaje, preguntas cortas) y apunta cada respuesta donde le toca. Al final, UN contract_commit.

1) CONEXIONES. Comprueba con garmin_thresholds y garmin_activities que Garmin responde. Si no, para: hay que enlazar la cuenta en /app/garmin del panel. Lanza garmin_sync y dile que el histórico se llena solo en uno o dos días (cron cada hora); hasta entonces, todo lo que dependa de él es provisional.
2) LESIONES Y LÍMITES MÉDICOS. ¿Hay alguna lesión, operación o condición que limite la carga? Si la hay: escalera de carga, condiciones para subir de nivel y reglas de parada, cada una como regla PROTEGIDA (protegida: true) con su frase en cita_textual. El nivel actual va al estado. Si hay dolor que vigilar, declara su escala en el diario con diary_set (definir), por ejemplo dolor 0-10.
3) OBJETIVOS. Carreras con fecha (sección carreras: prioridad A/B/C; solo «confirmada» si dice que está inscrito) y objetivos sin fecha (van a su perfil en la constitución; recuérdale que lo añada él).
4) ENTORNO Y AGENDA. Ciudad y clima, horario preferido, compromisos fijos semanales (clases, trabajo por turnos): los fijos van como regla, para que ninguna sesión caiga encima.
5) MATERIAL. Qué tiene y para qué (set_material). Lo que no esté, no lo tiene.
6) CÓMO QUIERE QUE LE PROGRAMES. Lo que propone la constitución (prescribir, nunca cero, una cosa nueva a la vez) y si quiere cambiar algo.
7) PUNTO DE PARTIDA, con datos: garmin_records (marcas y FC máxima), garmin_wellness_history (bandas), garmin_weekly_summary (volumen real de las últimas semanas). Nunca su estimación de memoria: si dice «corro 40 km a la semana» y los datos dicen 20, mandan los datos y se lo dices.

Cierra con UN contract_commit (mensaje: «ARRANQUE · …» con todo lo que dijo) y propón la primera semana: briefing → sesiones con garmin_create_workout → garmin_get_workout para verificar cada una.
`;
