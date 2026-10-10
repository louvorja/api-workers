/**
 * Importa apresentações LouvorJA (.slja ZIP ou .lja solto) para D1 + R2.
 *
 * O modo padrão é simulação: lê e valida a fila, gera SQL e relatório, mas não
 * envia mídia, não executa SQL remoto e não arquiva a origem. Escrita exige
 * `--write` de forma explícita.
 *
 * Exemplos:
 *   npm run slides:import -- --export=replica.sql --input=import
 *   npm run slides:import -- --export=replica.sql --source=r2 --write
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { hasAudioSignature, hasImageSignature, mediaFormatLabel } from './lib/media-signatures.ts'
import * as r2 from './lib/r2.ts'

const DEFAULT_MAX_PACKAGE_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 2_000
const MAX_INI_BYTES = 4 * 1024 * 1024
const AUDIO_EXTENSIONS = new Set(['.mp3', '.opus'])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp'])

export type QueueKind = 'local' | 'r2'
export type ImportDisposition = 'import' | 'already-imported' | 'duplicate-content'

export interface QueueSource {
  kind: QueueKind
  sourceKey: string
  sourceName: string
  archiveTarget: string
  body: Uint8Array
  readSibling(reference: string): Promise<Uint8Array | null>
  archive(): Promise<void>
}

export interface SlideSection {
  index: number
  type: string
  lyric: string
  auxLyric: string | null
  time: string
  imagePosition: number | null
  imageReference: string | null
}

export interface MediaAsset {
  kind: 'music' | 'image_music'
  legacyName: string
  extension: string
  contentType: string
  bytes: Uint8Array
  sha256: string
  r2Key: string
  directory: `/musics/${string}/imports` | '/images'
  fileName: string
}

export interface ParsedSlidePackage {
  source: QueueSource
  sourceSha256: string
  title: string
  language: string
  audio: MediaAsset | null
  coverImage: MediaAsset | null
  slides: Array<SlideSection & { image: MediaAsset | null }>
  media: MediaAsset[]
}

export interface PlannedPackage {
  parsed: ParsedSlidePackage
  disposition: ImportDisposition
  previousSourceKey?: string
}

export interface ImportPlan {
  packages: PlannedPackage[]
  newPackages: PlannedPackage[]
  media: MediaAsset[]
  sql: string
  generatedAt: string
  version: number
}

export interface ImportExecutionDependencies {
  objectStore: {
    get(key: string): Promise<Uint8Array | null>
    put(key: string, body: Uint8Array, contentType: string): Promise<void>
  }
  executeSql(database: string, sqlPath: string): Promise<void> | void
}

export interface ImportExecutionResult {
  uploaded: number
  reused: number
  sqlExecuted: boolean
  archived: number
}

interface IniSection {
  name: string
  values: Map<string, string>
}

interface CatalogSnapshot {
  database: DatabaseSync
  languages: Set<string>
  bySourceKey: Map<string, string>
  byHash: Map<string, string>
  version: number
}

interface ZipReader {
  entries: Map<string, string>
  read(normalizedName: string): Uint8Array
  close(): void
}

interface CliOptions {
  exportPath: string
  source: QueueKind
  input: string
  archive: string
  language: string
  outputSql: string
  reportPath: string
  database: string
  write: boolean
  maxPackageBytes: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function compositeHash(parts: ReadonlyArray<{ name: string; bytes: Uint8Array }>): string {
  const hash = createHash('sha256')
  for (const part of [...parts].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = Buffer.from(part.name, 'utf8')
    const header = Buffer.alloc(16)
    header.writeBigUInt64BE(BigInt(name.byteLength), 0)
    header.writeBigUInt64BE(BigInt(part.bytes.byteLength), 8)
    hash.update(header).update(name).update(part.bytes)
  }
  return hash.digest('hex')
}

function sql(value: string | number | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('número não finito no SQL')
    return String(value)
  }
  return `'${value.replaceAll("'", "''")}'`
}

function safeBasename(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).trim()
  if (!name || name === '.' || name === '..' || /[\0-\x1f\x7f]/.test(name)) {
    throw new Error(`nome de arquivo inválido: ${JSON.stringify(value)}`)
  }
  return name
}

/** Valida nomes vindos do ZIP ou referências do INI antes de qualquer acesso. */
export function normalizeSafeRelativePath(value: string): string {
  const path = value.replaceAll('\\', '/').trim()
  if (!path) throw new Error('caminho vazio')
  if (/^[a-zA-Z]:/.test(path) || path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`caminho absoluto não permitido: ${JSON.stringify(value)}`)
  }
  if (/[\0-\x1f\x7f]/.test(path)) {
    throw new Error(`caminho contém caractere de controle: ${JSON.stringify(value)}`)
  }
  const directory = path.endsWith('/')
  const segments = path.split('/').filter((segment) => segment !== '')
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`caminho relativo inseguro: ${JSON.stringify(value)}`)
  }
  return `${segments.join('/')}${directory ? '/' : ''}`
}

