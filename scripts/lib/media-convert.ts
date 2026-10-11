/**
 * Conversão de mídia do acervo. Mesmas regras do cron que trazia os arquivos
 * da API antiga (scripts/sync-media.ts), validadas por ABX.
 */
import { execFile } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import bmp from 'bmp-js'
import jpeg from 'jpeg-js'

const run = promisify(execFile)

/**
 * Até este bitrate o MP3 fica como está. Converter 128k para Opus não
 * economiza espaço e empilha uma segunda geração de perda sobre um material
 * que já tem artefatos.
 */
export const KEEP_SOURCE_UP_TO_KBPS = 128

/** Bitrate Opus por bitrate da fonte: Opus precisa de ~60% do MP3 para soar igual. */
const BITRATE_LADDER: Array<[maxSourceKbps: number, targetKbps: number]> = [
  [160, 112],
  [Number.POSITIVE_INFINITY, 128],
]

const MP3_RATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]

/**
 * O ffprobe reporta o bitrate do contêiner, com o overhead dos frames: um MP3
 * de 128k mede 128,04k. Ancorar no bitrate nominal mais próximo evita que a
 * faixa caia um degrau acima.
 */
export function nominalKbps(measured: number): number {
  return MP3_RATES.reduce((best, rate) =>
    Math.abs(rate - measured) < Math.abs(best - measured) ? rate : best,
  )
}

export function opusTargetKbps(sourceKbps: number): number {
  const nominal = nominalKbps(sourceKbps)
  return (BITRATE_LADDER.find(([max]) => nominal <= max) as [number, number])[1]
}

export const isBmp = (body: Uint8Array) => body[0] === 0x42 && body[1] === 0x4d

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

/** Bitrate nominal do MP3, sem convertê-lo: decide se vale transcodificar. */
export async function mp3Kbps(mp3: Uint8Array, workdir: string): Promise<number> {
  const input = join(workdir, `${crypto.randomUUID()}.mp3`)
  try {
    writeFileSync(input, mp3)
    return nominalKbps(await probeKbps(input))
  } finally {
    rmSync(input, { force: true })
  }
}

export async function mp3ToOpus(
  mp3: Uint8Array,
  workdir: string,
): Promise<{ body: Uint8Array; from: number; to: number }> {
  const input = join(workdir, `${crypto.randomUUID()}.mp3`)
  const output = `${input}.opus`
  try {
    writeFileSync(input, mp3)
    const from = await probeKbps(input)
    const to = opusTargetKbps(from)
    // Sempre VBR: o alvo é média. Sair abaixo dele significa fonte mono ou sem
    // agudos, e forçar mais bits não melhoraria nada.
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

export function bmpToJpeg(raw: Uint8Array): Uint8Array {
  const decoded = bmp.decode(Buffer.from(raw))
  // bmp-js decodifica em ABGR; jpeg-js espera RGBA.
  const rgba = Buffer.allocUnsafe(decoded.data.length)
  for (let i = 0; i < decoded.data.length; i += 4) {
    rgba[i] = decoded.data[i + 3] as number
    rgba[i + 1] = decoded.data[i + 2] as number
    rgba[i + 2] = decoded.data[i + 1] as number
    rgba[i + 3] = decoded.data[i] as number
  }
  return jpeg.encode({ data: rgba, width: decoded.width, height: decoded.height }, 85).data
}
