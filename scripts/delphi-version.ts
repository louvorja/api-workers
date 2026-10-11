/**
 * Anuncia em /params a versão mais recente do LouvorJA Delphi, lida do último
 * lançamento final de louvorja/desktop no GitHub. Publicar o lançamento lá
 * passa a ser o próprio aviso de versão nova.
 *
 *   npm run delphi:version            # só mostra o que mudaria
 *   npm run delphi:version -- --write # grava meta/params.json
 *
 * Pré-lançamentos e rascunhos são ignorados, e a versão nunca volta para trás.
 */
import { delphiVersionParams, type GithubRelease } from './lib/delphi-version.ts'
import * as r2 from './lib/r2.ts'

const WRITE = process.argv.includes('--write')
const REPOSITORY = process.env.DELPHI_RELEASES_REPO ?? 'louvorja/desktop'
const PARAMS_KEY = 'meta/params.json'

const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
  headers: {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'louvorja-api-workers',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  },
  signal: AbortSignal.timeout(20_000),
})
if (!response.ok) throw new Error(`GitHub respondeu ${response.status} para ${REPOSITORY}`)
const release = (await response.json()) as GithubRelease

const body = await r2.get(PARAMS_KEY)
if (body === null) throw new Error(`${PARAMS_KEY} não existe no bucket`)
const params = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>

const updates = delphiVersionParams(release, params)
const changed = Object.entries(updates).filter(([key, value]) => params[key] !== value)
console.log(
  `último lançamento final: ${release.tag_name} | anunciado hoje: pt ${String(params.pt_version)}, ` +
    `es ${String(params.es_version)}`,
)
if (changed.length === 0) {
  console.log('Nada a anunciar.')
} else {
  for (const [key, value] of changed) console.log(`  ${key}: ${String(params[key])} → ${value}`)
  if (WRITE) {
    await r2.put(PARAMS_KEY, JSON.stringify({ ...params, ...updates }), 'application/json')
    console.log('Gravado em meta/params.json.')
  } else {
    console.log('Simulação: nada foi gravado (use --write).')
  }
}
