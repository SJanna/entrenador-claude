## Qué cambia y por qué

<!-- El problema que resuelve y cómo. Si viene de un fallo real, cuéntalo. -->

## Cómo se ha probado

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run e2e`
- [ ] Tests nuevos para lo nuevo (o un test que fallaba antes, si es un error)

## Base de datos

- [ ] No trae migración
- [ ] Trae migración nueva (`migrations/00XX_…`): solo añade, y se aplica **antes** de desplegar

## Privacidad

- [ ] No hay datos personales (salud, nombres, lugares, ids de cuentas) en código, tests, fixtures, capturas ni commits
- [ ] No hay secretos ni configuración propia (`wrangler.jsonc`, `.dev.vars`)
