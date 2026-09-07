// Replica exactamente la transformación que aplica Seanime a cada extensión
// TypeScript: internal/extension_repo/goja.go, JSVMTypescriptToJS() llama a
// esbuild's Transform API (un solo fichero, SIN bundle) con:
//   Target: ES2018, Loader: LoaderTS, Format: FormatDefault
//
// Seanime NO bundlea ni hace tree-shaking. Si el .ts fuente lleva
// `export`/`import`, sobrevive tal cual al JS final y goja lo rechaza como
// palabra reservada ("invalid_payload: Unexpected reserved word"). Pasó una
// vez con un `export {}` añadido sólo para tsc; de ahí este script.

import { transform } from "esbuild"
import { readFileSync } from "node:fs"

const targets = ["src/animeav1/index.ts", "src/jkanime/index.ts"]

let failed = false

for (const file of targets) {
    const source = readFileSync(file, "utf8")

    let result
    try {
        result = await transform(source, {
            target: "es2018",
            loader: "ts",
            minifyWhitespace: true,
            minifySyntax: true,
        })
    } catch (err) {
        console.error(`✗ ${file}: esbuild rechazó el fichero`)
        console.error(err.message)
        failed = true
        continue
    }

    const code = result.code

    if (/^\s*(export|import)\b/m.test(code)) {
        console.error(`✗ ${file}: el JS transformado conserva export/import — goja lo rechazará`)
        failed = true
        continue
    }

    if (!/\bclass\s+Provider\b/.test(code)) {
        console.error(`✗ ${file}: no se encontró "class Provider" de nivel superior en el JS transformado`)
        failed = true
        continue
    }

    console.log(`✓ ${file}: transforma limpio (${code.length} bytes), "class Provider" presente, sin export/import`)
}

if (failed) process.exit(1)
