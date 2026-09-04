/**
 * Traz para o bucket as mídias que os JSONs referenciam mas que não existem
 * lá. Consome a lista que scripts/ingest.ts grava em missing-media.txt.
 *
 * O acervo é padronizado: áudio em Opus, imagem em JPEG. A origem só tem
 * MP3/BMP, então nada é copiado cru — o áudio é transcodificado para Opus com
 * bitrate escolhido pela fonte (ver BITRATE_LADDER) e o MP3 nunca chega ao
 * bucket, que já ocupa ~6GB.
 *
 *   node --env-file=.env --experimental-strip-types scripts/sync-media.ts
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import bmp from 'bmp-js'
import jpeg from 'jpeg-js'
import { fetchLegacy, pool } from './lib/legacy.ts'
import * as r2 from './lib/r2.ts'

const run = promisify(execFile)
const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const CONCURRENCY = Number(args.get('concurrency') ?? 10)
const LIMIT = Number(args.get('limit') ?? 0)

/**
 * Bitrate Opus por bitrate da fonte, validado por ABX.
 *
 * Opus precisa de ~60% do bitrate do MP3 para soar igual. Duas bordas importam:
 * o teto é 128k, porque acima disso o Opus já é transparente para qualquer
 * fonte (320 -> 128 ficou transparente no teste); e o piso é a própria fonte,
 * porque o que o MP3 perdeu na primeira compressão não volta — um MP3 de 128
 * não justifica Opus acima de 80.
 */
const BITRATE_LADDER: Array<[maxSourceKbps: number, targetKbps: number]> = [
  [64, 48],
  [96, 64],
  [128, 80],
  [160, 96],
  [Number.POSITIVE_INFINITY, 128],
]

/** Bitrates nominais de MP3. */
const MP3_RATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]

/**
 * O ffprobe reporta o bitrate do contêiner, que carrega o overhead dos frames:
 * um MP3 de 128k mede 128,04k. Comparar esse número cru contra a escada faz a
 * faixa cair um degrau acima (128,04 > 128 vira o degrau do 160). Ancorar no
 * bitrate nominal mais próximo resolve.
 */
function targetBitrate(sourceKbps: number): number {
  const nominal = MP3_RATES.reduce((best, r) =>
    Math.abs(r - sourceKbps) < Math.abs(best - sourceKbps) ? r : best,
  )
  return (BITRATE_LADDER.find(([max]) => nominal <= max) as [number, number])[1]
}

const workdir = mkdtempSync(join(tmpdir(), 'louvorja-'))

async function probeKbps(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=bit_rate',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ])
  const bps = Number(stdout.trim())
  // Sem bitrate declarado, assume o degrau mais alto: erra para o lado seguro.
  return Number.isFinite(bps) && bps > 0 ? bps / 1000 : 320
}

async function toOpus(mp3: Uint8Array): Promise<{ body: Uint8Array; from: number; to: number }> {
  const input = join(workdir, `${crypto.randomUUID()}.mp3`)
  const output = `${input}.opus`
  try {
    writeFileSync(input, mp3)
    const from = await probeKbps(input)
    const to = targetBitrate(from)
    // Sempre VBR: o alvo é média. Sair abaixo dele não é erro — significa que a
    // fonte era mono ou sem agudos, e forçar mais bits não melhoraria nada.
    await run('ffmpeg', [
      '-loglevel',
      'error',
      '-y',
      '-i',
      input,
      '-c:a',
      'libopus',
      '-b:a',
      `${to}k`,
      '-vbr',
      'on',
      '-ar',
      '48000',
      output,
    ])
    return { body: readFileSync(output), from: Math.round(from), to }
  } finally {
    rmSync(input, { force: true })
    rmSync(output, { force: true })
  }
}

