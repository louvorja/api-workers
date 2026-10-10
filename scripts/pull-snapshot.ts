/**
 * Baixa do R2 o retrato que o seed-d1.ts transforma na carga inicial do D1.
 * Vai direto ao bucket pela API S3, então não consome requisições do Worker.
 *
 *   node --env-file=.env --experimental-strip-types scripts/pull-snapshot.ts [--out=snapshot]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pool } from './lib/legacy.ts'
import * as r2 from './lib/r2.ts'

const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const OUT = args.get('out') ?? 'snapshot'
const LANGS = ['pt', 'es']

const keys = [
  'rest/pt_languages.json',
  'rest/pt_files.json',
  'rest/pt_config.json',
  ...LANGS.flatMap((lang) => [
    ...[
      'musics',
      'albums',
      'categories',
      'lyrics',
      'albums_musics',
      'categories_albums',
      'collections_online',
    ].map((collection) => `rest/${lang}_${collection}.json`),
    `json_db/${lang}_bible_version.json`,
    `json_db/${lang}_bible_book.json`,
  ]),
]

async function download(key: string): Promise<string> {
  const body = await r2.get(key)
  if (body === null) throw new Error(`${key} não existe no bucket`)
  const path = join(OUT, key)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  console.log(`  ${key}: ${(body.length / 1024).toFixed(0)} KB`)
  return path
}

for (const key of keys) await download(key)

// O registro de cada música: é onde estão as datas das letras.
const items = (await r2.list('rest/')).filter((key) => /_music_\d+\.json$/.test(key))
await pool(items, 12, async (key) => {
  const body = await r2.get(key)
  if (body === null) throw new Error(`${key} não existe no bucket`)
  writeFileSync(join(OUT, key), body)
})
console.log(`  ${items.length} registros de música`)

// Chave e tamanho de cada mídia: é o que diz se a faixa está em .opus ou .mp3.
const media: Record<string, number> = {}
for (const prefix of ['musics/', 'images/', 'covers/']) {
  for (const [key, size] of await r2.listWithSizes(prefix)) media[key] = size
}
writeFileSync(join(OUT, 'bucket-keys.json'), JSON.stringify(media))
console.log(`  bucket-keys.json: ${Object.keys(media).length} objetos de mídia`)

const zip = await download('meta/bible-bundle.zip')
mkdirSync(join(OUT, 'bible'), { recursive: true })
execFileSync('unzip', ['-qq', '-o', zip, '-d', join(OUT, 'bible')])
console.log(`\nRetrato em ${OUT}/`)

export {}
