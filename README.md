# seanime-es-providers

Providers de streaming en español para [Seanime](https://github.com/5rahim/seanime).

## Estado

| Provider | Tipo | search | findEpisodes | findEpisodeServer |
|---|---|---|---|---|
| AnimeAV1 | `onlinestream-provider` | ✅ | ✅ | ✅ (HLS, MP4Upload) |
| JKAnime | `onlinestream-provider` | ✅ | ✅ | ✅ (Desu, Magi) |
| TioAnime | `onlinestream-provider` | ✅ (sub + latino) | ✅ | ✅ (YourUpload) |
| AnimeFLV | — | ⬜ | ⬜ | ⬜ |

AnimeFLV (animeflv.net) está caído (Cloudflare 521) al momento de escribir esto;
se retoma cuando vuelva. Los "mirrors" encontrados (animeflv.ws, animeflv.one)
no son el sitio real — dos son parking pages, el otro tiene una plantilla
distinta — así que no se construyó nada sobre ellos. TioAnime usa el mismo
template clásico que AnimeFLV, así que cubre buena parte de ese hueco mientras
tanto.

Los tres providers activos están verificados de punta a punta contra el sitio
real (`npm run smoke:av1`, `npm run smoke:jkanime`, `npm run smoke:tioanime`),
no sólo tipados — incluyendo, cuando aplica, que el vídeo final carga con
exactamente los `headers` que declaramos (así se detectó que YourUpload
necesita `Referer: https://www.yourupload.com/` o responde 500).

Servidores no soportados a propósito, por requerir enlaces firmados por el
backend del propio host (no de la web origen): **Okru** en JKAnime, **Mega**
en AnimeAV1, y en TioAnime todo menos YourUpload (Mega, Okru, Netu, StreamSB,
Amus, Mepu sin investigar; Voe y MixDrop están ofuscados/caídos al probarlos).

## Cargar en Seanime sin compilar

Seanime transpila TypeScript él mismo cuando el manifiesto declara
`"language": "typescript"`. **No hace falta bundler.**

1. Seanime → *Extensions* → *Add extension* → *Local / Development*.
2. Apunta al `manifest.json` del provider (o pega su contenido).
3. Rellena `payload` con el contenido de `index.ts`, **o** usa `payloadURI`
   con una URL cruda al `.ts`.
4. Recarga la extensión tras cada cambio; el *Playground* de Seanime
   (Extensions → Playground) permite invocar `search` / `findEpisodes` /
   `findEpisodeServer` sin salir de la app.

Restricciones del runtime (goja, no Node ni navegador):

- Un solo fichero. **Nada de `import` / `require` / `export`.**
- La clase debe llamarse `Provider` y estar en el ámbito superior.
- `res.text()` y `res.json()` son **síncronos**, no devuelven Promise.
- No hay `setTimeout`, `AbortController`, `DOMParser` ni `document` del navegador.
  Para HTML usa `LoadDoc(html)` (goquery con API tipo cheerio).

## Compilación opcional

Sólo si quieres publicar un `.js` en vez del `.ts`. Requiere Node ≥ 18.

```bash
npm install
npm run typecheck      # tsc --noEmit, es lo que más valor da
npm run build          # compila todos los providers a dist/
npm run smoke:av1      # compila y ejecuta search/findEpisodes/findEpisodeServer de AnimeAV1 contra el sitio real
npm run smoke:jkanime  # ídem para JKAnime
npm run smoke:tioanime # ídem para TioAnime
```

`--format=esm` es deliberado: `iife` metería `class Provider` dentro de una
función y Seanime no la encontraría. `--tree-shaking=false` también lo es:
como nada exporta ni referencia `Provider` desde fuera del fichero, esbuild
la considera código muerto y la elimina por completo si el tree-shaking
está activo (pasó en el primer build: el bundle quedó en 322 bytes, sin la
clase). Por el mismo motivo de legibilidad el build minifica sintaxis y
espacios pero **no identificadores**.

`_smoke.mjs` / `_smoke-jkanime.mjs` / `_smoke-tioanime.mjs` no son parte de los providers: son arneses
que simulan lo mínimo que goja inyecta (`fetch` con `.text()`/`.json()`
síncronos, `$store` en memoria, `res.cookies` reconstruido desde
`Set-Cookie`) para poder ejecutar el bundle con Node y confirmar contra el
sitio real que cada método devuelve lo esperado, incluyendo que el m3u8
resultante carga.

**Los `index.ts` NO deben llevar `export`/`import`.** Seanime no bundlea:
transpila cada extensión con `esbuild.Transform` de un solo fichero (ver
`internal/extension_repo/goja.go`, `JSVMTypescriptToJS`), que sólo quita los
tipos — no resuelve módulos ni hace tree-shaking. Un `export {}` sobrevive tal
cual al JS final y goja lo rechaza como palabra reservada
(`invalid_payload: Unexpected reserved word`). Esto pasó una vez en este
repo: se añadió para que `tsc` no chocara los `class Provider` de dos
providers en un mismo *scope* global, y rompió AnimeAV1 en producción hasta
el siguiente fix.

Por eso el *typecheck* aísla cada provider con su propio `tsconfig.<nombre>.json`
(uno por provider, todos heredando de `tsconfig.base.json`) en vez de tocar
el código fuente. `npm run typecheck` corre los tres por separado; el
`tsconfig.json` de la raíz sólo es para que el
editor resuelva tipos al abrir cualquier fichero y puede mostrar falsos
"duplicate identifier" si tienes providers distintos abiertos a la vez — no
es real, `npm run typecheck` es la fuente de verdad.

Antes de subir cambios, `npm run verify-payload` (incluido en `npm run build`)
reproduce la llamada exacta que hace Seanime a esbuild (mismo `Target`,
`Loader: ts`, sin bundle) y falla si el resultado lleva `export`/`import` o no
contiene un `class Provider` de nivel superior.
