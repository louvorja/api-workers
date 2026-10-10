import { describe, expect, it } from 'vitest'
import {
  catalogVersionChanged,
  type ManifestEntry,
  md5,
  nextConfig,
  planJsonDb,
  planRest,
  publishedLogChanged,
} from '../scripts/lib/publication.ts'

const entry = (table: string, hash: string): ManifestEntry => ({
  file: `${table}.json`,
  table,
  path: `/db/${table}`,
  hash,
})

describe('plano de /json_db', () => {
  const published: Record<string, string> = {
    music_1: '{"a":1}',
    music_2: '{"a":2}',
    music_3: '{"a":3}',
    bible_1_1_1: '{"1":"No princípio"}',
  }
  const manifest = [
    entry('music_1', 'hash-da-origem-1'),
    entry('music_2', 'hash-da-origem-2'),
    entry('music_3', 'hash-da-origem-3'),
    entry('bible_1_1_1', 'hash-da-biblia'),
  ]
  const read = (table: string) => published[table] ?? null

  it('não regrava o conteúdo e normaliza hashes antigos do manifesto', () => {
    const plan = planJsonDb(new Map(Object.entries(published).slice(0, 3)), read, manifest)
    expect(plan.puts).toEqual([])
    expect(plan.deletes).toEqual([])
    expect(plan.manifest).toEqual([
      entry('music_1', md5('{"a":1}')),
      entry('music_2', md5('{"a":2}')),
      entry('music_3', md5('{"a":3}')),
      entry('bible_1_1_1', 'hash-da-biblia'),
    ])
    expect(plan.manifestChanged).toBe(true)
  })

  it('regrava o que mudou, inclui o novo e apaga o que saiu do banco', () => {
    const generated = new Map([
      ['music_1', '{"a":1}'],
      ['music_2', '{"a":"novo"}'],
      ['music_9', '{"a":9}'],
    ])
    const plan = planJsonDb(generated, read, manifest)

    expect(plan.changed).toEqual(['music_2'])
    expect(plan.added).toEqual(['music_9'])
    expect(plan.removed).toEqual(['music_3'])
    expect(plan.puts.map((p) => p.key)).toEqual(['json_db/music_2.json', 'json_db/music_9.json'])
    expect(plan.deletes).toEqual(['json_db/music_3.json'])
    expect(plan.manifest).toEqual([
      entry('music_1', md5('{"a":1}')),
      entry('music_2', md5('{"a":"novo"}')),
      entry('bible_1_1_1', 'hash-da-biblia'),
      entry('music_9', md5('{"a":9}')),
    ])
  })

  it('nunca apaga capítulo da Bíblia, que não é gerado', () => {
    const plan = planJsonDb(new Map(), read, manifest)
    expect(plan.removed).toEqual(['music_1', 'music_2', 'music_3'])
    expect(plan.manifest).toEqual([entry('bible_1_1_1', 'hash-da-biblia')])
  })

  it('repara entrada ausente após ZIP publicado sem reenviar o JSON', () => {
    const current = new Map([
      ['music_1', '{"a":1}'],
      ['music_9', '{"a":9}'],
    ])
    const brokenManifest = [entry('music_1', md5('{"a":1}'))]
    const plan = planJsonDb(current, (table) => current.get(table) ?? null, brokenManifest)

    expect(plan.puts).toEqual([])
    expect(plan.manifestChanged).toBe(true)
    expect(plan.manifest).toEqual([
      entry('music_1', md5('{"a":1}')),
      entry('music_9', md5('{"a":9}')),
    ])
  })
})

describe('plano da camada REST', () => {
  it('envia tudo na primeira vez e depois só o que mudou', () => {
    const first = planRest(
      new Map([
        ['pt_musics', '[1]'],
        ['pt_music_1', '{}'],
      ]),
      {},
    )
    expect(first.added).toEqual(['pt_musics', 'pt_music_1'])
    expect(first.puts).toHaveLength(2)

    const second = planRest(
      new Map([
        ['pt_musics', '[1,2]'],
        ['pt_music_1', '{}'],
        ['pt_music_2', '{}'],
      ]),
      first.state,
    )
    expect(second.changed).toEqual(['pt_musics'])
    expect(second.added).toEqual(['pt_music_2'])
    expect(second.puts.map((p) => p.key)).toEqual(['rest/pt_musics.json', 'rest/pt_music_2.json'])
  })

  it('apaga o registro da música que foi excluída', () => {
    const plan = planRest(new Map([['pt_musics', '[]']]), {
      pt_musics: md5('[]'),
      pt_music_7: md5('{}'),
    })
    expect(plan.puts).toEqual([])
    expect(plan.deletes).toEqual(['rest/pt_music_7.json'])
    expect(plan.state).toEqual({ pt_musics: md5('[]') })
  })
})

describe('versão do catálogo', () => {
  it('detecta tabelas fora do bundle pelo updated_at, como vídeos online', () => {
    expect(catalogVersionChanged(1_787_701_723, '2026-08-25 23:48:43')).toBe(false)
    expect(catalogVersionChanged(1_787_701_723, '2026-10-10 20:30:00')).toBe(true)
  })

  it('reproduz o par que a origem publicou', () => {
    // A origem publicou latest_updated "2026-08-25 20:48:43" com version
    // 1787701723: a data é de São Paulo, e no D1 ela está em UTC.
    const next = nextConfig({ version_number: 184 }, '2026-08-25 23:48:43', new Date())
    expect(next.version).toBe(1787701723)
    expect(next.latest_updated).toBe('2026-08-25 20:48:43')
    expect(next.version_number).toBe(185)
  })

  it('sobe o número em um e registra a hora da publicação no fuso da origem', () => {
    const next = nextConfig(
      { version_number: 185, version: 1787701723, pt_delphi_version: '26.10' },
      '2026-10-10 16:42:36',
      new Date('2026-10-11T02:00:05Z'),
    )
    expect(next).toEqual({
      version_number: 186,
      version: 1791650556,
      latest_updated: '2026-10-10 13:42:36',
      date: '2026-10-10',
      time: '23:00:05',
      datetime: '2026-10-10 23:00:05',
      pt_delphi_version: '26.10',
    })
  })
})

// A rotina de hora em hora só exporta o banco quando esta pergunta diz que sim.
describe('marca da última publicação', () => {
  it('não vê alteração quando a auditoria está onde a publicação a deixou', () => {
    expect(publishedLogChanged(42, JSON.stringify({ id_log: 42 }))).toBe(false)
    expect(publishedLogChanged(0, JSON.stringify({ id_log: 0 }))).toBe(false)
  })

  it('vê alteração quando o painel gravou algo depois', () => {
    expect(publishedLogChanged(43, JSON.stringify({ id_log: 42 }))).toBe(true)
  })

  it('na dúvida publica: marca ausente, ilegível ou de outro formato', () => {
    expect(publishedLogChanged(0, null)).toBe(true)
    expect(publishedLogChanged(7, 'não é json')).toBe(true)
    expect(publishedLogChanged(7, JSON.stringify({ id_log: '7' }))).toBe(true)
    expect(publishedLogChanged(7, JSON.stringify({}))).toBe(true)
  })
})
