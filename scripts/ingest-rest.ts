/**
 * Snapshot da camada REST pública de api.louvorja.com.br para o R2.
 *
 * Essas rotas vêm do banco relacional, não do export estático: trazem campos
 * que o /json_db não tem (id_file_*, id_language, created_at, registro de
 * arquivos). Como não dá para derivá-las dos JSONs, cada coleção é copiada
 * inteira e guardada em rest/, e o Worker pagina em cima disso.
 *
 * A origem trava per_page em 15, então coleção grande custa muitas páginas: uma
 * passada completa são ~8.900 requisições contra um limite de 5.000 por janela.
 * Por isso o padrão é incremental — `--changed` recebe o relatório do ingest e
 * só reprocessa o que mudou de hash no /db/manifest. `--full` faz a passada
 * inteira, para reconciliar de tempos em tempos.
 *
 *   node --env-file=.env --experimental-strip-types scripts/ingest-rest.ts
 *     [--changed=ingest-report.json] [--full] [--only=<regex>] [--concurrency=3]
 */
import { readFileSync } from 'node:fs'
import { fetchLegacy, pool } from './lib/legacy.ts'
import * as r2 from './lib/r2.ts'

const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
// 3, não 8: a origem estrangula. Ver o espaçamento global em lib/legacy.ts.
const CONCURRENCY = Number(args.get('concurrency') ?? 3)
const ONLY = args.get('only') ? new RegExp(args.get('only') as string) : null
const FULL = args.has('full')

/** Tabelas que mudaram de hash nesta rodada do ingest, do relatório dele. */
const changedTables = new Set<string>()
const changedArg = args.get('changed')
if (changedArg && !FULL) {
  try {
    const rel = JSON.parse(readFileSync(changedArg, 'utf8')) as { changed?: string[] }
    for (const t of rel.changed ?? []) changedTables.add(t)
  } catch (e) {
    throw new Error(`não consegui ler ${changedArg}: ${(e as Error).message}`)
  }
}
/** Sem --changed e sem --full, não há como saber o que mudou: roda tudo. */
const INCREMENTAL = Boolean(changedArg) && !FULL

const idsMudados = (prefixo: 'music' | 'album'): number[] =>
  [...changedTables]
    .map((t) => new RegExp(`^${prefixo}_(\\d+)$`).exec(t)?.[1])
    .filter((v): v is string => Boolean(v))
    .map(Number)

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
const bucketObjects = await r2.listWithSizes('musics/')
for (const [k, v] of await r2.listWithSizes('images/')) bucketObjects.set(k, v)
for (const [k, v] of await r2.listWithSizes('covers/')) bucketObjects.set(k, v)
const bucketKeys = new Set(bucketObjects.keys())

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
  const out = Object.fromEntries(
    Object.entries(node).map(([k, v]) => [
      k,
      URL_FIELDS.has(k) && typeof v === 'string' ? rewriteUrl(v) : rewrite(v),
    ]),
  )
  return corrigirTamanho(out)
}

/**
 * O `size` da origem descreve o arquivo dela (.mp3/.bmp), mas a `url` passa a
 * apontar a chave do acervo — que pode ser outro arquivo, de outro tamanho.
 * O desktop compara `tamanho local >= size` para decidir se o download está
 * íntegro, então o registro precisa falar do arquivo que a API entrega; do
 * contrário toda faixa parece danificada e é rebaixada a cada verificação.
 */
