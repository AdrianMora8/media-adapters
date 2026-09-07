/// <reference path="../../types/onlinestream-provider.d.ts" />

/**
 * AnimeAV1 — provider de streaming en español para Seanime.
 *
 * animeav1.com es una app SvelteKit. Eso significa que NO hay que parsear HTML:
 * cada ruta expone su payload de carga en `<ruta>/__data.json`, que es
 * exactamente lo que consume el cliente. Es estable, barato y no se rompe con
 * un cambio de clases CSS.
 *
 * El formato es "devalue aplanado": `nodes[i].data` es un array plano donde el
 * índice 0 es la raíz y CADA valor de campo es un ÍNDICE dentro de ese mismo
 * array, no el valor. Toda la lógica de lectura vive en `hydrate()`.
 */

const BASE_URL = "https://animeav1.com"

// El player exige que los segmentos HLS lleguen con la pinta de haber salido
// de él mismo; sin esto Cloudflare responde 403 a mitad de reproducción.
// Seanime reenvía `headers` en CADA petición del vídeo, no sólo en la playlist.
const HLS_HEADERS: { [key: string]: string } = {
    "Referer": "https://player.zilla-networks.com/",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
}

const MP4UPLOAD_HEADERS: { [key: string]: string } = {
    "Referer": "https://www.mp4upload.com/",
}

const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const SITE_HEADERS: { [key: string]: string } = {
    "User-Agent": BROWSER_UA,
    "Referer": BASE_URL + "/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "es-ES,es;q=0.9",
}

/** Vida de una entrada en caché. Suficiente para montar una lista de episodios. */
const CACHE_MS = 5 * 60 * 1000

/**
 * El id que devolvemos a Seanime es opaco: lo recibimos de vuelta tal cual en
 * findEpisodes() y findEpisodeServer(). Lo usamos para arrastrar el audio
 * elegido, que el slug por sí solo no expresa.
 */
interface AnimeRef {
    slug: string
    type: SubOrDub
}

class Provider {
    private baseUrl = BASE_URL

    getSettings(): Settings {
        // Estos nombres son los que Seanime pasará como `server` a
        // findEpisodeServer(). Deben coincidir con los del sitio.
        return {
            episodeServers: ["HLS", "MP4Upload"],
            supportsDub: true,
        }
    }

    // -----------------------------------------------------------------------
    // search
    // -----------------------------------------------------------------------

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const isDub = opts.dub === true

        // Seanime llama a search() varias veces por media, una por título
        // (romaji, inglés, sinónimos). Cachear por media evita repetir la
        // misma petición en la misma sesión.
        const cacheKey = opts.media && opts.media.id
            ? `av1:media:${opts.media.id}:${isDub ? "dub" : "sub"}`
            : ""

        if (cacheKey) {
            const cached = this.remember<SearchResult[]>(cacheKey)
            if (cached) return cached
        }

        // Probamos los títulos por orden de fiabilidad. El romaji es el que
        // mejor casa con el catálogo de animeav1, que indexa en romaji.
        const queries = this.candidateQueries(opts)

        let results: SearchResult[] = []
        for (const q of queries) {
            results = await this.searchOnce(q, isDub)
            if (results.length > 0) break
        }

