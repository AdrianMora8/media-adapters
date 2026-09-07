/// <reference path="../../types/onlinestream-provider.d.ts" />

// Sólo para `tsc`: ver la nota equivalente en src/animeav1/index.ts.
export {}

/**
 * JKAnime — provider de streaming en español para Seanime.
 *
 * A diferencia de AnimeAV1, jkanime.net es un sitio Laravel server-rendered
 * clásico: hay que parsear HTML y, para la lista de episodios, autenticar una
 * llamada AJAX con un token CSRF atado a una cookie de sesión.
 *
 * Servidores: la página de episodio ofrece varios (Desu, Magi, Okru...), cada
 * uno un iframe embebido en un array `video[]` inline en el HTML. Desu y Magi
 * son proxies propios de JKAnime (`/jkplayer/um` y `/jkplayer/umv`) que
 * terminan sirviendo el mismo m3u8 de su CDN (nika.playmudos.com) en claro
 * dentro del HTML de esos proxies. Okru reenvía a ok.ru, cuyos enlaces van
 * firmados por su propio backend: no se soporta, igual que Seanime no
 * pretende resolver Mega en AnimeAV1.
 */

const BASE_URL = "https://jkanime.net"

const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const SITE_HEADERS: { [key: string]: string } = {
    "User-Agent": BROWSER_UA,
    "Referer": BASE_URL + "/",
    "Accept-Language": "es-ES,es;q=0.9",
}

