/**
 * Converte as capas .bmp do bucket para .jpg.
 *
 * A API legada convertia a cada request (e ainda devolvia o Content-Type
 * errado). Converter uma vez no acervo tira CPU do caminho quente e derruba
 * ~56KB por capa para ~7KB. Os .bmp permanecem no bucket; /file passa a
 * preferir o .jpg.
 *
 *   node --experimental-strip-types scripts/convert-covers.ts [--force]
 */
import bmp from 'bmp-js'
import jpeg from 'jpeg-js'
import * as r2 from './lib/r2.ts'

const force = process.argv.includes('--force')

/** bmp-js decodifica em ABGR; jpeg-js espera RGBA. */
function abgrToRgba(data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length)
  for (let i = 0; i < data.length; i += 4) {
    out[i] = data[i + 3] as number
    out[i + 1] = data[i + 2] as number
    out[i + 2] = data[i + 1] as number
    out[i + 3] = data[i] as number
  }
  return out
}

const keys = await r2.list('covers/')
const bmps = keys.filter((k) => k.toLowerCase().endsWith('.bmp'))
const existing = new Set(keys)

console.log(`${bmps.length} capas .bmp no bucket`)

let converted = 0
let copied = 0
let skipped = 0
let bytesBefore = 0
let bytesAfter = 0

/** Nem todo arquivo .bmp do acervo é BMP — alguns já são JPEG/PNG renomeados. */
function sniff(b: Uint8Array): 'bmp' | 'jpeg' | 'png' | 'unknown' {
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  return 'unknown'
}

for (const key of bmps) {
  const target = `${key.slice(0, -4)}.jpg`
  if (!force && existing.has(target)) {
    skipped++
    continue
  }

  const raw = await r2.get(key)
  if (raw === null) continue

  const format = sniff(raw)
  if (format === 'unknown') {
    console.warn(`  ${key}: formato não reconhecido, ignorado`)
    continue
  }

  // Já é uma imagem comprimida: republica sob a chave .jpg com o tipo real,
  // que é o que o cliente vai pedir depois da reescrita das URLs.
  if (format !== 'bmp') {
    await r2.put(target, raw, `image/${format}`)
    console.log(`  ${key} -> ${target} (${format}, copiado sem recodificar)`)
    copied++
    continue
  }

  const decoded = bmp.decode(Buffer.from(raw))
  const encoded = jpeg.encode(
    { data: abgrToRgba(decoded.data), width: decoded.width, height: decoded.height },
    85,
  )

  await r2.put(target, encoded.data, 'image/jpeg')
  bytesBefore += raw.length
  bytesAfter += encoded.data.length
  converted++
  console.log(`  ${key} -> ${target} (${raw.length} -> ${encoded.data.length} bytes)`)
}

console.log(
  `\n${converted} convertidas, ${copied} copiadas, ${skipped} já existiam.` +
    (converted > 0
      ? ` ${(bytesBefore / 1024).toFixed(0)}KB -> ${(bytesAfter / 1024).toFixed(0)}KB`
      : ''),
)