function toJpeg(raw: Uint8Array): Uint8Array {
  const decoded = bmp.decode(Buffer.from(raw))
  const rgba = Buffer.allocUnsafe(decoded.data.length)
  for (let i = 0; i < decoded.data.length; i += 4) {
    rgba[i] = decoded.data[i + 3] as number
    rgba[i + 1] = decoded.data[i + 2] as number
    rgba[i + 2] = decoded.data[i + 1] as number
    rgba[i + 3] = decoded.data[i] as number
  }
  return jpeg.encode({ data: rgba, width: decoded.width, height: decoded.height }, 85).data
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/')

/**
 * Busca na origem, que só conhece os nomes antigos, e devolve o corpo bruto.
 * O nome legado vem primeiro: para áudio a origem só tem .mp3, então tentar o
 * .opus antes gastava uma ida e volta em 404 para cada uma das 2.415 faixas.
 */
async function fetchOrigin(key: string, legacyExt: string): Promise<Uint8Array | null> {
  const base = key.slice(0, key.lastIndexOf('.'))
  for (const candidate of [`${base}.${legacyExt}`, key]) {
    const res = await fetchLegacy(`/file/${encodePath(candidate)}`)
    if (res.status === 200 && res.body.length > 0) return res.body
  }
  return null
}

/** Imagem já existe como .jpg na origem; o .bmp é só o fallback histórico. */
async function fetchJpeg(key: string): Promise<Uint8Array | null> {
  const direct = await fetchLegacy(`/file/${encodePath(key)}`)
  if (direct.status === 200 && direct.body.length > 0) return direct.body
  const bmp = await fetchLegacy(`/file/${encodePath(`${key.slice(0, -4)}.bmp`)}`)
  return bmp.status === 200 && bmp.body.length > 0 ? bmp.body : null
}

let keys: string[]
try {
  keys = readFileSync('missing-media.txt', 'utf8').split('\n').filter(Boolean)
} catch {
  console.log('missing-media.txt não existe — rode "npm run ingest" primeiro.')
  process.exit(0)
}

// Pula o que já foi para o bucket, para a execução ser retomável.
const present = new Set(await r2.list('musics/'))
for (const k of await r2.list('images/')) present.add(k)
const pending = keys.filter((k) => !present.has(k))
const jaNoBucket = keys.length - pending.length
if (LIMIT > 0) pending.length = Math.min(pending.length, LIMIT)

console.log(
  `${keys.length} na lista | ${jaNoBucket} já no bucket | ${pending.length} a buscar` +
    (LIMIT > 0 ? ` (limitado a ${LIMIT})` : '') +
    '\n',
)

let ok = 0
let bytes = 0
const failed: string[] = []

await pool(pending, CONCURRENCY, async (key) => {
  const lower = key.toLowerCase()
  try {
    if (lower.endsWith('.opus')) {
      const raw = await fetchOrigin(key, 'mp3')
      if (!raw) return void failed.push(key)
      const { body, from, to } = await toOpus(raw)
      await r2.put(key, body, 'audio/ogg')
      bytes += body.length
      console.log(
        `  ${key} — mp3 ${from}k (${(raw.length / 1024) | 0}KB) -> opus ${to}k (${(body.length / 1024) | 0}KB)`,
      )
    } else if (lower.endsWith('.jpg')) {
      const raw = await fetchJpeg(key)
      if (!raw) return void failed.push(key)
      const isBmp = raw[0] === 0x42 && raw[1] === 0x4d
      const body = isBmp ? toJpeg(raw) : raw
      await r2.put(key, body, 'image/jpeg')
      bytes += body.length
      console.log(`  ${key} — ${(body.length / 1024) | 0}KB`)
    } else {
      const res = await fetchLegacy(`/file/${encodePath(key)}`)
      if (res.status !== 200) return void failed.push(key)
      await r2.put(key, res.body, 'application/octet-stream')
      bytes += res.body.length
      console.log(`  ${key} — ${(res.body.length / 1024) | 0}KB`)
    }
    ok++
  } catch (e) {
    console.warn(`  FALHA ${key}: ${(e as Error).message}`)
    failed.push(key)
  }
})

rmSync(workdir, { recursive: true, force: true })

console.log(
  `\n${ok} adicionadas (${(bytes / 1024 / 1024).toFixed(1)}MB), ${failed.length} indisponíveis`,
)
for (const f of failed.slice(0, 20)) console.log(`  - ${f}`)
if (failed.length > 20) console.log(`  ... e mais ${failed.length - 20}`)