function mediaContentType(kind: MediaAsset['kind'], extension: string): string {
  if (kind === 'music') {
    const audio: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.opus': 'audio/ogg',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.wma': 'audio/x-ms-wma',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.flac': 'audio/flac',
    }
    return audio[extension] ?? 'application/octet-stream'
  }
  const image: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }
  return image[extension] ?? 'application/octet-stream'
}

function makeMediaAsset(
  kind: MediaAsset['kind'],
  originalName: string,
  bytes: Uint8Array,
  language: string,
): MediaAsset {
  if (bytes.byteLength === 0) throw new Error(`mídia vazia: ${originalName}`)
  const extension = extname(safeBasename(originalName)).toLowerCase()
  const allowed = kind === 'music' ? AUDIO_EXTENSIONS : IMAGE_EXTENSIONS
  if (!allowed.has(extension)) {
    throw new Error(
      `${kind === 'music' ? 'áudio' : 'imagem'} com extensão não suportada: ${originalName}`,
    )
  }
  const validSignature =
    kind === 'music' ? hasAudioSignature(bytes, extension) : hasImageSignature(bytes, extension)
  if (!validSignature) {
    throw new Error(
      `${kind === 'music' ? 'áudio' : 'imagem'} ${originalName} não contém assinatura ` +
        `${mediaFormatLabel(extension)} compatível com a extensão`,
    )
  }
  const digest = sha256(bytes)
  const directory = kind === 'music' ? (`/musics/${language}/imports` as const) : '/images'
  const fileName = `${digest}${extension}`
  const legacyExtension = kind === 'music' ? '.mp3' : '.bmp'
  return {
    kind,
    legacyName: `${digest}${legacyExtension}`,
    extension,
    contentType: mediaContentType(kind, extension),
    bytes,
    sha256: digest,
    r2Key: `${directory.slice(1)}/${fileName}`,
    directory,
    fileName,
  }
}

function decodeIni(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_INI_BYTES) throw new Error('slides.lja excede 4 MiB')
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

export function parseIni(text: string): IniSection[] {
  const sections: IniSection[] = []
  const seen = new Set<string>()
  let current: IniSection | null = null

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const match = /^\[([^\]]+)]$/.exec(line)
    if (match) {
      const name = (match[1] as string).trim()
      const key = name.toLocaleLowerCase('en-US')
      if (!name || seen.has(key)) throw new Error(`seção INI duplicada ou vazia: ${name}`)
      seen.add(key)
      current = { name, values: new Map() }
      sections.push(current)
      if (sections.length > 10_001) throw new Error('slides.lja tem seções demais')
      continue
    }
    const separator = line.indexOf('=')
    if (separator < 1 || current === null) continue
    const key = line.slice(0, separator).trim().toLocaleLowerCase('en-US')
    if (!key) continue
    current.values.set(key, line.slice(separator + 1).trim())
  }
  return sections
}

function getSection(sections: readonly IniSection[], name: string): IniSection | undefined {
  const key = name.toLocaleLowerCase('en-US')
  return sections.find((section) => section.name.toLocaleLowerCase('en-US') === key)
}

function normalizeLyric(value: string): string {
  const text = value.replaceAll('|', '\n').replaceAll('\\n', '\n').trim()
  if (!text) return ''
  const [first, ...rest] = [...text]
  return `${first?.toLocaleUpperCase('pt-BR') ?? ''}${rest.join('')}`
}

function normalizeTime(value: string | undefined, bytePosition: string | undefined): string {
  if (value?.trim()) {
    const parts = value.trim().split(':')
    if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
      throw new Error(`tempo_hms inválido: ${value}`)
    }
    const numbers = parts.map(Number)
    let hours = 0
    let minutes = 0
    let seconds = 0
    if (numbers.length === 3) [hours, minutes, seconds] = numbers as [number, number, number]
    else if (numbers.length === 2) [minutes, seconds] = numbers as [number, number]
    else seconds = numbers[0] ?? 0
    if (minutes > 59 || seconds > 59 || hours > 999) throw new Error(`tempo_hms inválido: ${value}`)
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
  }
  if (bytePosition?.trim()) {
    const bytes = Number(bytePosition)
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`tempo inválido: ${bytePosition}`)
    const seconds = Math.round(bytes / 176_400)
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return [hours, minutes, seconds % 60].map((part) => String(part).padStart(2, '0')).join(':')
  }
  return '00:00:00'
}

function archiveTotalBytes(path: string): number {
  const summary = String(
    execFileSync('unzip', ['-Z', '-t', path], { encoding: 'utf8', maxBuffer: 1024 * 1024 }),
  )
  const match = /(?:^|\s)(\d+) bytes uncompressed(?:,|\s)/.exec(summary)
  if (!match) throw new Error('não foi possível determinar o tamanho descompactado do ZIP')
  return Number(match[1])
}

