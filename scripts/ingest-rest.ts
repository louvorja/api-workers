/**
 * Snapshot da camada REST pública de api.louvorja.com.br para o R2.
 *
 * Essas rotas vêm do banco relacional, não do export estático: trazem campos
 * que o /json_db não tem (id_file_*, id_language, created_at, registro de
 * arquivos). Como não dá para derivá-las dos JSONs, cada coleção é copiada
 * inteira e guardada em rest/, e o Worker pagina em cima disso.
 *
 * A origem trava per_page em 15, então coleção grande custa muitas páginas —
 * é um custo de uma vez só, e depois o resync é incremental pelo /db/manifest.
 *
 *   node --env-file=.env --experimental-strip-types scripts/ingest-rest.ts
 *     [--only=<regex>] [--concurrency=8]
 */
import { fetchLegacy, pool } from './lib/legacy.ts'
import * as r2 from './lib/r2.ts'

const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const CONCURRENCY = Number(args.get('concurrency') ?? 8)
const ONLY = args.get('only') ? new RegExp(args.get('only') as string) : null

const NEW_API = 'https://api.louvorja.workers.dev'
const OLD_API = 'https://api.louvorja.com.br'
const LANGS = ['pt', 'es'] as const
const COLLECTIONS = [
  'musics',
  'albums',
  'categories',
  'hymnal',
  'lyrics',
  'files',
  'albums_musics',
  'categories_albums',
] as const

const encoder = new TextEncoder()
const bucketKeys = new Set(await r2.list('musics/'))
for (const k of await r2.list('images/')) bucketKeys.add(k)
for (const k of await r2.list('covers/')) bucketKeys.add(k)

/**
 * O REST devolve URL absoluta apontando para a origem. Aqui ela passa a
 * apontar para esta API e para a chave que existe de fato no acervo (.opus,
 * .jpg) — mesma regra do ingest do json_db.
 */
function rewriteUrl(value: string): string {
  let out = value.replace(OLD_API, NEW_API)
  const path = out.startsWith(`${NEW_API}/file/`) ? out.slice(`${NEW_API}/file/`.length) : null
  if (path === null) return out

  let normalized = path
  if (normalized.toLowerCase().endsWith('.mp3')) normalized = `${normalized.slice(0, -4)}.opus`
  else if (normalized.toLowerCase().endsWith('.bmp')) normalized = `${normalized.slice(0, -4)}.jpg`

  if (bucketKeys.has(normalized)) out = `${NEW_API}/file/${normalized}`
  return out
}

const URL_FIELDS = new Set(['url', 'url_image', 'url_music', 'url_instrumental_music'])

function rewrite(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewrite)
  if (node === null || typeof node !== 'object') return node
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [
      k,
      URL_FIELDS.has(k) && typeof v === 'string' ? rewriteUrl(v) : rewrite(v),
    ]),
  )
}

type Page = { data: unknown[]; total: number; last_page: number; current_page: number }

const read = async <T>(key: string): Promise<T> =>
  JSON.parse(new TextDecoder().decode((await r2.get(`rest/${key}.json`)) as Uint8Array)) as T

async function fetchPage(path: string, page: number): Promise<Page> {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetchLegacy(`${path}${sep}page=${page}`)
  if (res.status !== 200) throw new Error(`${path} page ${page} -> HTTP ${res.status}`)
  return JSON.parse(new TextDecoder().decode(res.body)) as Page
}

/** Baixa a coleção inteira seguindo a paginação da origem. */
async function fetchAll(path: string): Promise<unknown[]> {
  const first = await fetchPage(path, 1)
  const rows: unknown[][] = [first.data]
  if (first.last_page > 1) {
    const pages = Array.from({ length: first.last_page - 1 }, (_, i) => i + 2)
    rows.length = first.last_page
    await pool(pages, CONCURRENCY, async (p) => {
      rows[p - 1] = (await fetchPage(path, p)).data
    })
  }
  return rows.flat().filter((r) => r !== undefined)
}

async function save(key: string, data: unknown) {
  await r2.put(
    `rest/${key}.json`,
    encoder.encode(JSON.stringify(rewrite(data))),
    'application/json',
  )
}

// --------------------------------------------------------------------- main

const jobs: Array<[name: string, run: () => Promise<void>]> = []

