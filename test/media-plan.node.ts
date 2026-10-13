import assert from 'node:assert/strict'
import test from 'node:test'
import { type MediaRecord, planMedia } from '../scripts/lib/media-plan.ts'
import { removeDuplicateAudio, syncMediaCopy } from '../scripts/lib/media-sync.ts'

const record = (idFile: number, name: string, fileName: string, type = 'music'): MediaRecord => ({
  idFile,
  type,
  dir: type === 'music' ? '/musics/pt/Álbum' : '/covers',
  name,
  fileName,
})
const audio = (name: string) => `musics/pt/Álbum/${name}`
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0, 1])
const opus = new Uint8Array(Buffer.from('OggS0000OpusHead0000'))

function storageFixture(initial: Record<string, Uint8Array>) {
  const objects = new Map(Object.entries(initial))
  const writes: string[] = []
  const removed: string[] = []
  return {
    objects,
    writes,
    removed,
    async get(key: string, bucket: 'files' | 'originals') {
      return objects.get(`${bucket}/${key}`) ?? null
    },
    async put(key: string, body: Uint8Array, _type: string, bucket: 'files' | 'originals') {
      writes.push(`${bucket}/${key}`)
      objects.set(`${bucket}/${key}`, body)
    },
    async del(key: string) {
      removed.push(key)
      objects.delete(`files/${key}`)
    },
  }
}

test('mantém o formato recebido e os pares históricos Opus/backup MP3', () => {
  const plan = planMedia(
    [record(1, 'A.mp3', 'A.opus'), record(2, 'B.mp3', 'B.mp3'), record(3, 'C.opus', 'C.opus')],
    new Set([audio('A.opus'), audio('B.mp3'), audio('C.opus')]),
    new Set([audio('A.mp3'), audio('B.mp3'), audio('C.opus')]),
  )
  assert.deepEqual(plan, {
    work: [],
    repairs: [],
    duplicates: [],
    withoutOriginal: [],
    missing: [],
  })
})

test('restaura o arquivo recebido do backup sem trocar MP3 por Opus ou BMP por JPEG', () => {
  const plan = planMedia(
    [record(1, 'A.mp3', 'A.mp3'), record(2, 'capa.bmp', 'capa.bmp', 'image_album')],
    new Set(),
    new Set([audio('A.mp3'), 'covers/capa.bmp']),
  )
  assert.deepEqual(plan.work, [
    { key: audio('A.mp3'), source: 'originals', target: 'files' },
    { key: 'covers/capa.bmp', source: 'originals', target: 'files' },
  ])
  assert.deepEqual(plan.repairs, [])
})

test('backup de áudio e imagens preserva a extensão real', () => {
  const plan = planMedia(
    [record(1, 'A.opus', 'A.opus'), record(2, 'fundo.png', 'fundo.png', 'image_music')],
    new Set([audio('A.opus'), 'covers/fundo.png']),
    new Set(),
  )
  assert.deepEqual(plan.work, [
    { key: audio('A.opus'), source: 'files', target: 'originals' },
    { key: 'covers/fundo.png', source: 'files', target: 'originals' },
  ])
  assert.deepEqual(plan.missing, [])
})

test('restaura BMP histórico para Delphi mesmo quando o JPEG web já existe', () => {
  const plan = planMedia(
    [record(1, 'capa.bmp', 'capa.jpg', 'image_album')],
    new Set(['covers/capa.jpg']),
    new Set(['covers/capa.bmp']),
  )
  assert.deepEqual(plan.work, [{ key: 'covers/capa.bmp', source: 'originals', target: 'files' }])
  assert.deepEqual(plan.repairs, [])
  assert.deepEqual(plan.duplicates, [])
})

test('não inventa BMP nem MP3 a partir da mídia convertida', () => {
  const plan = planMedia(
    [record(1, 'A.mp3', 'A.opus'), record(2, 'capa.bmp', 'capa.jpg', 'image_album')],
    new Set([audio('A.opus'), 'covers/capa.jpg']),
    new Set(),
  )
  assert.deepEqual(plan.work, [])
  assert.deepEqual(plan.withoutOriginal, [audio('A.mp3'), 'covers/capa.bmp'])
  assert.deepEqual(plan.missing, ['covers/capa.bmp'])
})