function openZip(body: Uint8Array, maxPackageBytes: number): ZipReader {
  if (body.byteLength > maxPackageBytes) {
    throw new Error(`pacote excede ${maxPackageBytes} bytes compactados`)
  }
  const directory = mkdtempSync(join(tmpdir(), 'louvorja-slides-'))
  const path = join(directory, 'package.slja')
  writeFileSync(path, body)
  try {
    // Consulta primeiro só o diretório central. Assim um ZIP bomb declarado
    // acima do limite é recusado antes de `unzip -t` inflar qualquer entrada.
    const totalBytes = archiveTotalBytes(path)
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxPackageBytes) {
      throw new Error(`pacote excede ${maxPackageBytes} bytes descompactados`)
    }
    const output = String(
      execFileSync('unzip', ['-Z1', path], {
        encoding: 'utf8',
        maxBuffer: Math.min(maxPackageBytes, 16 * 1024 * 1024),
      }),
    )
    const originalNames = output.split(/\r?\n/).filter(Boolean)
    if (originalNames.length === 0 || originalNames.length > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`quantidade inválida de entradas no ZIP: ${originalNames.length}`)
    }
    const entries = new Map<string, string>()
    for (const originalName of originalNames) {
      const normalized = normalizeSafeRelativePath(originalName)
      if (normalized.endsWith('/')) continue
      const key = normalized.toLocaleLowerCase('en-US')
      if (entries.has(key)) throw new Error(`entrada ZIP duplicada: ${normalized}`)
      entries.set(key, originalName)
    }
    execFileSync('unzip', ['-tqq', path], { stdio: 'pipe', maxBuffer: 1024 * 1024 })
    return {
      entries,
      read(normalizedName: string) {
        const originalName = entries.get(normalizedName.toLocaleLowerCase('en-US'))
        if (!originalName) throw new Error(`entrada ausente no ZIP: ${normalizedName}`)
        return new Uint8Array(
          execFileSync('unzip', ['-p', path, originalName], {
            maxBuffer: maxPackageBytes,
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        )
      },
      close() {
        rmSync(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw new Error(`ZIP inválido: ${errorMessage(error)}`)
  }
}

function findEmbeddedEntry(
  entries: ReadonlyMap<string, string>,
  reference: string,
  kind: MediaAsset['kind'],
): string {
  const normalizedReference = reference.replaceAll('\\', '/')
  const referenceName = safeBasename(normalizedReference).toLocaleLowerCase('en-US')
  const exact = (() => {
    try {
      return normalizeSafeRelativePath(normalizedReference).toLocaleLowerCase('en-US')
    } catch {
      return null
    }
  })()
  if (exact && entries.has(exact)) return exact

  const roots = kind === 'music' ? ['audio/'] : ['imagens/', 'images/']
  const matches = [...entries.keys()].filter(
    (entry) =>
      roots.some((root) => entry.startsWith(root)) &&
      safeBasename(entry).toLocaleLowerCase('en-US') === referenceName,
  )
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `mídia referenciada não existe no pacote: ${reference}`
        : `mídia ambígua no pacote: ${reference}`,
    )
  }
  return matches[0] as string
}

function onlyEmbeddedAudio(entries: ReadonlyMap<string, string>): string | null {
  const candidates = [...entries.keys()].filter((entry) => {
    if (!entry.startsWith('audio/')) return false
    return AUDIO_EXTENSIONS.has(extname(entry).toLowerCase())
  })
  if (candidates.length > 1) throw new Error('pacote tem mais de um áudio e url_musica está vazio')
  return candidates[0] ?? null
}

async function loadReferencedMedia(
  source: QueueSource,
  reference: string,
  kind: MediaAsset['kind'],
  zip: ZipReader | null,
  language: string,
): Promise<MediaAsset> {
  if (zip) {
    const entry = findEmbeddedEntry(zip.entries, reference, kind)
    return makeMediaAsset(kind, safeBasename(entry), zip.read(entry), language)
  }
  const normalized = normalizeSafeRelativePath(reference)
  const bytes = await source.readSibling(normalized)
  if (bytes === null) throw new Error(`mídia ao lado do .lja não encontrada: ${normalized}`)
  return makeMediaAsset(kind, safeBasename(normalized), bytes, language)
}

function deduplicateMedia(media: readonly MediaAsset[]): MediaAsset[] {
  const byKey = new Map<string, MediaAsset>()
  for (const asset of media) {
    const previous = byKey.get(asset.r2Key)
    if (previous && previous.sha256 !== asset.sha256) {
      throw new Error(`colisão de mídia na chave ${asset.r2Key}`)
    }
    byKey.set(asset.r2Key, asset)
  }
  return [...byKey.values()].sort((a, b) => a.r2Key.localeCompare(b.r2Key))
}

/** Lê e valida por completo um pacote antes de produzir qualquer mutação. */
export async function parseSlidePackage(
  source: QueueSource,
  language = 'pt',
  maxPackageBytes = DEFAULT_MAX_PACKAGE_BYTES,
): Promise<ParsedSlidePackage> {
  const normalizedLanguage = language.trim().toLowerCase()
  if (!/^[a-z][a-z0-9_-]{1,7}$/.test(normalizedLanguage)) {
    throw new Error(`idioma inválido: ${language}`)
  }
  const extension = extname(source.sourceName).toLowerCase()
  if (extension !== '.slja' && extension !== '.lja') {
    throw new Error(`extensão não suportada: ${source.sourceName}`)
  }

  let zip: ZipReader | null = null
  try {
    if (extension === '.slja') zip = openZip(source.body, maxPackageBytes)
    const iniBytes = zip ? zip.read('slides.lja') : source.body
    const sections = parseIni(decodeIni(iniBytes))
    const general = getSection(sections, 'Geral')
    if (!general) throw new Error('seção [Geral] ausente')

    const slideSections = sections
      .map((section) => {
        const match = /^slide:(\d+)$/i.exec(section.name)
        return match ? { section, index: Number(match[1]) } : null
      })
      .filter((item): item is { section: IniSection; index: number } => item !== null)
      .sort((a, b) => a.index - b.index)
    if (slideSections.length === 0) throw new Error('nenhum [Slide:N] encontrado')
    if (
      slideSections.some(
        ({ index }, position) => !Number.isSafeInteger(index) || index !== position + 1,
      )
    ) {
      throw new Error('os slides devem formar uma sequência contínua iniciada em 1')
    }
    const declaredSlides = Number(general.values.get('slides') ?? slideSections.length)
    if (!Number.isSafeInteger(declaredSlides) || declaredSlides !== slideSections.length) {
      throw new Error(
        `quantidade de slides divergente: Geral=${declaredSlides}, seções=${slideSections.length}`,
      )
    }

    let audioReference = general.values.get('url_musica')?.trim() ?? ''
    if (!audioReference && zip) audioReference = onlyEmbeddedAudio(zip.entries) ?? ''
    const audio = audioReference
      ? await loadReferencedMedia(source, audioReference, 'music', zip, normalizedLanguage)
      : null

    const imageByReference = new Map<string, MediaAsset>()
    const slides: Array<SlideSection & { image: MediaAsset | null }> = []
    let currentImage: MediaAsset | null = null
    for (const { section, index } of slideSections) {
      const imageReference = section.values.get('imagem')?.trim() || null
      if (imageReference) {
        const key = imageReference.replaceAll('\\', '/').toLocaleLowerCase('en-US')
        let image = imageByReference.get(key)
        if (!image) {
          image = await loadReferencedMedia(
            source,
            imageReference,
            'image_music',
            zip,
            normalizedLanguage,
          )
          imageByReference.set(key, image)
        }
        currentImage = image
      }
      const rawPosition = section.values.get('imagem_posicao')
      const imagePosition = rawPosition === undefined ? null : Number(rawPosition)
      if (imagePosition !== null && !Number.isSafeInteger(imagePosition)) {
        throw new Error(`imagem_posicao inválida no Slide:${index}`)
      }
      slides.push({
        index,
        type: (section.values.get('tipo') || (index === 1 ? 'CAPA' : 'LETRA')).toUpperCase(),
        lyric: normalizeLyric(section.values.get('letra') ?? ''),
        auxLyric: normalizeLyric(section.values.get('letra_aux') ?? '') || null,
        time: normalizeTime(section.values.get('tempo_hms'), section.values.get('tempo')),
        imagePosition,
        imageReference,
        image: currentImage,
      })
    }

    const covers = slides.filter((slide) => slide.type === 'CAPA')
    if (covers.length === 0) throw new Error('pacote sem slide do tipo CAPA')
    const packageStem = basename(source.sourceName, extension).trim()
    const title =
      general.values.get('nome')?.trim() ||
      general.values.get('titulo')?.trim() ||
      covers.at(-1)?.lyric.replace(/\s+/g, ' ').trim() ||
      packageStem
    if (!title) throw new Error('não foi possível determinar o nome da música')

    const coverImage = covers.at(-1)?.image ?? null
    const media = deduplicateMedia([
      ...(audio ? [audio] : []),
      ...slides.flatMap((slide) => (slide.image ? [slide.image] : [])),
    ])
    const sourceSha256 =
      extension === '.slja'
        ? sha256(source.body)
        : compositeHash([
            { name: 'slides.lja', bytes: source.body },
            ...media.map((asset) => ({ name: asset.r2Key, bytes: asset.bytes })),
          ])
    return {
      source,
      sourceSha256,
      title,
      language: normalizedLanguage,
      audio,
      coverImage,
      slides,
      media,
    }
  } finally {
    zip?.close()
  }
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name)),
  )
}

