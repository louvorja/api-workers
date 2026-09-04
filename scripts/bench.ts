/**
 * Benchmark da API nova contra api.louvorja.com.br.
 *
 * Mede time-to-first-byte (o fetch resolve nos headers) e tempo total até o
 * corpo terminar, mais os bytes realmente transferidos — que é onde está a
 * diferença estrutural em requisições Range.
 *
 *   node --env-file=.env --experimental-strip-types scripts/bench.ts [--runs=15]
 */
const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const RUNS = Number(args.get('runs') ?? 15)
const NEW = 'https://api.louvorja.workers.dev'
const OLD = 'https://api.louvorja.com.br'
const TOKEN = process.env.LEGACY_API_TOKEN ?? ''

type Sample = { ttfb: number; total: number; bytes: number; status: number }

async function once(url: string, headers: Record<string, string> = {}): Promise<Sample> {
  const t0 = performance.now()
  const res = await fetch(url, { headers, cache: 'no-store' })
  const ttfb = performance.now() - t0
  const body = await res.arrayBuffer()
  return { ttfb, total: performance.now() - t0, bytes: body.byteLength, status: res.status }
}

const quantile = (xs: number[], q: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] as number

async function measure(url: string, headers: Record<string, string> = {}) {
  await once(url, headers).catch(() => null) // aquece o cache dos dois lados
  const samples: Sample[] = []
  for (let i = 0; i < RUNS; i++) samples.push(await once(url, headers))
  return {
    ttfb: quantile(
      samples.map((s) => s.ttfb),
      0.5,
    ),
    p95: quantile(
      samples.map((s) => s.total),
      0.95,
    ),
    total: quantile(
      samples.map((s) => s.total),
      0.5,
    ),
    bytes: samples[0]?.bytes ?? 0,
    status: samples[0]?.status ?? 0,
  }
}

const legacyHeaders: Record<string, string> = TOKEN ? { 'Api-Token': TOKEN } : {}
const ms = (n: number) => `${n.toFixed(0)}ms`
const kb = (n: number) =>
  n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`

const CASES: Array<[label: string, path: string, headers?: Record<string, string>]> = [
  ['JSON pequeno (config)', '/json_db/config'],
  ['JSON grande (pt_musics)', '/json_db/pt_musics'],
  ['JSON médio (pt_hymnal)', '/json_db/pt_hymnal'],
  ['Música (music_1)', '/json_db/music_1'],
  ['Capítulo bíblico', '/json_db/bible_1_1_1'],
  ['Capa', '/file/covers/1992.bmp'],
  ['Imagem', '/file/images/hasd_132B.jpg'],
  [
    'Áudio, Range 100 bytes',
    '/file/musics/pt/1992%20-%20Brilha%20Jesus/Nosso%20Sol%20%C3%89%20Jesus.mp3',
    { Range: 'bytes=0-99' },
  ],
]

console.log(`Benchmark — mediana de ${RUNS} execuções, cache quente dos dois lados\n`)
console.log(
  `${'caso'.padEnd(26)}${'TTFB nova'.padStart(11)}${'TTFB antiga'.padStart(13)}` +
    `${'total nova'.padStart(12)}${'total antiga'.padStart(14)}${'bytes nova'.padStart(12)}${'bytes antiga'.padStart(14)}`,
)
console.log('-'.repeat(102))

for (const [label, path, headers] of CASES) {
  const a = await measure(`${NEW}${path}`, headers)
  const b = await measure(`${OLD}${path}`, { ...legacyHeaders, ...headers })
  console.log(
    label.padEnd(26) +
      ms(a.ttfb).padStart(11) +
      ms(b.ttfb).padStart(13) +
      ms(a.total).padStart(12) +
      ms(b.total).padStart(14) +
      kb(a.bytes).padStart(12) +
      kb(b.bytes).padStart(14),
  )
}

// Concorrência: 30 pedidos simultâneos ao mesmo objeto frio mostram se a borda
// colapsa as requisições ou se cada uma vai até a origem.
console.log('\nRajada de 30 requisições simultâneas (/json_db/pt_hymnal)')
for (const [name, base, h] of [
  ['nova', NEW, {}],
  ['antiga', OLD, legacyHeaders],
] as const) {
  const t0 = performance.now()
  const results = await Promise.all(
    Array.from({ length: 30 }, () => once(`${base}/json_db/pt_hymnal`, h).catch(() => null)),
  )
  const okCount = results.filter((r) => r?.status === 200).length
  console.log(`  ${name.padEnd(8)} ${ms(performance.now() - t0)} no total, ${okCount}/30 com 200`)
}

export {}
