import { createHash } from 'node:crypto'

export const SYSTEM_REPOSITORY = 'louvorja/desktop'
export const SYSTEM_STATE_KEY = 'state/system-files.json'
export const SYSTEM_VERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000
export const MAX_INSTALLER_BYTES = 128 * 1024 * 1024

export const SYSTEM_FILES = [
  { id: '1', path: 'config/1minuto_escsb.mp3' },
  { id: '2', path: 'config/5minutos_escsb.mp3' },
  { id: '3', path: 'config/abertura_escsb.mp3' },
  { id: '4', path: 'config/fontes/din-condensed-bold.ttf' },
  { id: '6', path: 'bass.dll' },
  { id: '7', path: 'borlndmm.dll' },
  { id: '8', path: 'midas.dll' },
  { id: '10', path: 'LouvorJA.exe' },
  { id: '11', path: 'ssleay32.dll' },
  { id: '12', path: 'libeay32.dll' },
  { id: '13', path: 'config/ico/louvorja_slja.ico' },
  { id: '14', path: 'bassopus.dll', source: 'components/bass24/bassopus.dll' },
  { id: '15', path: 'config/server/404.html', source: 'server/404.html' },
  { id: '16', path: 'config/server/api-v2.html', source: 'server/api-v2.html' },
  { id: '17', path: 'config/server/index.html', source: 'server/index.html' },
  { id: '18', path: 'config/server/mirror.html', source: 'server/mirror.html' },
] as const

export type SystemFile = (typeof SYSTEM_FILES)[number]
export type SystemSourcePin = {
  release_id: number
  release_tag: string
  asset_id: number
  asset_url: string
  asset_size: number
  asset_sha256: string | null
  source_commit: string
}
export type SystemArtifact = {
  key: string
  size: number
  sha256: string
  content_type: string
  provenance:
    | {
        kind: 'github-release-installer'
        url: string
        archive_path: string
        installer_sha256: string
      }
    | { kind: 'github-source'; url: string; repository_path: string; commit: string }
}
export type PreparedSystemFiles = {
  sources: SystemSourcePin
  files: SystemArtifact[]
  bodies: Map<string, Uint8Array>
}
export type SystemState = {
  schema_version: 1
  sources: SystemSourcePin
  manifest_sha256: string
  files: SystemArtifact[]
  verified_at: string
  pending_delphi_db: boolean
}
export type SystemStorage = {
  get: (key: string) => Promise<Uint8Array | null>
  put: (key: string, body: Uint8Array | string, contentType: string) => Promise<unknown>
}

export const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('metadados de sistema inválidos')
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error('ID ou tamanho inválido nos metadados de sistema')
  return Number(value)
}

function nonemptyText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('texto inválido nos metadados de sistema')
  return value
}

function hash(value: unknown, length = 64): string {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(value))
    throw new Error('SHA inválido nos metadados de sistema')
  return value
}

export function resolveSystemSourcePin(
  releaseValue: unknown,
  commitValue: unknown,
): SystemSourcePin {
  const release = record(releaseValue)
  if (release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets))
    throw new Error('a origem precisa ser um release final publicado')
  const assets = release.assets
    .map(record)
    .filter((asset) => /^LouvorJA_Instalador[\d.]+\.exe$/.test(String(asset.name)))
  if (assets.length !== 1) throw new Error('release precisa ter exatamente um instalador LouvorJA')
  const asset = assets[0]!
  const tag = nonemptyText(release.tag_name)
  const url = nonemptyText(asset.browser_download_url)
  if (
    url !==
    `https://github.com/${SYSTEM_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${asset.name}`
  )
    throw new Error('URL do instalador fora do release oficial')
  const size = positiveInteger(asset.size)
  if (size > MAX_INSTALLER_BYTES) throw new Error('instalador excede o limite de tamanho')
  return {
    release_id: positiveInteger(release.id),
    release_tag: tag,
    asset_id: positiveInteger(asset.id),
    asset_url: url,
    asset_size: size,
    asset_sha256: asset.digest == null ? null : hash(String(asset.digest).replace(/^sha256:/, '')),
    source_commit: hash(record(commitValue).sha, 40),
  }
}

export function systemSourcePath(file: SystemFile): string {
  return 'source' in file ? file.source : `app/${file.path}`
}

export function systemSourceUrl(file: SystemFile, commit: string): string {
  hash(commit, 40)
  if (!('source' in file)) throw new Error('arquivo deve vir do instalador oficial')
  return `https://raw.githubusercontent.com/${SYSTEM_REPOSITORY}/${commit}/${file.source}`
}