function requireColumns(database: DatabaseSync, table: string, columns: readonly string[]): void {
  const present = tableColumns(database, table)
  const missing = columns.filter((column) => !present.has(column))
  if (missing.length > 0) {
    throw new Error(`export D1 sem ${table}.${missing.join(`, ${table}.`)}`)
  }
}

function loadSnapshot(exportPath: string): CatalogSnapshot {
  if (!existsSync(exportPath)) throw new Error(`export D1 não encontrado: ${exportPath}`)
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(readFileSync(exportPath, 'utf8'))
    requireColumns(database, 'languages', ['id_language'])
    requireColumns(database, 'files', ['name', 'type', 'size', 'dir', 'file_name', 'version'])
    requireColumns(database, 'musics', ['name', 'id_file_image', 'id_file_music', 'id_language'])
    requireColumns(database, 'lyrics', [
      'id_music',
      'lyric',
      'aux_lyric',
      'id_file_image',
      'time',
      'instrumental_time',
      'show_slide',
      'order',
      'id_language',
    ])
    requireColumns(database, 'slide_imports', [
      'source_key',
      'source_sha256',
      'source_kind',
      'source_name',
      'id_music',
      'imported_at',
    ])
    const languages = new Set(
      database
        .prepare('SELECT id_language FROM languages')
        .all()
        .map((row) => String(row.id_language)),
    )
    const bySourceKey = new Map<string, string>()
    const byHash = new Map<string, string>()
    for (const row of database
      .prepare('SELECT source_key, source_sha256 FROM slide_imports')
      .all()) {
      const key = String(row.source_key)
      const hash = String(row.source_sha256)
      bySourceKey.set(key, hash)
      byHash.set(hash, key)
    }
    const config = database
      .prepare("SELECT value FROM configs WHERE key = 'version_number' LIMIT 1")
      .get()
    const currentVersion = Number(config?.value ?? 0)
    return {
      database,
      languages,
      bySourceKey,
      byHash,
      version: Number.isSafeInteger(currentVersion) && currentVersion >= 0 ? currentVersion + 1 : 1,
    }
  } catch (error) {
    database.close()
    throw error
  }
}