for (const lang of LANGS) {
  for (const col of COLLECTIONS) {
    jobs.push([
      `${lang}/${col}`,
      async () => {
        const rows = await fetchAll(`/${lang}/${col}`)
        await save(`${lang}_${col}`, rows)
        console.log(`  ${lang}/${col}: ${rows.length} registros`)
      },
    ])
  }
  jobs.push([
    `${lang}/config`,
    async () => {
      const res = await fetchLegacy(`/${lang}/config`)
      const body = JSON.parse(new TextDecoder().decode(res.body)) as {
        data: Record<string, unknown>
      }
      // A origem expõe o caminho absoluto do banco no servidor. Não replicar.
      const clean = Object.fromEntries(
        Object.entries(body.data).filter(([k]) => !k.endsWith('_path_database')),
      )
      await save(`${lang}_config`, clean)
      console.log(`  ${lang}/config: ${Object.keys(clean).length} chaves`)
    },
  ])
  jobs.push([
    `${lang}/languages`,
    async () => {
      const rows = await fetchAll(`/${lang}/languages`)
      await save(`${lang}_languages`, rows)
      console.log(`  ${lang}/languages: ${rows.length} idiomas`)
    },
  ])
}

/**
 * Rotas de item e de categoria têm forma própria na origem: o álbum vem com a
 * lista de músicas, a música vem com image_position e uma letra em formato
 * diferente do da coleção /lyrics, e a categoria ordena pelo pivô. Derivar isso
 * das coleções produz respostas erradas — então cada uma é copiada como é.
 */
for (const lang of LANGS) {
  jobs.push([
    `${lang}/music_items`,
    async () => {
      const musics = await read<Array<{ id_music: number }>>(`${lang}_musics`)
      let n = 0
      await pool(musics, CONCURRENCY, async (m) => {
        const res = await fetchLegacy(`/${lang}/musics/${m.id_music}`)
        if (res.status !== 200) return
        const body = JSON.parse(new TextDecoder().decode(res.body)) as { data: unknown }
        await save(`${lang}_music_${m.id_music}`, body.data)
        n++
      })
      console.log(`  ${lang}/music_items: ${n} músicas`)
    },
  ])

  jobs.push([
    `${lang}/album_items`,
    async () => {
      const albums = await read<Array<{ id_album: number }>>(`${lang}_albums`)
      let n = 0
      await pool(albums, CONCURRENCY, async (a) => {
        const res = await fetchLegacy(`/${lang}/albums/${a.id_album}`)
        if (res.status !== 200) return
        const body = JSON.parse(new TextDecoder().decode(res.body)) as { data: unknown }
        await save(`${lang}_album_${a.id_album}`, body.data)
        n++
      })
      console.log(`  ${lang}/album_items: ${n} álbuns`)
    },
  ])

  jobs.push([
    `${lang}/category_awm`,
    async () => {
      const cats = await read<Array<{ id_category: number }>>(`${lang}_categories`)
      for (const cat of cats) {
        const res = await fetchLegacy(`/${lang}/categories/${cat.id_category}/albums-with-musics`)
        if (res.status !== 200) continue
        await save(
          `${lang}_category_${cat.id_category}_awm`,
          JSON.parse(new TextDecoder().decode(res.body)),
        )
      }
      console.log(`  ${lang}/category_awm: ${cats.length} categorias`)
    },
  ])

  jobs.push([
    `${lang}/category_albums`,
    async () => {
      const cats = await read<Array<{ id_category: number; slug: string }>>(`${lang}_categories`)
      for (const cat of cats) {
        const rows = await fetchAll(`/${lang}/categories/${cat.id_category}/albums`)
        await save(`${lang}_category_${cat.id_category}_albums`, rows)
        // O slug é alias do mesmo conteúdo; guardar resolvido evita um join.
        if (cat.slug) await save(`${lang}_categoryslug_${cat.slug}_albums`, rows)
      }
      console.log(`  ${lang}/category_albums: ${cats.length} categorias`)
    },
  ])
}

jobs.push([
  'metadata',
  async () => {
    const res = await fetchLegacy('/metadata')
    await r2.put('rest/metadata.json', res.body, 'application/json')
    console.log(`  metadata: ${res.body.length} bytes`)
  },
])

const selected = jobs.filter(([name]) => !ONLY || ONLY.test(name))
console.log(`Snapshot REST — ${selected.length} coleções\n`)

let failed = 0
for (const [name, run] of selected) {
  try {
    await run()
  } catch (e) {
    console.warn(`  FALHA ${name}: ${(e as Error).message}`)
    failed++
  }
}

console.log(`\n${selected.length - failed} ok, ${failed} falharam`)

export {}
