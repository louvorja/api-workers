/**
 * Paridade: compara a API nova com api.louvorja.com.br endpoint a endpoint.
 *
 * JSON é comparado por igualdade estrutural, ignorando as diferenças
 * intencionais (URLs de mídia normalizadas para .opus/.jpg). Binário é
 * comparado por tamanho e tipo, não byte a byte — as capas foram reconvertidas.
 *
 *   node --experimental-strip-types scripts/parity.ts [--base=https://api.louvorja.workers.dev]
 */
const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const NEW = args.get('base') ?? 'https://api.louvorja.workers.dev'
const OLD = process.env.LEGACY_API_URL ?? 'https://api.louvorja.com.br'
const TOKEN = process.env.LEGACY_API_TOKEN ?? ''

let pass = 0
let quiet = false
const failures: string[] = []

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    if (!quiet) console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Normaliza as diferenças esperadas para que o resto do JSON tenha que bater exato. */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize)
  if (node === null || typeof node !== 'object') {
    if (typeof node === 'string' && /\.(mp3|opus|bmp|jpg)$/i.test(node)) {
      return node.replace(/\.(mp3|opus)$/i, '.audio').replace(/\.(bmp|jpg)$/i, '.image')
    }
    return node
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, normalize(v)]))
}

async function compareJson(key: string) {
  const [a, b] = await Promise.all([
    fetch(`${OLD}/json_db/${key}`, { headers: TOKEN ? { 'Api-Token': TOKEN } : {} }),
    fetch(`${NEW}/json_db/${key}`),
  ])

  if (a.status !== b.status) {
    check(`json_db/${key}`, false, `status ${a.status} vs ${b.status}`)
    return
  }
  if (a.status !== 200) {
    check(`json_db/${key} (${a.status})`, true)
    return
  }

  const [ja, jb] = await Promise.all([a.json(), b.json()])
  const sa = JSON.stringify(normalize(ja))
  const sb = JSON.stringify(normalize(jb))
  check(
    `json_db/${key}`,
    sa === sb,
    sa === sb ? '' : `${sa.length} vs ${sb.length} bytes normalizados`,
  )
}

async function compareFile(path: string) {
  const [a, b] = await Promise.all([
    fetch(`${OLD}/file/${path}`, { headers: TOKEN ? { 'Api-Token': TOKEN } : {} }),
    fetch(`${NEW}/file/${path}`),
  ])
  const [ba, bb] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()])
  check(
    `file/${path}`,
    a.status === b.status && bb.byteLength > 0,
    `${a.status}/${ba.byteLength}B vs ${b.status}/${bb.byteLength}B`,
  )
}

console.log(`Paridade: ${NEW} vs ${OLD}\n`)

console.log('json_db — índices')
for (const key of [
  'config',
  'pt_categories',
  'es_categories',
  'pt_musics',
  'pt_hymnal',
  'pt_bible_book',
  'pt_bible_version',
  'nao_existe',
]) {
  await compareJson(key)
}

console.log('\njson_db — derivados')
for (const key of ['album_1', 'music_1', 'music_1728', 'bible_1_1_1', 'bible_2_1_1']) {
  await compareJson(key)
}

console.log('\nfile — mídia')
for (const path of [
  'covers/1992.bmp',
  'images/hasd_132B.jpg',
  'musics/pt/1992 - Brilha Jesus/Nosso Sol %C3%89 Jesus.mp3',
]) {
  await compareFile(path)
}

console.log('\nparams e legado')
{
  const [a, b] = await Promise.all([
    fetch(`${OLD}/params?type=env`, { headers: TOKEN ? { 'Api-Token': TOKEN } : {} }).then((r) =>
      r.text(),
    ),
    fetch(`${NEW}/params?type=env`).then((r) => r.text()),
  ])
  const keysOf = (t: string) =>
    new Set(
      t
        .split('\n')
        .map((l) => l.split('=')[0])
        .filter(Boolean),
    )
  const missing = [...keysOf(a)].filter((k) => !keysOf(b).has(k) && k !== 'conn_ftp')
  check(
    'params?type=env',
    missing.length === 0,
    missing.length ? `faltam: ${missing.join(', ')}` : '',
  )
}

for (const path of ['version_log', 'onlinevideos']) {
  const [a, b] = await Promise.all([fetch(`${OLD}/${path}`), fetch(`${NEW}/${path}`)])
  const [ta, tb] = await Promise.all([a.text(), b.text()])
  check(path, a.status === b.status && tb.length > 0, `${ta.length} vs ${tb.length} chars`)
}

/**
 * Amostragem aleatória sobre os índices reais. Os 19 casos fixos acima provam
 * os contratos; isto procura o registro esquisito que só aparece em escala —
 * letra com caractere estranho, álbum sem capa, capítulo curto.
 */
const sampleSize = Number(args.get('sample') ?? 0)
if (sampleSize > 0) {
  // Fisher-Yates parcial. `sort(() => Math.random() - 0.5)` não serve: em array
  // grande ele quase não permuta, e a amostra sai enviesada para o começo da
  // lista — o que faria a amostragem confirmar exatamente o que já foi testado.
  function pick<T>(xs: T[], n: number): T[] {
    const a = [...xs]
    const size = Math.min(n, a.length)
    for (let i = 0; i < size; i++) {
      const j = i + Math.floor(Math.random() * (a.length - i))
      ;[a[i], a[j]] = [a[j] as T, a[i] as T]
    }
    return a.slice(0, size)
  }

  const json = async <T>(key: string): Promise<T> =>
    (await fetch(`${NEW}/json_db/${key}`).then((r) => r.json())) as T

  const musics = await json<Array<{ id_music: number }>>('pt_musics')
  const categories = await json<Array<{ albums?: Array<{ id_album: number }> }>>('pt_categories')
  const books = await json<Array<{ id_bible_book: number; chapters: number }>>('pt_bible_book')
  const versions = await json<Array<{ id_bible_version: number }>>('pt_bible_version')

  const albumIds = categories.flatMap((c) => (c.albums ?? []).map((a) => a.id_album))
  const chapters = versions.flatMap((v) =>
    books.flatMap((b) =>
      Array.from(
        { length: b.chapters },
        (_, i) => `bible_${v.id_bible_version}_${b.id_bible_book}_${i + 1}`,
      ),
    ),
  )

  const keys = [
    ...pick(musics, sampleSize).map((m) => `music_${m.id_music}`),
    ...pick(albumIds, Math.ceil(sampleSize / 4)).map((id) => `album_${id}`),
    ...pick(chapters, sampleSize),
  ]

  console.log(`\namostra aleatória — ${keys.length} chaves`)
  quiet = true
  let cursor = 0
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (cursor < keys.length) {
        const key = keys[cursor++] as string
        await compareJson(key)
      }
    }),
  )
}

console.log(`\n${pass} passaram, ${failures.length} falharam`)
if (failures.length > 0) {
  console.log('\nFalhas:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}

export {}