test('repara nome convertido sem objeto usando o formato que realmente existe', () => {
  const plan = planMedia([record(1, 'A.mp3', 'A.opus')], new Set(), new Set([audio('A.mp3')]))
  assert.deepEqual(plan.work, [{ key: audio('A.mp3'), source: 'originals', target: 'files' }])
  assert.deepEqual(plan.repairs, [
    {
      idFile: 1,
      previousFileName: 'A.opus',
      fileName: 'A.mp3',
      key: audio('A.mp3'),
    },
  ])
})

test('MP3 extra só é candidato à remoção com Opus canônico e backup', () => {
  const a = record(1, 'A.mp3', 'A.opus')
  const files = new Set([audio('A.mp3'), audio('A.opus')])
  assert.deepEqual(planMedia([a], files, new Set([audio('A.mp3')])).duplicates, [
    { key: audio('A.mp3'), canonicalKey: audio('A.opus') },
  ])
  assert.deepEqual(planMedia([a], files, new Set()).duplicates, [])
  const originals = new Set<string>()
  const pendingBackup = planMedia([a], files, originals)
  for (const item of pendingBackup.work) {
    if (item.target === 'originals') originals.add(item.key)
  }
  assert.deepEqual(planMedia([a], files, originals).duplicates, [
    { key: audio('A.mp3'), canonicalKey: audio('A.opus') },
  ])
  assert.deepEqual(
    planMedia([a, record(2, 'A.mp3', 'A.mp3')], files, new Set([audio('A.mp3')])).duplicates,
    [],
  )
  assert.deepEqual(
    planMedia([a, record(2, 'A.mp3', 'missing.opus')], files, new Set([audio('A.mp3')])).duplicates,
    [],
  )
  assert.equal(
    planMedia([a, { ...a, idFile: 2 }], files, new Set([audio('A.mp3')])).duplicates.length,
    1,
  )
})

test('copia MP3 e Opus sem transcodificação, confere bytes e preserva backup diferente', async () => {
  for (const [name, body] of [
    ['A.mp3', mp3],
    ['A.opus', opus],
  ] as const) {
    const key = audio(name)
    const storage = storageFixture({ [`files/${key}`]: body })
    await syncMediaCopy({ key, source: 'files', target: 'originals' }, storage)
    assert.deepEqual(storage.objects.get(`originals/${key}`), body)
    assert.deepEqual(storage.writes, [`originals/${key}`])
    storage.objects.set(`originals/${key}`, new Uint8Array([1]))
    await assert.rejects(
      syncMediaCopy({ key, source: 'files', target: 'originals' }, storage),
      /bytes diferentes/,
    )
    assert.equal(storage.writes.length, 1)
  }
})

test('não publica bytes com extensão falsa nem cópia que não conferiu', async () => {
  const key = audio('A.mp3')
  const bad = storageFixture({ [`files/${key}`]: opus })
  await assert.rejects(
    syncMediaCopy({ key, source: 'files', target: 'originals' }, bad),
    /formato diferente/,
  )
  assert.equal(bad.writes.length, 0)
  const corrupted = storageFixture({ [`files/${key}`]: mp3 })
  corrupted.put = async () => {
    corrupted.objects.set(`originals/${key}`, new Uint8Array([1]))
  }
  await assert.rejects(
    syncMediaCopy({ key, source: 'files', target: 'originals' }, corrupted),
    /não conferiu/,
  )
})

test('remoção confirma o backup e a existência atual do Opus antes de apagar MP3', async () => {
  const item = { key: audio('A.mp3'), canonicalKey: audio('A.opus') }
  const storage = storageFixture({
    [`files/${item.key}`]: mp3,
    [`originals/${item.key}`]: mp3,
    [`files/${item.canonicalKey}`]: opus,
  })
  storage.objects.set(`originals/${item.key}`, new Uint8Array([...mp3, 9]))
  await assert.rejects(removeDuplicateAudio(item, storage), /backup diferente/)
  assert.deepEqual(storage.removed, [])
  storage.objects.set(`originals/${item.key}`, mp3)
  storage.objects.delete(`files/${item.canonicalKey}`)
  await assert.rejects(removeDuplicateAudio(item, storage), /arquivo vazio/)
  assert.deepEqual(storage.removed, [])
  storage.objects.set(`files/${item.canonicalKey}`, opus)
  await removeDuplicateAudio(item, storage)
  assert.deepEqual(storage.removed, [item.key])
  assert.deepEqual(storage.objects.get(`originals/${item.key}`), mp3)
})
