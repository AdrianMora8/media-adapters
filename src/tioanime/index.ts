/// <reference path="../../types/onlinestream-provider.d.ts" />

/**
 * TioAnime — provider de streaming en español para Seanime.
 *
 * Mismo template clásico que hizo famoso a AnimeFLV: cada página trae los
 * datos embebidos en `<script>` como arrays JS planos, sin necesidad de
 * parsear HTML para lo importante:
 *   - ficha:    `var episodes = [n, n-1, ..., 1]` (orden descendente)
 *   - episodio: `var videos = [["Servidor","url",x,y], ...]`
 *
 * A diferencia de AnimeAV1/JKAnime, aquí sub y doblaje latino son entradas de
 * catálogo SEPARADAS (slugs "naruto" vs "naruto-latino"), no una alternancia
 * dentro de la misma ficha. `search()` filtra por eso según `opts.dub` en vez
 * de resolverlo mirando un episodio.
 *
 * Servidores: la mayoría (Mega, Okru, Netu, Voe, MixDrop, StreamSB...) están
 * ofuscados o requieren sesión. **YourUpload** es la excepción: dejó el mp4
 * en claro en el HTML del embed en las 4 combinaciones anime/episodio
 * probadas, así que es el único soportado en esta primera versión.
 */

const BASE_URL = "https://tioanime.com"

const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const SITE_HEADERS: { [key: string]: string } = {
    "User-Agent": BROWSER_UA,
    "Referer": BASE_URL + "/",
    "Accept-Language": "es-ES,es;q=0.9",
}

// vidcache.net (el CDN detrás de YourUpload) responde 500 "bad hand off" sin
// esto — comprobado en vivo, no es opcional. Seanime reenvía estas cabeceras
// en cada petición del vídeo, así que basta con declararlas aquí.
const YOURUPLOAD_HEADERS: { [key: string]: string } = {
    "Referer": "https://www.yourupload.com/",
}

interface AnimeRef {
    slug: string
}

interface EpisodeRef {
    slug: string
    number: number
}

class Provider {
    private baseUrl = BASE_URL

    getSettings(): Settings {
        return {
            episodeServers: ["YourUpload"],
            supportsDub: true,
        }
    }

    // -----------------------------------------------------------------------
    // search
    // -----------------------------------------------------------------------

    /**
     * El buscador de TioAnime devuelve sub y latino mezclados si el título
     * coincide en ambos (p.ej. buscar "dragon ball super" trae tanto la
     * ficha normal como "... Latino"). Como son fichas independientes, se
     * filtra aquí por lo que pidió Seanime en vez de dejarlo para findEpisodes.
     */
    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const wantDub = opts.dub === true
        const queries = this.candidateQueries(opts)

        for (const q of queries) {
            const all = await this.searchOnce(q)
            const filtered = all.filter(r => this.isLatinoTitle(r.title) === wantDub)
            if (filtered.length > 0) return filtered
        }