function mediaIdExpression(asset: MediaAsset | null): string {
  if (!asset) return 'NULL'
  return `(SELECT id_file FROM files WHERE dir = ${sql(asset.directory)} AND file_name = ${sql(asset.fileName)})`
}

function renderPackageSql(item: PlannedPackage, timestamp: string): string {
  const { parsed } = item
  const hash = parsed.sourceSha256
  const lines: string[] = []
  lines.push(
    `INSERT INTO musics (name, id_file_image, id_file_music, id_file_instrumental_music, id_language, created_at, updated_at)`,
    `SELECT ${sql(parsed.title)}, ${mediaIdExpression(parsed.coverImage)}, ${mediaIdExpression(parsed.audio)}, NULL, ${sql(parsed.language)}, ${sql(timestamp)}, ${sql(timestamp)}`,
    `WHERE NOT EXISTS (SELECT 1 FROM slide_imports WHERE source_sha256 = ${sql(hash)});`,
    `INSERT INTO slide_imports (source_key, source_sha256, source_kind, source_name, id_music, imported_at)`,
    `SELECT ${sql(parsed.source.sourceKey)}, ${sql(hash)}, ${sql(parsed.source.kind)}, ${sql(parsed.source.sourceName)}, last_insert_rowid(), ${sql(timestamp)}`,
    `WHERE NOT EXISTS (SELECT 1 FROM slide_imports WHERE source_sha256 = ${sql(hash)});`,
  )
  let order = 0
  for (const slide of parsed.slides) {
    if (slide.type === 'CAPA') continue
    order += 10
    lines.push(
      `INSERT OR IGNORE INTO lyrics (id_music, lyric, aux_lyric, id_file_image, time, instrumental_time, show_slide, "order", id_language, created_at, updated_at)`,
      `SELECT id_music, ${sql(slide.lyric)}, ${sql(slide.auxLyric)}, ${mediaIdExpression(slide.image)}, ${sql(slide.time)}, '00:00:00', 1, ${order}, ${sql(parsed.language)}, ${sql(timestamp)}, ${sql(timestamp)}`,
      `FROM slide_imports WHERE source_sha256 = ${sql(hash)};`,
    )
  }
  return lines.join('\n')
}

