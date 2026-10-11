import assert from 'node:assert/strict'
import test from 'node:test'
import { nominalKbps, opusTargetKbps } from '../scripts/lib/media-convert.ts'
import { type MediaRecord, planMedia, withExtension } from '../scripts/lib/media-plan.ts'

const record = (idFile: number, name: string, fileName: string, type = 'music'): MediaRecord => ({
  idFile,
  type,
  dir: type === 'music' ? '/musics/pt/Álbum' : '/covers',
  name,
  fileName,
})

test('não mexe no que já tem o original e a versão dos apps', () => {
  const plan = planMedia(
    [record(1, 'A.mp3', 'A.opus'), record(2, 'B.mp3', 'B.mp3')],
    new Set(['musics/pt/Álbum/A.opus', 'musics/pt/Álbum/B.mp3']),
    new Set(['musics/pt/Álbum/A.mp3', 'musics/pt/Álbum/B.mp3']),
  )
  assert.deepEqual(plan, { work: [], withoutOriginal: [], missing: [] })
})

test('original enviado ao bucket dos originais: falta gerar a versão dos apps', () => {
  const plan = planMedia(
    [record(1, 'A.mp3', 'A.mp3'), record(2, 'capa.bmp', 'capa.jpg', 'image_album')],
    new Set(),
    new Set(['musics/pt/Álbum/A.mp3', 'covers/capa.bmp']),
  )
  assert.deepEqual(plan.work, [
    {
      idFile: 1,
      type: 'music',
      originalKey: 'musics/pt/Álbum/A.mp3',
      storedKey: 'musics/pt/Álbum/A.mp3',
      source: 'originals',
      copyOriginal: false,
    },
    {
      idFile: 2,
      type: 'image_album',
      originalKey: 'covers/capa.bmp',
      storedKey: 'covers/capa.jpg',
      source: 'originals',
      copyOriginal: false,
    },
  ])
})

test('apresentação importada: o arquivo em files é o original e precisa ser guardado', () => {
  const plan = planMedia(
    [record(1, 'A.mp3', 'A.mp3')],
    new Set(['musics/pt/Álbum/A.mp3']),
    new Set(),
  )
  assert.deepEqual(plan.work, [
    {
      idFile: 1,
      type: 'music',
      originalKey: 'musics/pt/Álbum/A.mp3',
      storedKey: 'musics/pt/Álbum/A.mp3',
      source: 'files',
      copyOriginal: true,
    },
  ])
})

test('separa o que não tem conserto: só a versão convertida, ou arquivo nenhum', () => {
  const plan = planMedia(
    [record(1, 'A.mp3', 'A.opus'), record(2, 'B.mp3', 'B.opus')],
    new Set(['musics/pt/Álbum/A.opus']),
    new Set(),
  )
  assert.deepEqual(plan.work, [])
  assert.deepEqual(plan.withoutOriginal, ['musics/pt/Álbum/A.mp3'])
  assert.deepEqual(plan.missing, ['musics/pt/Álbum/B.mp3'])
})

test('regra de conversão: até 128k fica em MP3; acima vira Opus na escada', () => {
  assert.equal(nominalKbps(128.04), 128)
  assert.equal(nominalKbps(191.7), 192)
  assert.equal(opusTargetKbps(160), 112)
  assert.equal(opusTargetKbps(192), 128)
  assert.equal(opusTargetKbps(320), 128)
  assert.equal(withExtension('Santo, Santo - PB.mp3', 'opus'), 'Santo, Santo - PB.opus')
  assert.equal(withExtension('pode.cair...mp3', 'opus'), 'pode.cair...opus')
})