        return []
    }

    private async searchOnce(query: string): Promise<SearchResult[]> {
        const url = `${this.baseUrl}/directorio?q=${encodeURIComponent(query)}`

        const res = await this.fetchWithRetry(url)
        if (!res.ok) return []

        return this.parseSearchResults(res.text())
    }

    /**
     * <article class="anime">
     *   <a href="/anime/<slug>">
     *     <div class="thumb">...</div>
     *     <h3 class="title">Título</h3>
     *   </a>
     * </article>
     */
    private parseSearchResults(html: string): SearchResult[] {
        const out: SearchResult[] = []
        const re = /<article class="anime">\s*<a href="([^"]+)">[\s\S]*?<h3 class="title">([^<]+)<\/h3>/g
        let match: RegExpExecArray | null

        while ((match = re.exec(html)) !== null) {
            const href = match[1]
            const title = this.decodeEntities(match[2].trim())
            const slugMatch = href.match(/\/anime\/([^\/]+)/)
            if (!slugMatch || !title) continue

            const slug = slugMatch[1]

            out.push({
                id: JSON.stringify({ slug } as AnimeRef),
                title,
                url: `${this.baseUrl}${href}`,
                subOrDub: this.isLatinoTitle(title) ? "dub" : "sub",
            })
        }

        return out
    }

    private isLatinoTitle(title: string): boolean {
        return /\blatino\b/i.test(title)
    }

    private candidateQueries(opts: SearchOptions): string[] {
        const media = opts.media
        const seen: { [key: string]: boolean } = {}
        const list: string[] = []

        const push = (t?: string | null) => {
            if (!t) return
            const trimmed = String(t).trim()
            if (!trimmed) return
            const k = trimmed.toLowerCase()
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

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const ref = this.parseAnimeRef(id)
        const slug = ref.slug

        try {
            const res = await this.fetchWithRetry(`${this.baseUrl}/anime/${slug}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)

            const numbers = this.extractEpisodeNumbers(res.text())
            if (numbers.length === 0) throw new Error("No se encontró la lista de episodios")

            return numbers
                .sort((a, b) => a - b)
                .map(number => ({
                    id: JSON.stringify({ slug, number } as EpisodeRef),
                    number,
                    title: `Episodio ${number}`,
                    url: `${this.baseUrl}/ver/${slug}-${number}`,
                }))
        } catch (err) {
            console.error(`TioAnime: error en findEpisodes(${slug}):`, err)
            return []
        }
    }

    /** `var episodes = [28,27,...,1];` — orden descendente, sólo números. */
    private extractEpisodeNumbers(html: string): number[] {
        const match = html.match(/var episodes\s*=\s*\[([^\]]*)\]/)
        if (!match) return []

        return match[1]
            .split(",")
            .map(s => Number(s.trim()))
            .filter(n => Number.isInteger(n) && n > 0)
    }

    // -----------------------------------------------------------------------
    // findEpisodeServer
    // -----------------------------------------------------------------------

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const rawId = typeof episode === "string" ? episode : episode.id
        let slug: string
        let number: number

        try {
            const parsed = JSON.parse(rawId)
            slug = parsed.slug
            number = parsed.number
        } catch {
            throw new Error("TioAnime: id de episodio inválido")
        }

        if (!slug || !Number.isInteger(number)) {
            throw new Error("TioAnime: id de episodio inválido")
        }

        const episodeUrl = `${this.baseUrl}/ver/${slug}-${number}`
        const res = await this.fetchWithRetry(episodeUrl)
        if (!res.ok) throw new Error(`TioAnime: no se pudo cargar el episodio (HTTP ${res.status})`)

        const servers = this.extractServers(res.text())
        const wanted = server.trim().toLowerCase()
        const found = servers.find(s => s.name.toLowerCase() === wanted)

        if (!found) {
            throw new Error(`TioAnime: servidor "${server}" no disponible para ${slug} ${number}`)
        }

        const source = await this.extractSource(found.name, found.url, episodeUrl)
        if (!source) {
            throw new Error(`TioAnime: no se pudo extraer el vídeo de "${server}"`)
        }

        const headers = found.name.toLowerCase() === "yourupload" ? YOURUPLOAD_HEADERS : {}

        return {
            server: found.name,
            headers,
            videoSources: [source],
        }
    }

    /**
     * `var videos = [["Mega","https:\/\/...",0,0],["YourUpload","https:\/\/...",0,0],...];`
     * Los `\/` son escapes JS literales en el HTML (viene de un `json_encode`
     * de PHP), no hace falta un parser de verdad: basta con desescaparlos.
     */
    private extractServers(html: string): { name: string; url: string }[] {
        const arrayMatch = html.match(/var videos\s*=\s*(\[[\s\S]*?\]);/)
        if (!arrayMatch) return []

        const out: { name: string; url: string }[] = []
        const entryRe = /\["([^"]+)","((?:[^"\\]|\\.)*)"/g
        let match: RegExpExecArray | null

        while ((match = entryRe.exec(arrayMatch[1])) !== null) {
            out.push({ name: match[1], url: match[2].replace(/\\\//g, "/") })
        }

        return out
    }

    private async extractSource(serverName: string, embedUrl: string, referer: string): Promise<VideoSource | null> {
        if (serverName.toLowerCase() === "yourupload") {
            return this.extractYourUpload(embedUrl, referer)
        }
        return null
    }

    /**
     * El mp4 va en claro dos veces: `file: '...'` (config de JWPlayer) y en
     * `<meta property="og:video">`. Se usa `file:` como principal porque no
     * depende de que el sitio siga rellenando metadatos OG.
     */
    private async extractYourUpload(embedUrl: string, referer: string): Promise<VideoSource | null> {
        try {
            const res = await this.fetchWithRetry(embedUrl, 1, {
                "User-Agent": BROWSER_UA,
                "Referer": referer,
            })
            if (!res.ok) return null

            const html = res.text()
            const match =
                html.match(/file:\s*'([^']+\.mp4[^']*)'/) ||
                html.match(/<meta property="og:video" content="([^"]+)"/)

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

    private parseAnimeRef(id: string): AnimeRef {
        try {
            const parsed = JSON.parse(id)
            if (parsed && parsed.slug) return { slug: String(parsed.slug) }
        } catch (err) {
            // Un id plano es un slug.
        }
        return { slug: id }
    }

    private decodeEntities(text: string): string {
        return text
            .replace(/&amp;/g, "&")
            .replace(/&#0?39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
    }

    private async fetchWithRetry(
        url: string,
        retries: number = 2,
        headers: { [key: string]: string } = SITE_HEADERS
    ): Promise<FetchResponse> {
        let lastErr: unknown = null

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const res = await fetch(url, { headers, timeout: 15 })
                if (res.status < 500) return res
                lastErr = new Error(`HTTP ${res.status}`)
            } catch (err) {
                lastErr = err
            }
        }

        throw lastErr || new Error(`No se pudo obtener ${url}`)
    }
}