function renderImportSql(
  packages: readonly PlannedPackage[],
  media: readonly MediaAsset[],
  version: number,
  timestamp: string,
): string {
  if (packages.length === 0) return '-- Nenhum pacote novo para importar.\n'
  // `wrangler d1 execute --file` envia o arquivo como um batch atômico. D1
  // recusa BEGIN/COMMIT explícitos; se qualquer instrução falhar, o batch é
  // revertido pelo próprio D1.
  const lines = ['PRAGMA foreign_keys = ON;']
  for (const asset of media) {
    lines.push(
      `INSERT OR IGNORE INTO files (name, type, size, dir, file_name, image_position, duration, version, created_at, updated_at) VALUES (` +
        [
          sql(asset.legacyName),
          sql(asset.kind),
          asset.bytes.byteLength,
          sql(asset.directory),
          sql(asset.fileName),
          'NULL',
          'NULL',
          version,
          sql(timestamp),
          sql(timestamp),
        ].join(', ') +
        ');',
    )
  }
  for (const item of packages) lines.push(renderPackageSql(item, timestamp))
  lines.push('')
  return lines.join('\n')
}

function validatePlan(snapshot: CatalogSnapshot, plan: ImportPlan): void {
  snapshot.database.exec(plan.sql)
  for (const item of plan.newPackages) {
    const journal = snapshot.database
      .prepare('SELECT id_music FROM slide_imports WHERE source_key = ? AND source_sha256 = ?')
      .get(item.parsed.source.sourceKey, item.parsed.sourceSha256)
    if (!journal) throw new Error(`SQL não criou o journal de ${item.parsed.source.sourceName}`)
    const expectedLyrics = item.parsed.slides.filter((slide) => slide.type !== 'CAPA').length
    const count = snapshot.database
      .prepare('SELECT count(*) AS total FROM lyrics WHERE id_music = ?')
      .get(Number(journal.id_music))
    if (Number(count?.total) !== expectedLyrics) {
      throw new Error(`SQL perdeu letras de ${item.parsed.source.sourceName}`)
    }
  }
  // A mesma mutação precisa ser reaplicável sem criar nada novo.
  const before = Number(
    snapshot.database.prepare('SELECT count(*) AS total FROM musics').get()?.total,
  )
  snapshot.database.exec(plan.sql)
  const after = Number(
    snapshot.database.prepare('SELECT count(*) AS total FROM musics').get()?.total,
  )
  if (before !== after) throw new Error('SQL não é idempotente em segunda execução')
}

export function createImportPlan(
  parsedPackages: readonly ParsedSlidePackage[],
  exportPath: string,
  generatedAt = new Date().toISOString(),
): ImportPlan {
  const snapshot = loadSnapshot(exportPath)
  const packages: PlannedPackage[] = []
  const plannedHashes = new Map<string, string>()

  try {
    for (const parsed of parsedPackages) {
      if (!snapshot.languages.has(parsed.language)) {
        throw new Error(`idioma não existe no D1: ${parsed.language}`)
      }
      const previousHash = snapshot.bySourceKey.get(parsed.source.sourceKey)
      if (previousHash && previousHash !== parsed.sourceSha256) {
        throw new Error(
          `a origem ${parsed.source.sourceKey} já foi importada com outro conteúdo; renomeie o pacote ou revise a fila`,
        )
      }
      const previousSourceKey = snapshot.byHash.get(parsed.sourceSha256)
      let disposition: ImportDisposition = 'import'
      if (previousHash === parsed.sourceSha256) disposition = 'already-imported'
      else if (previousSourceKey) disposition = 'duplicate-content'
      const plannedSourceKey = plannedHashes.get(parsed.sourceSha256)
      if (disposition === 'import' && plannedSourceKey) disposition = 'duplicate-content'
      else if (disposition === 'import')
        plannedHashes.set(parsed.sourceSha256, parsed.source.sourceKey)
      packages.push({
        parsed,
        disposition,
        previousSourceKey: previousSourceKey ?? plannedSourceKey,
      })
    }
    const newPackages = packages.filter((item) => item.disposition === 'import')
    const media = deduplicateMedia(newPackages.flatMap((item) => item.parsed.media))
    const timestamp = generatedAt.slice(0, 19).replace('T', ' ')
    const sqlText = renderImportSql(newPackages, media, snapshot.version, timestamp)
    const plan = {
      packages,
      newPackages,
      media,
      sql: sqlText,
      generatedAt,
      version: snapshot.version,
    }
    validatePlan(snapshot, plan)
    return plan
  } finally {
    snapshot.database.close()
  }
}

