/**
 * Tipos del contrato `onlinestream-provider` de Seanime.
 *
 * Transcritos de la fuente de verdad, no de la documentación:
 *   internal/extension/hibike/onlinestream/types.go
 *   internal/goja/goja_bindings/{fetch,document,crypto,console}.go
 *
 * El runtime (goja) inyecta estos globales; el fichero de provider NO debe
 * importar nada. Estos tipos son sólo para el editor y `tsc --noEmit`.
 */

declare type SubOrDub = "sub" | "dub" | "both"
declare type VideoSourceType = "mp4" | "m3u8" | "unknown"

declare interface FuzzyDate {
    year: number
    month?: number
    day?: number
}

/** Media de AniList que Seanime ya conoce. Úsalo para desambiguar temporadas. */
declare interface Media {
    id: number
    idMal?: number
    /** "FINISHED" | "RELEASING" | "NOT_YET_RELEASED" | "CANCELLED" | "HIATUS" */
    status?: string
    /** "TV" | "TV_SHORT" | "MOVIE" | "SPECIAL" | "OVA" | "ONA" | "MUSIC" */
    format?: string
    englishTitle?: string
    romajiTitle?: string
    /** -1 si se desconoce. */
    episodeCount?: number
    synonyms: string[]
    isAdult: boolean
    startDate?: FuzzyDate
}

declare interface SearchOptions {
    media: Media
    query: string
    dub: boolean
    /** 0 si no se conoce. */
    year?: number
}

declare interface Settings {
    /** Nombres de servidor que Seanime pasará a findEpisodeServer(). */
    episodeServers: string[]
    supportsDub: boolean
}

/** OJO: no existe campo de carátula. Seanime usa la imagen de AniList. */
declare interface SearchResult {
    id: string
    title: string
    url: string
    subOrDub: SubOrDub
}

declare interface EpisodeDetails {
    id: string
    /** 1..n */
    number: number
    url: string
    title?: string
}

declare interface VideoSubtitle {
    id: string
    url: string
    /** "es", "en", ... */
    language: string
    isDefault: boolean
}

declare interface VideoSource {
    url: string
    type: VideoSourceType
    /** "default" | "auto" | "1080p" ... */
    quality: string
    label?: string
    subtitles: VideoSubtitle[]
}

declare interface EpisodeServer {
    server: string
    /** Cabeceras que Seanime reenvía en CADA petición del vídeo (incl. segmentos HLS). */
    headers: { [key: string]: string }
    videoSources: VideoSource[]
}

// ---------------------------------------------------------------------------
// Globales inyectados
// ---------------------------------------------------------------------------

declare interface FetchOptions {
    method?: string
    headers?: Record<string, string>
    body?: any
    noCloudflareBypass?: boolean
    redirect?: "follow" | "manual" | "error"
    /** Segundos. Por defecto 35. */
    timeout?: number
}

/** OJO: text() y json() son SÍNCRONOS en goja, no devuelven Promise. */
declare interface FetchResponse {
    status: number
    statusText: string
    ok: boolean
    url: string
    headers: Record<string, string>
    text(): string
    json<T = any>(): T
}

declare function fetch(url: string, options?: FetchOptions): Promise<FetchResponse>

/** Selección estilo cheerio, respaldada por goquery. */
declare interface DocSelection {
    length: number
    find(selector: string): DocSelection
    children(selector?: string): DocSelection
    parent(selector?: string): DocSelection
    first(): DocSelection
    last(): DocSelection
    eq(i: number): DocSelection
    attr(name: string): string | undefined
    text(): string
    html(): string
    each(fn: (index: number, el: DocSelection) => void): void
    map<T>(fn: (index: number, el: DocSelection) => T): T[]
}

declare function LoadDoc(html: string): DocSelection
declare const Doc: new (html: string) => DocSelection

/** Almacén clave/valor compartido entre las VMs de esta extensión. Puede no existir. */
declare const $store:
    | {
          get<T = any>(key: string): T | undefined
          set(key: string, value: any): void
          has(key: string): boolean
          remove(key: string): void
      }
    | undefined

declare const $sleep: (ms: number) => void
declare const crypto: any

declare const console: {
    log(...args: any[]): void
    warn(...args: any[]): void
    error(...args: any[]): void
    debug(...args: any[]): void
    info(...args: any[]): void
}
