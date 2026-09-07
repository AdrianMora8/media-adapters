# seanime-es-providers

Providers de streaming en español para [Seanime](https://github.com/5rahim/seanime).

## Estado

| Provider | Tipo | search | findEpisodes | findEpisodeServer |
|---|---|---|---|---|
| AnimeAV1 | `onlinestream-provider` | ✅ | ✅ | ✅ (HLS, MP4Upload) |
| AnimeFLV | — | ⬜ | ⬜ | ⬜ |
| JKAnime | — | ⬜ | ⬜ | ⬜ |

AnimeAV1 está verificado de punta a punta contra el sitio real (`npm run smoke:av1`),
no sólo tipado.

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
npm run typecheck   # tsc --noEmit, es lo que más valor da
npm run build:av1   # esbuild -> dist/animeav1/index.js
npm run smoke:av1   # compila y ejecuta search/findEpisodes/findEpisodeServer contra el sitio real
```

`--format=esm` es deliberado: `iife` metería `class Provider` dentro de una
función y Seanime no la encontraría. `--tree-shaking=false` también lo es:
como nada exporta ni referencia `Provider` desde fuera del fichero, esbuild
la considera código muerto y la elimina por completo si el tree-shaking
está activo (pasó en el primer build: el bundle quedó en 322 bytes, sin la
clase). Por el mismo motivo de legibilidad el build minifica sintaxis y
espacios pero **no identificadores**.

`_smoke.mjs` no es parte del provider: es un arnés que simula lo mínimo que
goja inyecta (`fetch` con `.text()`/`.json()` síncronos, `$store` en memoria)
para poder ejecutar el bundle con Node y confirmar contra animeav1.com real
que cada método devuelve lo esperado, incluyendo que el m3u8 resultante
carga con las cabeceras declaradas.