/** Executa as três fases mutáveis na ordem recuperável: R2, D1, arquivamento. */
export async function executeImportPlan(
  plan: ImportPlan,
  options: { write: boolean; database: string; sqlPath: string },
  dependencies: ImportExecutionDependencies,
): Promise<ImportExecutionResult> {
  if (!options.write) return { uploaded: 0, reused: 0, sqlExecuted: false, archived: 0 }

  let uploaded = 0
  let reused = 0
  for (const asset of plan.media) {
    const existing = await dependencies.objectStore.get(asset.r2Key)
    if (existing) {
      if (!bytesEqual(existing, asset.bytes)) {
        throw new Error(`objeto R2 já existe com conteúdo diferente: ${asset.r2Key}`)
      }
      reused++
      continue
    }
    await dependencies.objectStore.put(asset.r2Key, asset.bytes, asset.contentType)
    uploaded++
  }

  let sqlExecuted = false
  if (plan.newPackages.length > 0) {
    await dependencies.executeSql(options.database, options.sqlPath)
    sqlExecuted = true
  }

  let archived = 0
  for (const item of plan.packages) {
    await item.parsed.source.archive()
    archived++
  }
  return { uploaded, reused, sqlExecuted, archived }
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function localSource(path: string, archiveDirectory: string): QueueSource {
  const absolute = resolve(path)
  const root = realpathSync(dirname(absolute))
  const body = new Uint8Array(readFileSync(absolute))
  const sourceName = basename(absolute)
  const sourceKey = `local:${sourceName}`
  const archiveTarget = resolve(archiveDirectory, sourceName)
  return {
    kind: 'local',
    sourceKey,
    sourceName,
    archiveTarget,
    body,
    async readSibling(referencePath) {
      const safe = normalizeSafeRelativePath(referencePath)
      const candidate = resolve(root, ...safe.split('/'))
      if (!existsSync(candidate)) return null
      const actual = realpathSync(candidate)
      if (!isInside(root, actual) || !lstatSync(actual).isFile()) {
        throw new Error(`referência de mídia sai da pasta da fila: ${referencePath}`)
      }
      return new Uint8Array(readFileSync(actual))
    },
    async archive() {
      mkdirSync(archiveDirectory, { recursive: true })
      if (existsSync(archiveTarget)) {
        const archived = new Uint8Array(readFileSync(archiveTarget))
        if (!bytesEqual(archived, body)) {
          throw new Error(`destino de arquivo já existe com conteúdo diferente: ${archiveTarget}`)
        }
        if (existsSync(absolute)) unlinkSync(absolute)
        return
      }
      renameSync(absolute, archiveTarget)
    },
  }
}

export function loadLocalQueue(inputDirectory: string, archiveDirectory: string): QueueSource[] {
  const input = resolve(inputDirectory)
  if (!existsSync(input) || !lstatSync(input).isDirectory()) {
    throw new Error(`diretório da fila não encontrado: ${input}`)
  }
  return readdirSync(input, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:slja|lja)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => localSource(join(input, entry.name), archiveDirectory))
}

function r2SiblingKey(sourceKey: string, referencePath: string): string {
  const safe = normalizeSafeRelativePath(referencePath)
  const prefix = sourceKey.includes('/') ? sourceKey.slice(0, sourceKey.lastIndexOf('/') + 1) : ''
  return `${prefix}${safe}`
}

export async function loadR2Queue(
  queuePrefix: string,
  archivePrefix: string,
): Promise<QueueSource[]> {
  const queue = normalizeSafeRelativePath(queuePrefix).replace(/\/?$/, '/')
  const archive = normalizeSafeRelativePath(archivePrefix).replace(/\/?$/, '/')
  const keys = (await r2.list(queue))
    .filter((key) => /\.(?:slja|lja)$/i.test(key) && !key.startsWith(archive))
    .sort((a, b) => a.localeCompare(b))
  const sources: QueueSource[] = []
  for (const key of keys) {
    normalizeSafeRelativePath(key)
    const body = await r2.get(key)
    if (!body) throw new Error(`objeto desapareceu durante a listagem: ${key}`)
    const sourceName = safeBasename(key)
    const archiveTarget = `${archive}${key.slice(queue.length)}`
    sources.push({
      kind: 'r2',
      sourceKey: `r2:${key}`,
      sourceName,
      archiveTarget,
      body,
      readSibling: (referencePath) => r2.get(r2SiblingKey(key, referencePath)),
      async archive() {
        const existing = await r2.get(archiveTarget)
        if (existing && !bytesEqual(existing, body)) {
          throw new Error(`arquivo R2 já existe com conteúdo diferente: ${archiveTarget}`)
        }
        if (!existing) await r2.put(archiveTarget, body, 'application/octet-stream')
        await r2.del(key)
      },
    })
  }
  return sources
}