        if (cacheKey) this.keep(cacheKey, results)
        return results
    }

    /** Una sola consulta al catálogo. */
    private async searchOnce(query: string, isDub: boolean): Promise<SearchResult[]> {
        const key = `av1:search:${isDub ? "dub" : "sub"}:${this.normalize(query)}`

        const cached = this.remember<SearchResult[]>(key)
        if (cached) return cached

        const url = `${this.baseUrl}/catalogo/__data.json?page=1&search=${encodeURIComponent(query)}`

        const res = await this.fetchWithRetry(url)
        if (!res.ok) return []

        const results = this.parseCatalog(res.json(), isDub)
        this.keep(key, results)

        return results
    }

    /**
     * Extrae los resultados del payload de /catalogo.
     *
     * Forma real (verificada contra el endpoint):
     *   nodes[n].data[0] = { results: <idx>, total: <idx>, ... }
     *   data[root.results] = [<idx>, <idx>, ...]        <- punteros a entradas
     *   data[<idx>]        = { id: <idx>, title: <idx>, slug: <idx>, ... }
     */
    private parseCatalog(json: any, isDub: boolean): SearchResult[] {
        const nodes: any[] = (json && json.nodes) || []
        const out: SearchResult[] = []

        for (const node of nodes) {
            if (!node || !Array.isArray(node.data)) continue

            const data: any[] = node.data
            const root = data[0]

            if (!root || typeof root !== "object" || typeof root.results !== "number") continue

            const pointers = data[root.results]
            if (!Array.isArray(pointers)) continue

            for (const ptr of pointers) {
                const entry = this.hydrate(data, ptr)
                if (!entry || !entry.slug || !entry.title) continue

                out.push({
                    id: JSON.stringify({ slug: entry.slug, type: isDub ? "dub" : "sub" } as AnimeRef),
                    title: String(entry.title),
                    url: `${this.baseUrl}/media/${entry.slug}`,
                    // No afirmamos "both": si existe doblaje o no sólo se sabe
                    // mirando un episodio, y eso es trabajo de findEpisodes().
                    subOrDub: isDub ? "dub" : "sub",
                })
            }

            if (out.length > 0) break
        }

        return out
    }

    /**
     * Resuelve un nodo del array aplanado a un objeto normal (un nivel).
     *
     * Es EL helper del formato: sin esto, `entry.title` es el número 4, no un
     * título. Los valores que no son punteros válidos se devuelven tal cual.
     */
    private hydrate(data: any[], pointer: any): { [key: string]: any } | null {
        if (typeof pointer !== "number") return null

        const raw = data[pointer]
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null

        const obj: { [key: string]: any } = {}

        for (const field in raw) {
            const idx = raw[field]
            obj[field] = typeof idx === "number" && idx >= 0 && idx < data.length ? data[idx] : idx
        }

        return obj
    }

    /**
     * Títulos a probar, del más fiable al menos. AniList da el romaji que
     * animeav1 usa como clave de catálogo; el query de Seanime es el respaldo.
     */
    private candidateQueries(opts: SearchOptions): string[] {
        const media = opts.media
        const seen: { [key: string]: boolean } = {}
        const list: string[] = []

        const push = (t?: string | null) => {
            if (!t) return
            const trimmed = String(t).trim()
            if (!trimmed) return
            const k = this.normalize(trimmed)
            if (seen[k]) return
            seen[k] = true
            list.push(trimmed)
        }

        if (media) {
            push(media.romajiTitle)
            push(media.englishTitle)
        }
        push(opts.query)
        if (media && Array.isArray(media.synonyms)) {
            for (const s of media.synonyms) push(s)
        }

        return list
    }

    // -----------------------------------------------------------------------
    // findEpisodes
    // -----------------------------------------------------------------------

    /**
     * GET /media/<slug>/__data.json.
     *
     * A diferencia de /catalogo, aquí el nodo raíz sólo tiene `{ media: <idx> }`;
     * el descriptor real con `episodes`, `slug`, etc. está un nivel más adentro.
     * Verificado en vivo: `data[desc.episodes]` es un array de punteros, y cada
     * entrada es `{ id: <idx>, number: <idx> }` donde `number` puede resolver a
     * un número literal (dato del propio array, no un puntero) o a otro índice.
     */
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const ref = this.parseRef(id)
        const slug = ref.slug

        try {
            const res = await this.fetchWithRetry(`${this.baseUrl}/media/${slug}/__data.json`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)

            const desc = this.findMediaDescriptor(res.json())
            if (!desc) throw new Error("Anime no encontrado")

            const { data, episodes: episodeIndexes } = desc
            const episodes: EpisodeDetails[] = []

            episodeIndexes.forEach((epPtr: number, i: number) => {
                const ep = this.hydrate(data, epPtr)
                if (!ep) return

                // `number` es a veces el literal correcto y a veces un puntero a
                // él; hydrate() ya lo resolvió si era índice válido. Si el sitio
                // no lo trae, i+1 es la mejor suposición.
                let number = typeof ep.number === "number" ? ep.number : i + 1
                if (!Number.isInteger(number) || number <= 0) return

                episodes.push({
                    id: JSON.stringify({ slug, number, type: ref.type } as AnimeRef),
                    number,
                    title: typeof ep.title === "string" ? ep.title : `Episodio ${number}`,
                    url: `${this.baseUrl}/media/${slug}/${number}`,
                })
            })

            // El sitio nunca dice en la ficha si hay doblaje; sólo se sabe
            // mirando los embeds de un episodio. Si el tipo pedido es "dub" y
            // no existe, degradamos a "sub" para no devolver una lista que
            // fallará entera en findEpisodeServer().
            if (ref.type === "dub" && episodes.length > 0) {
                const dubbed = await this.hasDub(slug, episodes[0].number)
                if (!dubbed) {
                    console.error(`AnimeAV1: ${slug} no tiene doblaje, se usa el sub`)
                    return episodes.map(ep => ({
                        ...ep,
                        id: JSON.stringify({ slug, number: ep.number, type: "sub" } as AnimeRef),
                    }))
                }
            }

            return episodes
        } catch (err) {
            console.error(`AnimeAV1: error en findEpisodes(${slug}):`, err)
            return []
        }
    }

    /** Localiza, dentro del payload de /media/<slug>, el objeto con `episodes`. */
    private findMediaDescriptor(json: any): { data: any[]; episodes: number[] } | null {
        for (const node of (json && json.nodes) || []) {
            if (!node || !Array.isArray(node.data)) continue

            const data: any[] = node.data

            for (const raw of data) {
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
                if (typeof raw.episodes !== "number") continue

                const episodePtrs = data[raw.episodes]
                if (!Array.isArray(episodePtrs)) continue

                return { data, episodes: episodePtrs }
            }
        }

        return null
    }

    /**
     * `{ SUB: [...], DUB?: [...] }` de un episodio, con el array del que cuelga.
     * Un mismo episodio se pide una vez por servidor (Seanime prueba todos los
     * de getSettings()), así que se cachea unos minutos para no repetir la
     * petición de la página en cada llamada.
     */
    private async episodeEmbeds(slug: string, number: number): Promise<{ data: any[]; embeds: { [key: string]: any } } | null> {
        const key = `av1:ep:${slug}:${number}`

        const cached = this.remember<{ data: any[]; embeds: { [key: string]: any } }>(key)
        if (cached) return cached

        const res = await this.fetchWithRetry(`${this.baseUrl}/media/${slug}/${number}/__data.json`)
        if (!res.ok) return null

        for (const node of res.json()?.nodes || []) {
            if (!node || !Array.isArray(node.data)) continue

            const data: any[] = node.data
            const root = data.find((item: any) => item && typeof item === "object" && "embeds" in item)
            if (!root) continue

            const embeds = this.hydrate(data, root.embeds) || {}
            const found = { data, embeds }
            this.keep(key, found)
            return found
        }

        return null
    }

    /** Único uso: decidir si "dub" pedido por Seanime tiene sentido para este slug. */
    private async hasDub(slug: string, number: number): Promise<boolean> {
        const key = `av1:dub:${slug}`

        const cached = this.remember<boolean>(key)
        if (cached !== undefined) return cached

        const found = await this.episodeEmbeds(slug, number)
        const dubbed = !!found && "DUB" in found.embeds

        this.keep(key, dubbed)
        return dubbed
    }

    // -----------------------------------------------------------------------
    // findEpisodeServer
    // -----------------------------------------------------------------------

    /**
     * HLS: el embed es `https://player.zilla-networks.com/play/<id>`; el m3u8
     * real sale de sustituir `/play/` por `/m3u8/`. Verificado en vivo, no hace
     * falta tocar el iframe.
     *
     * MP4Upload: el .mp4 en claro está en el HTML del embed, sin ofuscar:
     * `src: "https://<host>.mp4upload.com:<port>/d/<token>/video.mp4"`.
     */
    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const rawId = typeof episode === "string" ? episode : episode.id
        const ref = this.parseRef(rawId)
        const parsedNumber = typeof episode === "object" ? episode.number : undefined

        let slug: string
        let number: number

        try {
            const parsed = JSON.parse(rawId)
            slug = parsed.slug
            number = parsed.number
        } catch {
            slug = ref.slug
            number = parsedNumber as number
        }

        if (!slug || !Number.isInteger(number)) {
            throw new Error("AnimeAV1: id de episodio inválido")
        }

        const found = await this.episodeEmbeds(slug, number)
        if (!found) throw new Error("AnimeAV1: no se encontraron servidores para este episodio")

        const category = ref.type.toUpperCase()
        let serverList = found.embeds[category]

        // Un doblaje puede faltar en un episodio suelto aunque exista en la
        // serie; degradar a sub en vez de fallar toda la reproducción.
        if (!Array.isArray(serverList) && category === "DUB") {
            serverList = found.embeds["SUB"]
            if (Array.isArray(serverList)) {
                console.error(`AnimeAV1: ${slug} ${number} sin doblaje en este episodio, se usa el sub`)
            }
        }

        if (!Array.isArray(serverList)) {
            throw new Error(`AnimeAV1: no hay contenido en ${category} para ${slug} ${number}`)
        }

        const wanted = (server || "HLS").trim().toUpperCase()

        let embedUrl: string | null = null
        let serverName: string | null = null

        for (const ptr of serverList) {
            const entry = this.hydrate(found.data, ptr)
            if (!entry || typeof entry.server !== "string" || typeof entry.url !== "string") continue

            if (entry.server.trim().toUpperCase() === wanted) {
                embedUrl = entry.url
                serverName = entry.server
                break
            }
        }

        if (!embedUrl || !serverName) {
            throw new Error(`AnimeAV1: servidor "${server}" no disponible para ${slug} ${number}`)
        }

        let source: VideoSource | null = null
        let headers: { [key: string]: string } = {}

        if (wanted === "HLS") {
            source = {
                url: embedUrl.replace("/play/", "/m3u8/"),
                type: "m3u8",
                quality: "auto",
                subtitles: [],
            }
            headers = HLS_HEADERS
        } else if (wanted === "MP4UPLOAD") {
            source = await this.extractMp4Upload(embedUrl)
            headers = MP4UPLOAD_HEADERS
        }

        if (!source) {
            throw new Error(`AnimeAV1: no se pudo extraer el vídeo de ${serverName}`)
        }

        return {
            server: serverName,
            headers,
            videoSources: [source],
        }
    }

    /** MP4Upload deja el mp4 sin ofuscar en el HTML del embed. */
    private async extractMp4Upload(embedUrl: string): Promise<VideoSource | null> {
        try {
            const res = await this.fetchWithRetry(embedUrl, 1, MP4UPLOAD_HEADERS)
            if (!res.ok) return null

            const match = res.text().match(/src:\s*"([^"]+\.mp4[^"]*)"/)
            if (!match) return null

            return {
                url: match[1],
                type: "mp4",
                quality: "auto",
                subtitles: [],
            }
        } catch (err) {
            return null
        }
    }

    // -----------------------------------------------------------------------
    // Utilidades
    // -----------------------------------------------------------------------

    private parseRef(id: string): AnimeRef {
        try {
            const parsed = JSON.parse(id)
            if (parsed && parsed.slug) {
                return { slug: String(parsed.slug), type: parsed.type || "sub" }
            }
        } catch (err) {
            // Un id plano es un slug. Aceptarlo hace el provider probable a mano.
        }
        return { slug: id, type: "sub" }
    }

    /**
     * El runtime no expone AbortController ni setTimeout, así que una petición
     * colgada cuesta el timeout completo. Por eso pocos reintentos.
     */
    private async fetchWithRetry(
        url: string,
        retries: number = 2,
        headers: { [key: string]: string } = SITE_HEADERS
    ): Promise<FetchResponse> {
        let lastErr: unknown = null

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const res = await fetch(url, { headers, timeout: 15 })

                // Los 5xx de animeav1 suelen ser transitorios; los 4xx no.
                if (res.status < 500) return res

                lastErr = new Error(`HTTP ${res.status}`)
            } catch (err) {
                lastErr = err
            }
        }

        throw lastErr || new Error(`No se pudo obtener ${url}`)
    }

    /** Para comparar y cachear títulos: sin acentos, sin puntuación, minúsculas. */
    private normalize(text: string): string {
        return text
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, " ")
            .trim()
    }

    private remember<T>(key: string): T | undefined {
        if (typeof $store === "undefined" || !$store) return undefined

        try {
            const hit = $store.get<{ at: number; value: T }>(key)
            if (hit && hit.value !== undefined && Date.now() - hit.at < CACHE_MS) return hit.value
        } catch (err) {
            // Un store que falla no puede tumbar la búsqueda.
        }

        return undefined
    }

    private keep(key: string, value: any): void {
        if (typeof $store === "undefined" || !$store) return

        try {
            $store.set(key, { at: Date.now(), value })
        } catch (err) {
            // No poder cachear no es motivo de fallo.
        }
    }
}
