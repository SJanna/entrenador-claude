/** Pantalla de login: contraseña única → cookie de sesión firmada. */

import { COLORES, CSS_BASE } from "./estilo";

export function loginPage(failed: boolean): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="${COLORES.arena}">
<link rel="icon" href="/icono.svg?v=2" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<title>Entrar · zancada</title>
<style>
${CSS_BASE}
body { display: flex; flex-direction: column; }
main {
  flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 26px;
  width: 100%; max-width: 420px; margin: 0 auto; padding: 32px 24px;
}
.logo { font-family: Bungee, sans-serif; font-size: 40px; line-height: 1; color: var(--mar); }
form.tarjeta { padding: 16px; gap: 10px; }
label.etq { color: var(--tinta); }
.error {
  border: 2px solid var(--tinta); border-radius: 8px; background: var(--coral);
  color: var(--crema); padding: 8px 10px; font-size: 14px;
}
.tecla.primaria { min-height: 50px; font-size: 16px; }
</style>
</head>
<body>
<div class="pintas" aria-hidden="true"></div>
<main>
  <div>
    <h1 class="logo">ZANCADA</h1>
    <p class="etq" style="margin-top:8px">Tu entrenador · tus datos · tus acuerdos</p>
  </div>
  <form class="tarjeta" method="post" action="/login">
    <label class="etq" for="clave">Contraseña</label>
    <input class="campo" id="clave" type="password" name="password" autofocus
           autocomplete="current-password" required>
    ${failed ? '<div class="error" role="alert">Contraseña incorrecta.</div>' : ""}
    <button class="tecla primaria" type="submit">ENTRAR</button>
  </form>
</main>
</body>
</html>`;
}