function writeAtomic(path: string, content: string): void {
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true })
  const temporary = `${absolute}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, absolute)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function parsePositiveMegabytes(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_PACKAGE_BYTES
  const megabytes = Number(value)
  if (!Number.isFinite(megabytes) || megabytes <= 0 || megabytes > 2_048) {
    throw new Error('--max-package-mb deve estar entre 0 e 2048')
  }
  return Math.floor(megabytes * 1024 * 1024)
}

function parseArgs(argv: readonly string[]): CliOptions | null {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const valueNames = new Set([
    'export',
    'source',
    'input',
    'archive',
    'lang',
    'out',
    'report',
    'database',
    'max-package-mb',
  ])
  for (const argument of argv) {
    if (!argument.startsWith('--')) throw new Error(`argumento inválido: ${argument}`)
    const separator = argument.indexOf('=')
    const name = argument.slice(2, separator < 0 ? undefined : separator)
    const value = separator < 0 ? undefined : argument.slice(separator + 1)
    if (name === 'write' || name === 'help') {
      if (value !== undefined) throw new Error(`--${name} não recebe valor`)
      flags.add(name)
      continue
    }
    if (!valueNames.has(name) || !value) throw new Error(`opção inválida: ${argument}`)
    if (values.has(name)) throw new Error(`--${name} foi informado mais de uma vez`)
    values.set(name, value)
  }
  if (flags.has('help')) return null
  const exportPath = values.get('export')
  if (!exportPath) throw new Error('informe --export=<replica.sql>')
  const source = values.get('source') ?? 'local'
  if (source !== 'local' && source !== 'r2') throw new Error('--source deve ser local ou r2')
  return {
    exportPath: resolve(exportPath),
    source,
    input: values.get('input') ?? (source === 'local' ? 'import' : 'imports/slides/queue/'),
    archive:
      values.get('archive') ??
      (source === 'local'
        ? join(values.get('input') ?? 'import', 'imported')
        : 'imports/slides/imported/'),
    language: values.get('lang') ?? 'pt',
    outputSql: resolve(values.get('out') ?? 'import-slides.sql'),
    reportPath: resolve(values.get('report') ?? 'import-slides-report.json'),
    database: values.get('database') ?? 'louvorja',
    write: flags.has('write'),
    maxPackageBytes: parsePositiveMegabytes(values.get('max-package-mb')),
  }
}

function printHelp(): void {
  console.log(`Uso:
  npm run slides:import -- --export=replica.sql [opções]

Opções:
  --source=local|r2       Origem da fila (padrão: local)
  --input=caminho         Pasta local ou prefixo R2
  --archive=caminho       Pasta/prefixo de concluídos
  --lang=pt               Idioma das músicas importadas
  --out=arquivo.sql       SQL gerado (padrão: import-slides.sql)
  --report=arquivo.json   Relatório (padrão: import-slides-report.json)
  --database=louvorja     Banco remoto do Wrangler
  --max-package-mb=512    Limite compactado e descompactado
  --write                 Envia mídia, aplica D1 e arquiva a fila
  --help                  Mostra esta ajuda

Sem --write, nenhuma mutação remota ou arquivamento é executado.`)
}

async function executeWrangler(database: string, sqlPath: string): Promise<void> {
  execFileSync(
    'npx',
    ['--no-install', 'wrangler', 'd1', 'execute', database, '--remote', '--yes', '--file', sqlPath],
    { stdio: 'inherit' },
  )
}

async function cli(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!options) {
    printHelp()
    return
  }
  const sources =
    options.source === 'local'
      ? loadLocalQueue(options.input, options.archive)
      : await loadR2Queue(options.input, options.archive)
  const parsed: ParsedSlidePackage[] = []
  for (const source of sources) {
    parsed.push(await parseSlidePackage(source, options.language, options.maxPackageBytes))
  }
  const plan = createImportPlan(parsed, options.exportPath)
  writeAtomic(options.outputSql, plan.sql)
  const result = await executeImportPlan(
    plan,
    { write: options.write, database: options.database, sqlPath: options.outputSql },
    {
      objectStore: { get: r2.get, put: r2.put },
      executeSql: executeWrangler,
    },
  )
  const report = {
    schemaVersion: 1,
    generatedAt: plan.generatedAt,
    mode: options.write ? 'write' : 'dry-run',
    source: options.source,
    queue: options.input,
    archive: options.archive,
    language: options.language,
    packages: plan.packages.map((item) => ({
      name: item.parsed.source.sourceName,
      sourceKey: item.parsed.source.sourceKey,
      sha256: item.parsed.sourceSha256,
      disposition: item.disposition,
      title: item.parsed.title,
      audio: item.parsed.audio?.r2Key ?? null,
      slides: item.parsed.slides.length,
      lyrics: item.parsed.slides.filter((slide) => slide.type !== 'CAPA').length,
      media: item.parsed.media.map((asset) => asset.r2Key),
    })),
    sql: { path: options.outputSql, packages: plan.newPackages.length },
    execution: result,
  }
  writeAtomic(options.reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    `${options.write ? 'Escrita' : 'Simulação'}: ${plan.packages.length} pacote(s), ` +
      `${plan.newPackages.length} novo(s), ${plan.media.length} mídia(s).`,
  )
  console.log(`SQL: ${options.outputSql}`)
  console.log(`Relatório: ${options.reportPath}`)
  if (!options.write) console.log('Nada foi alterado. Use --write para aplicar e arquivar a fila.')
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  cli().catch((error) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
}