export function validateSystemFile(path: string, body: Uint8Array): string {
  const bytes = Buffer.from(body)
  const extension = path.split('.').pop()
  const limit =
    extension === 'exe'
      ? MAX_INSTALLER_BYTES
      : extension === 'mp3'
        ? 64 * 1024 * 1024
        : 8 * 1024 * 1024
  if (bytes.length < 32 || bytes.length > limit) throw new Error(`${path}: tamanho inválido`)
  let valid = false
  let contentType = 'application/octet-stream'
  if (extension === 'exe' || extension === 'dll') {
    const pe = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0
    valid =
      bytes.toString('ascii', 0, 2) === 'MZ' &&
      pe >= 64 &&
      pe + 4 <= bytes.length &&
      bytes.toString('ascii', pe, pe + 4) === 'PE\0\0'
  } else if (extension === 'mp3') {
    valid =
      bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
    contentType = 'audio/mpeg'
  } else if (extension === 'ttf') {
    valid = bytes.readUInt32BE(0) === 0x00010000 || bytes.toString('ascii', 0, 4) === 'true'
    contentType = 'font/ttf'
  } else if (extension === 'ico') {
    valid = bytes.readUInt32LE(0) === 0x00010000 && bytes.readUInt16LE(4) > 0
    contentType = 'image/x-icon'
  } else if (extension === 'html') {
    const html = bytes.toString('utf8').trimStart()
    valid = /^(?:<!doctype html\b[^>]*>\s*)?<html\b/i.test(html) && /<\/html\s*>/i.test(html)
    contentType = 'text/html; charset=utf-8'
  }
  if (!valid) throw new Error(`${path}: assinatura inválida`)
  return contentType
}

export async function prepareSystemFiles(
  sources: SystemSourcePin,
  installer: Uint8Array,
  extract: (installer: Uint8Array, paths: string[]) => Promise<Map<string, Uint8Array>>,
  readSource: (file: SystemFile, commit: string) => Promise<Uint8Array>,
): Promise<PreparedSystemFiles> {
  validateSystemFile('installer.exe', installer)
  const installerHash = sha256(installer)
  if (
    installer.byteLength !== sources.asset_size ||
    (sources.asset_sha256 && installerHash !== sources.asset_sha256)
  )
    throw new Error('tamanho ou SHA256 do instalador difere do release oficial')
  const extracted = await extract(
    installer,
    SYSTEM_FILES.filter((file) => !('source' in file)).map(systemSourcePath),
  )
  const bodies = new Map<string, Uint8Array>()
  const files: SystemArtifact[] = []
  for (const file of SYSTEM_FILES) {
    const fromSource = 'source' in file
    const body = fromSource
      ? await readSource(file, sources.source_commit)
      : extracted.get(systemSourcePath(file))
    if (!body) throw new Error(`${systemSourcePath(file)} ausente no instalador`)
    const key = `system/${file.path}`
    const contentType = validateSystemFile(file.path, body)
    bodies.set(key, body)
    files.push({
      key,
      size: body.byteLength,
      sha256: sha256(body),
      content_type: contentType,
      provenance: fromSource
        ? {
            kind: 'github-source',
            url: systemSourceUrl(file, sources.source_commit),
            repository_path: systemSourcePath(file),
            commit: sources.source_commit,
          }
        : {
            kind: 'github-release-installer',
            url: sources.asset_url,
            archive_path: systemSourcePath(file),
            installer_sha256: installerHash,
          },
    })
  }
  return { sources, files, bodies }
}

function manifestHash(files: SystemArtifact[]): string {
  return sha256(
    JSON.stringify(files.map(({ key, size, sha256: digest }) => ({ key, size, sha256: digest }))),
  )
}

