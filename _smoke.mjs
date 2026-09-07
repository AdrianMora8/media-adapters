// Arnés de prueba manual, NO forma parte del provider.
// Simula lo mínimo que el runtime de Seanime (goja) inyecta como globals:
// fetch síncrono en .text()/.json(), y un $store en memoria.
// Node tiene fetch nativo pero Response.text()/.json() son async, así que
// se envuelve para exponer la firma síncrona que espera el código del provider.

globalThis.$store = (() => {
    const map = new Map()
    return {
        get: (k) => map.get(k),
        set: (k, v) => map.set(k, v),
        has: (k) => map.has(k),
        remove: (k) => map.delete(k),
    }
})()

const realFetch = globalThis.fetch

globalThis.fetch = async (url, options = {}) => {
    const res = await realFetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        redirect: options.redirect,
    })
    const bodyText = await res.text()
    return {
        status: res.status,
        statusText: res.statusText,
        ok: res.ok,
        url: res.url,
        headers: Object.fromEntries(res.headers.entries()),
        text: () => bodyText,
        json: () => JSON.parse(bodyText),
    }
}

// El bundle no exporta nada (Seanime lee `Provider` como variable de ámbito
// superior tras evaluar el fichero, no como export de módulo). Se replica eso
// con `new Function` para no tener que forkear el build sólo para probarlo.
import { readFileSync } from "node:fs"
const code = readFileSync("./dist/animeav1/index.js", "utf8")
const Provider = new Function(`${code}\nreturn Provider;`)()
const provider = new Provider()

console.log("== getSettings ==")
console.log(provider.getSettings())

console.log("\n== search (sub) ==")
const searchOpts = {
    media: {
        id: 154587,
        romajiTitle: "Sousou no Frieren",
        englishTitle: "Frieren: Beyond Journey's End",
        synonyms: [],
        isAdult: false,
        format: "TV",
    },
    query: "Frieren",
    dub: false,
}
const results = await provider.search(searchOpts)
console.log(`resultados: ${results.length}`)
console.log(results.slice(0, 3))

if (results.length === 0) {
    console.error("FALLO: search no devolvió resultados")
    process.exit(1)
}

const target = results.find(r => r.title.toLowerCase().includes("frieren")) || results[0]
console.log(`\n== findEpisodes(${target.id}) ==`)
const episodes = await provider.findEpisodes(target.id)
console.log(`episodios: ${episodes.length}`)
console.log(episodes.slice(0, 3))

if (episodes.length === 0) {
    console.error("FALLO: findEpisodes no devolvió episodios")
    process.exit(1)
}

for (const server of provider.getSettings().episodeServers) {
    console.log(`\n== findEpisodeServer(ep1, "${server}") ==`)
    try {
        const result = await provider.findEpisodeServer(episodes[0], server)
        console.log(JSON.stringify(result, null, 2))
    } catch (err) {
        console.error(`  -> ${err.message}`)
    }
}
