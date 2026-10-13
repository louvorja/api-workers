/** Repara só os nomes/tamanhos de mídia dos snapshots REST já publicados. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pool } from './lib/legacy.ts'
import * as r2 from './lib/r2.ts'
import { reconcileRestMedia } from './lib/rest-media.ts'

const write = process.argv.includes('--write')
const workdir = mkdtempSync(join(tmpdir(), 'louvorja-rest-media-'))
mkdirSync(join(workdir, 'before'))
mkdirSync(join(workdir, 'after'))
console.log(`Cópia de segurança e plano: ${workdir}`)

const [keys, current] = await Promise.all([r2.list('rest/'), r2.mediaSizes()])
const puts: { key: string; before: Uint8Array | null; after: string }[] = []
let inspected = 0
await pool(
  keys.filter((key) => key.endsWith('.json') && !key.endsWith('_files_legacy.json')),
  8,
  async (key) => {
    const before = await r2.get(key)
    if (before === null) throw new Error(`Snapshot desapareceu: ${key}`)
    const text = new TextDecoder().decode(before)
    const after = reconcileRestMedia(text, current)
    if (after !== text) puts.push({ key, before, after })
    if (++inspected % 500 === 0) console.log(`${inspected} snapshots conferidos`)
  },
)
puts.sort((a, b) => a.key.localeCompare(b.key))
for (const put of puts) {
  const name = put.key.slice('rest/'.length)
  if (put.before !== null) writeFileSync(join(workdir, 'before', name), put.before)
  writeFileSync(join(workdir, 'after', name), put.after)
}
const hash = (body: Uint8Array | null) =>
  body === null ? null : createHash('sha256').update(body).digest('hex')
writeFileSync(
  join(workdir, 'plan.json'),
  JSON.stringify(
    puts.map((p) => ({ key: p.key, before: hash(p.before) })),
    null,
    2,
  ),
)
console.log(`${inspected} snapshots validados; ${puts.length} objetos a gravar.`)
if (!write) {
  console.log('Simulação: nada foi enviado (use --write).')
} else {
  // Revalida todo o plano antes da primeira escrita: não sobrescreve uma
  // publicação que tenha ocorrido durante a leitura dos snapshots.
  await pool(puts, 8, async (put) => {
    if (hash(await r2.get(put.key)) !== hash(put.before))
      throw new Error(`Snapshot alterado: ${put.key}`)
  })
  await pool(puts, 8, async (put) => {
    await r2.put(put.key, put.after, 'application/json')
    const stored = await r2.get(put.key)
    if (new TextDecoder().decode(stored ?? undefined) !== put.after)
      throw new Error(`Verificação falhou: ${put.key}`)
  })
  console.log(`${puts.length} objetos enviados e relidos; backup preservado em ${workdir}.`)
}
