/**
 * Funde os relatórios do ciclo num resumo legível e o entrega.
 *
 * O pipeline publica sem pedir aprovação, então o resumo é a única coisa que
 * separa "se mantém sozinho" de "muda sozinho sem ninguém saber". Ele conta o
 * que entrou, em que bitrate e quanto o acervo cresceu.
 *
 * Também é aqui que a `version` da origem é gravada no estado — só depois de
 * tudo ter passado. Marcar antes faria uma falha de mídia congelar o ciclo
 * seguinte, porque o gate não veria mais mudança.
 *
 *   node --env-file=.env --experimental-strip-types scripts/report.ts \
 *     --version=<epoch> --version-number=<n> [--failed]
 */
import { appendFileSync, readFileSync } from 'node:fs'
import * as pipeline from './lib/state.ts'

const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const VERSION = Number(args.get('version') ?? 0)
const VERSION_NUMBER = Number(args.get('version-number') ?? 0)
const FALHOU = args.has('failed')

type IngestReport = { changed: string[]; saved: number; failed: number; missing: string[] }
type MediaItem = {
  key: string
  kind: 'opus' | 'mp3' | 'jpeg' | 'raw'
  sourceKbps?: number
  targetKbps?: number
  bytes: number
}
type MediaReport = { itens: MediaItem[]; bytes: number; failed: string[]; pending: number }

const ler = <T>(f: string, vazio: T): T => {
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as T
  } catch {
    return vazio
  }
}

const ingest = ler<IngestReport>('ingest-report.json', {
  changed: [],
  saved: 0,
  failed: 0,
  missing: [],
})
const media = ler<MediaReport>('media-report.json', {
  itens: [],
  bytes: 0,
  failed: [],
  pending: 0,
})

// --------------------------------------------------------------- nomes
/**
 * O relatório fala de faixa, não de chave de objeto — quem lê quer saber que
 * música entrou. O nome vem do próprio catálogo que acabou de ser publicado.
 */
function nomeDaFaixa(key: string): string {
  const arquivo = key.slice(key.lastIndexOf('/') + 1).replace(/\.(opus|mp3)$/i, '')
  const album = key.split('/').slice(0, -1).pop() ?? ''
  return album ? `${arquivo} — ${album}` : arquivo
}

const audio = media.itens.filter((i) => i.kind === 'opus' || i.kind === 'mp3')
const capas = media.itens.filter((i) => i.kind === 'jpeg')

const porAlvo = new Map<string, number>()
for (const i of audio) {
  const rotulo =
    i.kind === 'mp3'
      ? `mp3 ${i.sourceKbps}k mantido`
      : `opus ${i.targetKbps}k (de ${i.sourceKbps}k)`
  porAlvo.set(rotulo, (porAlvo.get(rotulo) ?? 0) + 1)
}

const linhas: string[] = []
linhas.push(FALHOU ? '## Ingestão falhou' : '## Ingestão concluída')

if (VERSION_NUMBER) linhas.push(`\nCatálogo da origem: **db_version ${VERSION_NUMBER}**`)
linhas.push(
  `\n- ${ingest.changed.length} tabelas mudaram, ${ingest.saved} gravadas` +
    (ingest.failed ? `, **${ingest.failed} falharam**` : ''),
)

if (audio.length > 0) {
  linhas.push(`- **${audio.length} faixas novas** (${(media.bytes / 1048576).toFixed(1)} MB)`)
  for (const [rotulo, n] of [...porAlvo.entries()].sort((a, b) => b[1] - a[1])) {
    linhas.push(`  - ${n}× ${rotulo}`)
  }
  linhas.push('')
  for (const i of audio.slice(0, 25)) linhas.push(`  - ${nomeDaFaixa(i.key)}`)
  if (audio.length > 25) linhas.push(`  - … e mais ${audio.length - 25}`)
} else {
  linhas.push('- Nenhuma faixa nova')
}

if (capas.length > 0) linhas.push(`- ${capas.length} capas novas`)
if (media.pending > 0) {
  linhas.push(`- ${media.pending} mídias ficaram para o próximo ciclo (teto por execução)`)
}
if (media.failed.length > 0) {
  linhas.push(`- **${media.failed.length} mídias indisponíveis na origem**`)
  for (const f of media.failed.slice(0, 10)) linhas.push(`  - ${f}`)
}

const markdown = linhas.join('\n')
console.log(markdown)

const summary = process.env.GITHUB_STEP_SUMMARY
if (summary) appendFileSync(summary, `${markdown}\n`)

// ----------------------------------------------------------- telegram
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CHAT = process.env.TELEGRAM_CHAT_ID
const houveNovidade = audio.length > 0 || capas.length > 0 || ingest.changed.length > 0

if (TOKEN && CHAT && (houveNovidade || FALHOU)) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Telegram corta em 4096; o resumo já é curto, mas lote grande estoura.
    body: JSON.stringify({
      chat_id: CHAT,
      text: markdown.slice(0, 4000),
      parse_mode: 'Markdown',
    }),
  })
  console.log(res.ok ? '\nTelegram: enviado' : `\nTelegram: HTTP ${res.status}`)
} else if (!TOKEN || !CHAT) {
  console.log('\nTelegram: não configurado (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)')
}

// ---------------------------------------------------------------- estado
// Só marca a origem como vista se o ciclo inteiro passou. Falhou, o gate
// dispara de novo amanhã em vez de dar o trabalho por feito.
if (!FALHOU && VERSION) {
  const estado = await pipeline.load()
  await pipeline.save({
    ...estado,
    version: VERSION,
    version_number: VERSION_NUMBER,
    media_pending: media.pending,
  })
  console.log(`Estado atualizado: version ${VERSION}, ${media.pending} mídias pendentes`)
} else if (FALHOU) {
  // Mesmo falhando, o saldo pendente precisa ficar registrado.
  const estado = await pipeline.load()
  await pipeline.save({ ...estado, media_pending: media.pending })
  console.log('Ciclo falhou — version NÃO foi marcada como vista')
}