function corrigirTamanho(row: Record<string, unknown>): Record<string, unknown> {
  const url = row.url
  if (typeof url !== 'string' || typeof row.size !== 'number') return row

  const prefixo = `${NEW_API}/file/`
  if (!url.startsWith(prefixo)) return row

  const real = bucketObjects.get(url.slice(prefixo.length))
  return real === undefined || real === row.size ? row : { ...row, size: real }
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

/**
 * Busca só a cauda de uma coleção append-only.
 *
 * `lyrics` e `files` não têm tabela 1:1 no /db/manifest, então não dá para saber
 * pelo hash se mudaram — e são justamente as caras (~4.400 páginas somadas).
 * Como crescem por id no fim, comparar o `total` da página 1 com o tamanho do
 * snapshot diz quantas páginas novas existem: 2 requisições no caso parado.
 *
 * Qualquer sinal de que a coleção não cresceu monotonicamente (encolheu, ou não
 * há snapshot) cai para a passada inteira — barato de errar para o lado seguro.
 */
async function fetchTail(path: string, key: string): Promise<unknown[]> {
  let snapshot: unknown[]
  try {
    snapshot = await read<unknown[]>(key)
  } catch {
    return fetchAll(path)
  }
  if (!Array.isArray(snapshot) || snapshot.length === 0) return fetchAll(path)

  const first = await fetchPage(path, 1)
  const perPage = first.data.length || 15
  if (first.total < snapshot.length) return fetchAll(path)
  if (first.total === snapshot.length) return snapshot

  // Recomeça na página que contém o primeiro registro novo, para não cortar
  // uma página no meio nem confiar em índice fora de fronteira.
  const startPage = Math.max(1, Math.floor(snapshot.length / perPage) + 1)
  const pages = Array.from({ length: first.last_page - startPage + 1 }, (_, i) => i + startPage)
  const rows: unknown[][] = []
  rows.length = pages.length
  await pool(pages, CONCURRENCY, async (p) => {
    rows[p - startPage] = p === 1 ? first.data : (await fetchPage(path, p)).data
  })

  return [...snapshot.slice(0, (startPage - 1) * perPage), ...rows.flat()].filter(
    (r) => r !== undefined,
  )
}

async function save(key: string, data: unknown) {
  await r2.put(
    `rest/${key}.json`,
    encoder.encode(JSON.stringify(rewrite(data))),
    'application/json',
  )
}

// --------------------------------------------------------------------- main

const jobs: Array<[name: string, run: () => Promise<void>, roda?: () => boolean]> = []

const mudou = (t: string) => changedTables.has(t)
const algumMudou = (re: RegExp) => [...changedTables].some((t) => re.test(t))
const musicaMudou = () => algumMudou(/^music_\d+$/)
const albumMudou = () => algumMudou(/^album_\d+$/)

/**
 * Nem toda coleção REST tem tabela 1:1 no /db/manifest — existem `pt_musics`,
 * `pt_categories` e `pt_hymnal`, mas não `pt_albums` nem `pt_files`. Onde falta,
 * o gatilho é a tabela de item correspondente (`album_N`, `music_N`).
 *
 * `lyrics` e `files` ficam fora deste mapa de propósito: são as caras, e o
 * fetchTail já as torna baratas o bastante para rodar sempre.
 */
const GATILHO: Record<string, (lang: string) => boolean> = {
  musics: (l) => mudou(`${l}_musics`) || musicaMudou(),
  categories: (l) => mudou(`${l}_categories`),
  hymnal: (l) => mudou(`${l}_hymnal`),
  albums: () => albumMudou(),
  albums_musics: () => musicaMudou() || albumMudou(),
  categories_albums: (l) => mudou(`${l}_categories`) || albumMudou(),
}

/** Coleções sem tabela de referência, buscadas pela cauda. */
const APPEND_ONLY = new Set(['lyrics', 'files'])

for (const lang of LANGS) {
  for (const col of COLLECTIONS) {
    const porCauda = APPEND_ONLY.has(col)
    jobs.push([
      `${lang}/${col}`,
      async () => {
        const rows = porCauda
          ? await fetchTail(`/${lang}/${col}`, `${lang}_${col}`)
          : await fetchAll(`/${lang}/${col}`)
        await save(`${lang}_${col}`, rows)
        console.log(`  ${lang}/${col}: ${rows.length} registros`)
      },
      porCauda ? undefined : () => GATILHO[col]?.(lang) ?? true,
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
    () => mudou('config'),
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
      // No incremental só os ids que mudaram de hash. As tabelas de item não
      // têm idioma (`music_1`, não `pt_music_1`), então cada id é tentado nos
      // dois — o que não pertence a este idioma devolve não-200 e é ignorado.
      const ids = INCREMENTAL
        ? idsMudados('music')
        : (await read<Array<{ id_music: number }>>(`${lang}_musics`)).map((m) => m.id_music)
      let n = 0
      await pool(ids, CONCURRENCY, async (id) => {
        const res = await fetchLegacy(`/${lang}/musics/${id}`)
        if (res.status !== 200) return
        const body = JSON.parse(new TextDecoder().decode(res.body)) as { data: unknown }
        await save(`${lang}_music_${id}`, body.data)
        n++
      })
      console.log(`  ${lang}/music_items: ${n} músicas`)
    },
    () => musicaMudou(),
  ])

  jobs.push([
    `${lang}/album_items`,
    async () => {
      const ids = INCREMENTAL
        ? idsMudados('album')
        : (await read<Array<{ id_album: number }>>(`${lang}_albums`)).map((a) => a.id_album)
      let n = 0
      await pool(ids, CONCURRENCY, async (id) => {
        const res = await fetchLegacy(`/${lang}/albums/${id}`)
        if (res.status !== 200) return
        const body = JSON.parse(new TextDecoder().decode(res.body)) as { data: unknown }
        await save(`${lang}_album_${id}`, body.data)
        n++
      })
      console.log(`  ${lang}/album_items: ${n} álbuns`)
    },
    () => albumMudou(),
  ])

  jobs.push([
    `${lang}/collections_online`,
    async () => {
      // Não é alias do /onlinevideos: aquele devolve o dump SQL do Delphi, este
      // devolve { channels, playlists, videos } em JSON, e varia por idioma.
      const res = await fetchLegacy(`/${lang}/collections/online`)
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      await save(`${lang}_collections_online`, JSON.parse(new TextDecoder().decode(res.body)))
      console.log(`  ${lang}/collections_online: ${(res.body.length / 1048576).toFixed(1)}MB`)
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
    () => mudou(`${lang}_categories`) || albumMudou() || musicaMudou(),
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
    () => mudou(`${lang}_categories`) || albumMudou(),
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

const noFiltro = jobs.filter(([name]) => !ONLY || ONLY.test(name))
const selected = INCREMENTAL ? noFiltro.filter(([, , roda]) => (roda ? roda() : true)) : noFiltro

console.log(
  INCREMENTAL
    ? `Snapshot REST incremental — ${selected.length} de ${noFiltro.length} coleções ` +
        `(${changedTables.size} tabelas mudaram)\n`
    : `Snapshot REST completo — ${selected.length} coleções\n`,
)

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
if (failed > 0) process.exitCode = 1

export {}
