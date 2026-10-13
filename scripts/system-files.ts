import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as r2 from './lib/r2.ts'
import {
  acknowledgeSystemFiles,
  canReuseSystemState,
  MAX_INSTALLER_BYTES,
  parseSystemState,
  prepareSystemFiles,
  resolveSystemSourcePin,
  SYSTEM_REPOSITORY,
  SYSTEM_STATE_KEY,
  syncSystemFiles,
  systemSourceUrl,
} from './lib/system-files.ts'

async function download(url: string, maxBytes: number, authenticated = false): Promise<Uint8Array> {
  const headers: Record<string, string> = { 'User-Agent': 'LouvorJA-system-files' }
  if (authenticated) {
    headers.Accept = 'application/vnd.github+json'
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
    if (token) headers.Authorization = `Bearer ${token}`
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw new Error(`GET ${url}: HTTP ${response.status}`)
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body.cancel()
    throw new Error(`GET ${url}: arquivo excede o limite`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error(`GET ${url}: arquivo excede o limite`)
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks)
}

async function githubJson(path: string): Promise<unknown> {
  return JSON.parse(
    new TextDecoder().decode(
      await download(
        `https://api.github.com/repos/${SYSTEM_REPOSITORY}/${path}`,
        2 * 1024 * 1024,
        true,
      ),
    ),
  )
}

async function extractInstaller(installer: Uint8Array, paths: string[]) {
  const workdir = mkdtempSync(join(tmpdir(), 'louvorja-system-files-'))
  try {
    const archive = join(workdir, 'installer.exe')
    const destination = join(workdir, 'extracted')
    writeFileSync(archive, installer)
    execFileSync(
      process.env.INNOEXTRACT_BIN || 'innoextract',
      [
        '--extract',
        '--silent',
        '--output-dir',
        destination,
        ...paths.flatMap((path) => ['--include', path]),
        archive,
      ],
      { stdio: 'inherit', timeout: 120_000 },
    )
    return new Map(
      paths.map((path) => {
        const file = join(destination, path)
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.size > MAX_INSTALLER_BYTES)
          throw new Error(`${path}: extração inválida`)
        return [path, readFileSync(file)]
      }),
    )
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

async function cli() {
  const args = new Map(
    process.argv.slice(2).map((arg) => {
      const [key, ...value] = arg.replace(/^--/, '').split('=')
      return [key!, value.join('=')]
    }),
  )
  if (args.has('help')) {
    console.log(
      'Uso: scripts/system-files.ts [--write] [--force] [--report=system-files-report.json] | --acknowledge-db=<manifest_sha256> [--write]',
    )
    return
  }
  const write = args.has('write')
  for (const name of ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    if (!process.env[name]) throw new Error(`${name} não configurado`)
  }
  if (process.env.R2_BUCKET && process.env.R2_BUCKET !== 'files')
    throw new Error('arquivos de sistema só podem ser publicados no bucket files')
  if (args.has('acknowledge-db')) {
    await acknowledgeSystemFiles(r2, args.get('acknowledge-db')!, write)
    console.log(
      write
        ? 'Banco Delphi confirmado para o manifesto de sistema.'
        : 'Simulação: confirmação do banco validada.',
    )
    return
  }
  const [release, commit] = await Promise.all([
    githubJson('releases/latest'),
    githubJson('commits/main'),
  ])
  const sources = resolveSystemSourcePin(release, commit)
  const previous = parseSystemState(await r2.get(SYSTEM_STATE_KEY))
  const sizes = await r2.listWithSizes('system/')
  const now = new Date()
  const reused = canReuseSystemState(previous, sources, sizes, now, args.has('force'))
  let result
  if (reused) {
    result = { state: previous, changed: false, changedKeys: [], written: false }
  } else {
    const installer = await download(sources.asset_url, MAX_INSTALLER_BYTES)
    const prepared = await prepareSystemFiles(sources, installer, extractInstaller, (file, sha) =>
      download(systemSourceUrl(file, sha), 8 * 1024 * 1024),
    )
    result = await syncSystemFiles(prepared, r2, { write, now })
  }
  const report = { ...result, reused }
  writeFileSync(
    resolve(args.get('report') || 'system-files-report.json'),
    JSON.stringify(report, null, 2),
  )
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${result.changed}\nmanifest_sha256=${result.state.manifest_sha256}\n`,
    )
  console.log(
    `${result.state.files.length} arquivos validados; ${result.changedKeys.length} conteúdo(s) alterado(s); banco Delphi pendente: ${result.changed}.`,
  )
  if (!write) console.log('Simulação: nenhum arquivo publicado. Use --write para aplicar.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