export function parseSystemState(body: Uint8Array | null): SystemState | null {
  if (body === null) return null
  const state = record(JSON.parse(new TextDecoder().decode(body)))
  const sources = record(state.sources)
  if (
    state.schema_version !== 1 ||
    !Array.isArray(state.files) ||
    state.files.length !== SYSTEM_FILES.length ||
    typeof state.pending_delphi_db !== 'boolean'
  )
    throw new Error('estado dos arquivos de sistema inválido')
  positiveInteger(sources.release_id)
  nonemptyText(sources.release_tag)
  positiveInteger(sources.asset_id)
  positiveInteger(sources.asset_size)
  if (sources.asset_sha256 !== null) hash(sources.asset_sha256)
  hash(sources.source_commit, 40)
  if (
    !nonemptyText(sources.asset_url).startsWith(
      `https://github.com/${SYSTEM_REPOSITORY}/releases/download/`,
    )
  )
    throw new Error('URL do instalador inválida no estado')
  if (!Number.isFinite(Date.parse(nonemptyText(state.verified_at))))
    throw new Error('data inválida no estado')
  for (const [index, value] of state.files.entries()) {
    const file = record(value)
    const definition = SYSTEM_FILES[index]!
    if (file.key !== `system/${definition.path}`)
      throw new Error('allowlist dos arquivos de sistema difere do estado')
    positiveInteger(file.size)
    hash(file.sha256)
    nonemptyText(file.content_type)
    const provenance = record(file.provenance)
    if ('source' in definition) {
      if (
        provenance.kind !== 'github-source' ||
        provenance.url !== systemSourceUrl(definition, String(sources.source_commit)) ||
        provenance.repository_path !== definition.source ||
        provenance.commit !== sources.source_commit
      )
        throw new Error('proveniência de código inválida no estado')
    } else if (
      provenance.kind !== 'github-release-installer' ||
      provenance.url !== sources.asset_url ||
      provenance.archive_path !== systemSourcePath(definition)
    ) {
      throw new Error('proveniência do instalador inválida no estado')
    } else hash(provenance.installer_sha256)
  }
  const parsed = state as unknown as SystemState
  if (hash(parsed.manifest_sha256) !== manifestHash(parsed.files))
    throw new Error('SHA do manifesto de sistema inválido')
  return parsed
}

export function canReuseSystemState(
  state: SystemState | null,
  sources: SystemSourcePin,
  sizes: Map<string, number>,
  now = new Date(),
  force = false,
): state is SystemState {
  if (
    !state ||
    force ||
    state.pending_delphi_db ||
    JSON.stringify(state.sources) !== JSON.stringify(sources)
  )
    return false
  const age = now.getTime() - Date.parse(state.verified_at)
  return (
    age >= 0 &&
    age < SYSTEM_VERIFY_INTERVAL_MS &&
    state.files.every((file) => sizes.get(file.key) === file.size)
  )
}

export async function syncSystemFiles(
  prepared: PreparedSystemFiles,
  storage: SystemStorage,
  { write = false, now = new Date() } = {},
) {
  const digest = manifestHash(prepared.files)
  const state: SystemState = {
    schema_version: 1,
    sources: prepared.sources,
    manifest_sha256: digest,
    files: prepared.files,
    verified_at: now.toISOString(),
    pending_delphi_db: true,
  }
  parseSystemState(Buffer.from(JSON.stringify(state)))
  for (const file of prepared.files) {
    const body = prepared.bodies.get(file.key)
    if (
      !body ||
      body.byteLength !== file.size ||
      sha256(body) !== file.sha256 ||
      validateSystemFile(file.key, body) !== file.content_type
    )
      throw new Error(`${file.key}: conteúdo difere do manifesto validado`)
  }
  const previous = parseSystemState(await storage.get(SYSTEM_STATE_KEY))
  const changedKeys: string[] = []
  for (const file of prepared.files) {
    const current = await storage.get(file.key)
    if (current === null || current.byteLength !== file.size || sha256(current) !== file.sha256)
      changedKeys.push(file.key)
  }
  state.pending_delphi_db =
    changedKeys.length > 0 ||
    previous === null ||
    previous.pending_delphi_db ||
    previous.manifest_sha256 !== digest
  if (write) {
    for (const key of changedKeys) {
      const file = prepared.files.find((file) => file.key === key)!
      await storage.put(key, prepared.bodies.get(key)!, file.content_type)
    }
    if (JSON.stringify(previous) !== JSON.stringify(state))
      await storage.put(SYSTEM_STATE_KEY, JSON.stringify(state), 'application/json')
  }
  return { state, changed: state.pending_delphi_db, changedKeys, written: write }
}

export async function acknowledgeSystemFiles(
  storage: SystemStorage,
  digest: string,
  write = false,
) {
  hash(digest)
  const state = parseSystemState(await storage.get(SYSTEM_STATE_KEY))
  if (!state || state.manifest_sha256 !== digest)
    throw new Error('manifesto mudou antes da confirmação do banco Delphi')
  if (state.pending_delphi_db && write)
    await storage.put(
      SYSTEM_STATE_KEY,
      JSON.stringify({ ...state, pending_delphi_db: false }),
      'application/json',
    )
  return state
}
