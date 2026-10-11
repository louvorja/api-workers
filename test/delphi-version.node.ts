import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareVersions,
  delphiVersionParams,
  type GithubRelease,
  parseVersion,
} from '../scripts/lib/delphi-version.ts'

const release = (tag: string, extra: Partial<GithubRelease> = {}): GithubRelease => {
  const version = tag.replace(/^v/, '')
  const base = `https://github.com/louvorja/desktop/releases/download/${tag}`
  return {
    tag_name: tag,
    assets: [
      {
        name: `LoorJA_Instalador${version}.exe`,
        browser_download_url: `${base}/LoorJA_Instalador${version}.exe`,
      },
      {
        name: `LouvorJA_Instalador${version}.exe`,
        browser_download_url: `${base}/LouvorJA_Instalador${version}.exe`,
      },
    ],
    ...extra,
  }
}

// O que a API antiga anunciava para a versão 26.10.
const announced = {
  versaoES: '26.10.0.0',
  instaladorES: 'setup\\Output\\LoorJA_Instalador26.10.exe',
  es_version: '26.10',
  es_version_software: '26.10',
  es_setup_name: 'LoorJA_Instalador26.10.exe',
  setup_nameES: 'LoorJA_Instalador26.10.exe',
  es_download:
    'https://github.com/louvorja/desktop/releases/download/v26.10/LoorJA_Instalador26.10.exe',
  downloadES:
    'https://github.com/louvorja/desktop/releases/download/v26.10/LoorJA_Instalador26.10.exe',
  versaoPT: '26.10.0.0',
  instaladorPT: 'setup\\Output\\LouvorJA_Instalador26.10.exe',
  pt_version: '26.10',
  pt_version_software: '26.10',
  pt_setup_name: 'LouvorJA_Instalador26.10.exe',
  setup_namePT: 'LouvorJA_Instalador26.10.exe',
  pt_download:
    'https://github.com/louvorja/desktop/releases/download/v26.10/LouvorJA_Instalador26.10.exe',
  downloadPT:
    'https://github.com/louvorja/desktop/releases/download/v26.10/LouvorJA_Instalador26.10.exe',
  versao: '26.10.0.0',
  instalador: 'setup\\Output\\LouvorJA_Instalador26.10.exe',
  download:
    'https://github.com/louvorja/desktop/releases/download/v26.10/LouvorJA_Instalador26.10.exe',
  setup_name: 'LouvorJA_Instalador26.10.exe',
}

test('reproduz exatamente as chaves que a API antiga anunciava', () => {
  assert.deepEqual(delphiVersionParams(release('v26.10'), {}), announced)
})

test('anuncia a versão nova nos dois idiomas', () => {
  const updates = delphiVersionParams(release('v26.11'), announced)
  assert.equal(updates.pt_version, '26.11')
  assert.equal(updates.versaoES, '26.11.0.0')
  assert.equal(
    updates.download,
    'https://github.com/louvorja/desktop/releases/download/v26.11/LouvorJA_Instalador26.11.exe',
  )
  assert.equal(Object.keys(updates).length, Object.keys(announced).length)
})

test('não anuncia pré-lançamento, rascunho, versão igual ou versão anterior', () => {
  assert.deepEqual(delphiVersionParams(release('v26.11', { prerelease: true }), announced), {})
  assert.deepEqual(delphiVersionParams(release('v26.11', { draft: true }), announced), {})
  assert.deepEqual(delphiVersionParams(release('v26.10'), announced), {})
  assert.deepEqual(delphiVersionParams(release('v26.9'), announced), {})
  assert.deepEqual(delphiVersionParams(release('beta'), announced), {})
})

test('sem instalador de um idioma, só o outro é anunciado', () => {
  const onlyPt = release('v26.11')
  onlyPt.assets = onlyPt.assets.filter((asset) => asset.name.startsWith('LouvorJA'))
  const updates = delphiVersionParams(onlyPt, announced)
  assert.equal(updates.pt_version, '26.11')
  assert.equal(updates.es_version, undefined)
})

test('compara versões por número, não por texto', () => {
  assert.ok(
    compareVersions(parseVersion('26.10') as number[], parseVersion('26.9') as number[]) > 0,
  )
  assert.equal(compareVersions([26, 10], [26, 10, 0]), 0)
  assert.equal(parseVersion('v26.11')?.join('.'), '26.11')
  assert.equal(parseVersion('26.x'), null)
})
