// Arnés de prueba manual para TioAnime, NO forma parte del provider.
// Ver _smoke.mjs (AnimeAV1) para la explicación del shim de fetch/goja.

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
        cookies: {},
        text: () => bodyText,
        json: () => JSON.parse(bodyText),
    }
}

import { readFileSync } from "node:fs"
const code = readFileSync("./dist/tioanime/index.js", "utf8")
const Provider = new Function(`${code}\nreturn Provider;`)()
const provider = new Provider()

console.log("== getSettings ==")
console.log(provider.getSettings())

console.log("\n== search (sub) ==")
const subResults = await provider.search({
    media: { id: 1, romajiTitle: "Sousou no Frieren", synonyms: [], isAdult: false },
    query: "Frieren",
    dub: false,
})
console.log(`resultados (sub): ${subResults.length}`)
console.log(subResults.slice(0, 3))

console.log("\n== search (dub / latino) ==")
const dubResults = await provider.search({
    media: { id: 2, romajiTitle: "Dragon Ball Super", synonyms: [], isAdult: false },
    query: "Dragon Ball Super",
    dub: true,
})
console.log(`resultados (dub): ${dubResults.length}`)
console.log(dubResults.slice(0, 3))

if (subResults.length === 0) {
    console.error("FALLO: search (sub) no devolvió resultados")
    process.exit(1)
}
if (dubResults.length === 0) {
    console.error("FALLO: search (dub) no devolvió resultados")
    process.exit(1)
}
if (dubResults.some(r => r.subOrDub !== "dub")) {
    console.error("FALLO: search (dub) devolvió una entrada no-latino")
    process.exit(1)
}

const target = subResults.find(r => r.title.toLowerCase() === "sousou no frieren") || subResults[0]
console.log(`\n== findEpisodes(${target.id}) ==`)
const episodes = await provider.findEpisodes(target.id)
console.log(`episodios: ${episodes.length}`)
console.log(episodes.slice(0, 3))

if (episodes.length === 0) {
    console.error("FALLO: findEpisodes no devolvió episodios")
    process.exit(1)
}

console.log(`\n== findEpisodeServer(ep1, "YourUpload") ==`)
let result
try {
    result = await provider.findEpisodeServer(episodes[0], "YourUpload")
    console.log(JSON.stringify(result, null, 2))
} catch (err) {
    console.error(`  -> ${err.message}`)
    process.exit(1)
}

console.log("\n== verificando que el mp4 final carga con los headers declarados ==")
const src = result.videoSources[0]
const checkRes = await realFetch(src.url, { headers: result.headers })
console.log(`HTTP:${checkRes.status} content-type:${checkRes.headers.get("content-type")}`)
if (!checkRes.ok) {
    console.error("FALLO: el mp4 no cargó con los headers que estamos devolviendo a Seanime")
    process.exit(1)
}
