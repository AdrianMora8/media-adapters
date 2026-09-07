// Arnés de prueba manual para JKAnime, NO forma parte del provider.
// Ver _smoke.mjs (AnimeAV1) para la explicación del shim de fetch/goja.
// Diferencia clave aquí: FetchResponse.cookies debe existir (viene de
// f.response.Cookies() en fetch.go), porque findEpisodes() lo necesita para
// el POST autenticado con CSRF.

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

    const cookies = {}
    // Node's fetch Headers folds multiple Set-Cookie into getSetCookie().
    for (const raw of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const eq = raw.indexOf("=")
        const semi = raw.indexOf(";")
        if (eq === -1) continue
        const name = raw.slice(0, eq)
        const value = raw.slice(eq + 1, semi === -1 ? undefined : semi)
        cookies[name] = value
    }

    return {
        status: res.status,
        statusText: res.statusText,
        ok: res.ok,
        url: res.url,
        headers: Object.fromEntries(res.headers.entries()),
        cookies,
        text: () => bodyText,
        json: () => JSON.parse(bodyText),
    }
}

import { readFileSync } from "node:fs"
const code = readFileSync("./dist/jkanime/index.js", "utf8")
const Provider = new Function(`${code}\nreturn Provider;`)()
const provider = new Provider()

console.log("== getSettings ==")
console.log(provider.getSettings())

console.log("\n== search ==")
const results = await provider.search({
    media: { id: 1, romajiTitle: "Sousou no Frieren", synonyms: [], isAdult: false },
    query: "Frieren",
    dub: false,
})
console.log(`resultados: ${results.length}`)
console.log(results.slice(0, 3))

if (results.length === 0) {
    console.error("FALLO: search no devolvió resultados")
    process.exit(1)
}

const target = results.find(r => r.title.toLowerCase() === "sousou no frieren") || results[0]
console.log(`\n== findEpisodes(${target.id}) ==`)
const episodes = await provider.findEpisodes(target.id)
console.log(`episodios: ${episodes.length}`)
console.log(episodes.slice(0, 3))
console.log("últimos:", episodes.slice(-2))

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