/** Cuántos episodios trae cada página de /ajax/episodes. Visto en vivo; el sitio no lo declara. */
const EPISODES_PAGE_SIZE = 16

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
            // Nombres tal como aparecen en la página de episodio (data-id 0 y 1).
            // Okru queda fuera: sus enlaces van firmados por ok.ru, no por JKAnime.
            episodeServers: ["Desu", "Magi"],
            supportsDub: false,
        }
    }

    // -----------------------------------------------------------------------
    // search
    // -----------------------------------------------------------------------

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const queries = this.candidateQueries(opts)

        for (const q of queries) {
            const results = await this.searchOnce(q)
            if (results.length > 0) return results
        }

        return []
    }

    private async searchOnce(query: string): Promise<SearchResult[]> {
        const url = `${this.baseUrl}/buscar/${encodeURIComponent(query)}/`

        const res = await this.fetchWithRetry(url)
        if (!res.ok) return []

        return this.parseSearchResults(res.text())
    }

    /**
     * Cada resultado es un bloque:
     *   <div class="anime__item">
     *     <a href="https://jkanime.net/<slug>/">...</a>
     *     ...
     *     <h5><a href="https://jkanime.net/<slug>/">Título</a></h5>
     *   </div>
     * El título fiable está en el <h5>, no en el primer <a> (ese sólo envuelve
     * la miniatura y no siempre lleva texto).
     */
    private parseSearchResults(html: string): SearchResult[] {
        const out: SearchResult[] = []
        const blockRe = /<div class="anime__item">([\s\S]*?)<\/div>\s*<\/div>/g
        let block: RegExpExecArray | null

        while ((block = blockRe.exec(html)) !== null) {
            const titleMatch = block[1].match(/<h5>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>\s*<\/h5>/)
            if (!titleMatch) continue

            const href = titleMatch[1]
            const title = this.decodeEntities(titleMatch[2].trim())
            const slug = this.slugFromUrl(href)
            if (!slug || !title) continue

            out.push({
                id: JSON.stringify({ slug } as AnimeRef),
                title,
                url: href,
                subOrDub: "sub",
            })
        }

        return out
    }

    private slugFromUrl(url: string): string | null {
        const match = url.match(/jkanime\.net\/([^\/]+)\/?/)
        return match ? match[1] : null
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

    /**
     * La ficha del anime no trae los episodios en el HTML: los carga por AJAX
     * con un token CSRF de Laravel atado a la cookie de sesión de esa misma
     * petición. Sin la cookie exacta de esa respuesta, el POST responde 419
     * (Page Expired) aunque el token en sí sea "válido" en apariencia.
     */
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const ref = this.parseAnimeRef(id)
        const slug = ref.slug

        try {
            const page = await this.fetchWithRetry(`${this.baseUrl}/${slug}/`)
            if (!page.ok) throw new Error(`HTTP ${page.status}`)

            const html = page.text()
            const animeId = this.extractAnimeId(html)
            const csrfToken = this.extractCsrfToken(html)
            if (!animeId || !csrfToken) throw new Error("No se encontraron animeId/csrf en la ficha")

            const cookieHeader = this.buildCookieHeader(page.cookies)

            const episodes: EpisodeDetails[] = []
            let pageNum = 1

            // El sitio no da el total de páginas de antemano en la ficha; se
            // sabe por el `total` que trae la primera respuesta AJAX.
            while (true) {
                const batch = await this.fetchEpisodesPage(slug, animeId, pageNum, csrfToken, cookieHeader)
                if (!batch || batch.data.length === 0) break

                for (const ep of batch.data) {
                    if (typeof ep.number !== "number") continue
                    episodes.push({
                        id: JSON.stringify({ slug, number: ep.number } as EpisodeRef),
                        number: ep.number,
                        title: typeof ep.title === "string" ? ep.title : `Episodio ${ep.number}`,
                        url: `${this.baseUrl}/${slug}/${ep.number}/`,
                    })
                }

                if (episodes.length >= batch.total || batch.data.length < EPISODES_PAGE_SIZE) break
                pageNum++
            }

            episodes.sort((a, b) => a.number - b.number)
            return episodes
        } catch (err) {
            console.error(`JKAnime: error en findEpisodes(${slug}):`, err)
            return []
        }
    }

    private async fetchEpisodesPage(
        slug: string,
        animeId: string,
        page: number,
        csrfToken: string,
        cookieHeader: string
    ): Promise<{ data: any[]; total: number } | null> {
        const res = await fetch(`${this.baseUrl}/ajax/episodes/${animeId}/${page}`, {
            method: "POST",
            headers: {
                "User-Agent": BROWSER_UA,
                "Referer": `${this.baseUrl}/${slug}/`,
                "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/x-www-form-urlencoded",
                "Cookie": cookieHeader,
            },
            body: `_token=${encodeURIComponent(csrfToken)}`,
            timeout: 15,
        })

        if (!res.ok) return null

        const json = res.json()
        if (!json || !Array.isArray(json.data)) return null

        return { data: json.data, total: typeof json.total === "number" ? json.total : json.data.length }
    }

    private extractAnimeId(html: string): string | null {
        const match = html.match(/id="guardar-anime"[^>]*data-anime="(\d+)"/)
        return match ? match[1] : null
    }

    private extractCsrfToken(html: string): string | null {
        const match = html.match(/name="csrf-token" content="([^"]+)"/)
        return match ? match[1] : null
    }

    /** `res.cookies` ya viene parseado por el runtime: sólo hay que rearmarlo como cabecera. */
    private buildCookieHeader(cookies: Record<string, string>): string {
        return Object.keys(cookies)
            .map(name => `${name}=${cookies[name]}`)
            .join("; ")
    }

    // -----------------------------------------------------------------------
    // findEpisodeServer
    // -----------------------------------------------------------------------

    /**
     * La página de episodio trae, embebidos en <script>:
     *   - la lista de servidores: <a id="btn-show-N" ...>Nombre</a>
     *   - los iframes:            video[N] = '<iframe ... src="...">...';
     * N conecta ambos. El iframe de Desu/Magi es un proxy propio de JKAnime
     * (`/jkplayer/um(v)`) cuyo HTML trae el m3u8 real en claro, con una firma
     * temporal en la query string (por eso no se cachea).
     */
    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const rawId = typeof episode === "string" ? episode : episode.id
        let slug: string
        let number: number

        try {
            const parsed = JSON.parse(rawId)
            slug = parsed.slug
            number = parsed.number
        } catch {
            throw new Error("JKAnime: id de episodio inválido")
        }

        if (!slug || !Number.isInteger(number)) {
            throw new Error("JKAnime: id de episodio inválido")
        }

        const episodeUrl = `${this.baseUrl}/${slug}/${number}/`
        const res = await this.fetchWithRetry(episodeUrl)
        if (!res.ok) throw new Error(`JKAnime: no se pudo cargar el episodio (HTTP ${res.status})`)

        const html = res.text()
        const serverIndex = this.findServerIndex(html, server)
        if (serverIndex === null) {
            throw new Error(`JKAnime: servidor "${server}" no disponible para ${slug} ${number}`)
        }

        const iframeSrc = this.extractIframeSrc(html, serverIndex)
        if (!iframeSrc) {
            throw new Error(`JKAnime: no se encontró el iframe del servidor "${server}"`)
        }

        const embedUrl = iframeSrc.startsWith("http") ? iframeSrc : `${this.baseUrl}${iframeSrc}`

        const source = await this.extractM3u8(embedUrl, episodeUrl)
        if (!source) {
            throw new Error(`JKAnime: no se pudo extraer el vídeo de "${server}"`)
        }

        return {
            server,
            headers: {},
            videoSources: [source],
        }
    }

    /**
     * `<a id="btn-show-0" ...>Desu</a>`, `<a id="btn-show-1" ...>Magi</a>`, etc.
     * El nombre visible es lo único estable entre recargas; el índice sólo
     * sirve para emparejar con `video[N]`.
     */
    private findServerIndex(html: string, wantedServer: string): number | null {
        const wanted = wantedServer.trim().toLowerCase()
        const re = /id="btn-show-(\d+)"[^>]*>([^<]+)<\/a>/g
        let match: RegExpExecArray | null

        while ((match = re.exec(html)) !== null) {
            if (match[2].trim().toLowerCase() === wanted) return Number(match[1])
        }

        return null
    }

    private extractIframeSrc(html: string, index: number): string | null {
        const re = new RegExp(`video\\[${index}\\]\\s*=\\s*'[^']*src="([^"]+)"`)
        const match = html.match(re)
        return match ? match[1].replace(/&amp;/g, "&") : null
    }

    private async extractM3u8(embedUrl: string, referer: string): Promise<VideoSource | null> {
        try {
            const res = await this.fetchWithRetry(embedUrl, 1, {
                "User-Agent": BROWSER_UA,
                "Referer": referer,
            })
            if (!res.ok) return null

            const html = res.text()

            // Cubre tanto `url: '...m3u8...'` (DPlayer) como `<source src='...m3u8...'>`.
            const match = html.match(/(?:url:\s*['"]|<source src=['"])([^'"]+\.m3u8[^'"]*)['"]/)
            if (!match) return null

            return {
                url: match[1],
                type: "m3u8",
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
