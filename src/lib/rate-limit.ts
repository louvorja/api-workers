import type { MiddlewareHandler } from 'hono'
import type { App, Bindings } from '../types.ts'
import { countHit } from './window-counter.ts'

export type RateLimitBucket = 'files' | 'metadata' | 'general' | 'bible'

type RateLimitBinding = 'RATE_LIMIT_FILES' | 'RATE_LIMIT_METADATA' | 'RATE_LIMIT_GENERAL'

export type RateLimitPolicy = {
  /** O balde `bible` não usa binding: o contador é próprio (window-counter.ts). */
  binding: RateLimitBinding | null
  bucket: RateLimitBucket
  limit: number
  period: 60
}

const POLICY: Record<RateLimitBucket, RateLimitPolicy> = {
  files: { binding: 'RATE_LIMIT_FILES', bucket: 'files', limit: 10_000, period: 60 },
  metadata: {
    binding: 'RATE_LIMIT_METADATA',
    bucket: 'metadata',
    limit: 10_000,
    period: 60,
  },
  general: { binding: 'RATE_LIMIT_GENERAL', bucket: 'general', limit: 5_000, period: 60 },
  // Capítulo avulso da Bíblia: só leitura de tela ou robô. Quem quer tudo usa o pacote.
  bible: { binding: null, bucket: 'bible', limit: 60, period: 60 },
}

const LANG_PREFIXES = new Set(['pt-BR', 'en', 'es', 'fr', 'de', 'it', 'ru', 'zh', 'ja', 'ko'])

function normalizedPath(path: string): string {
  const segments = path.split('/')
  if (segments.length > 1 && LANG_PREFIXES.has(segments[1] ?? '')) {
    return `/${segments.slice(2).join('/')}`
  }
  return path.startsWith('/') ? path : `/${path}`
}

/** Mantém as mesmas três classes e tetos por minuto da API PHP. */
export function rateLimitPolicy(path: string): RateLimitPolicy {
  const normalized = normalizedPath(path)
  if (normalized.startsWith('/json_db/bible_')) return POLICY.bible
  if (normalized.startsWith('/file/') || normalized.startsWith('/player')) return POLICY.files
  if (['/version', '/version_log', '/metadata'].includes(normalized)) return POLICY.metadata
  return POLICY.general
}

function limiter(env: Bindings, binding: RateLimitBinding): RateLimit {
  return env[binding]
}

async function withinLimit(c: Parameters<MiddlewareHandler<App>>[0], policy: RateLimitPolicy) {
  const actor = c.req.header('CF-Connecting-IP') ?? 'unknown-client'
  if (policy.binding === null) {
    const limit = Number(c.env.BIBLE_LIMIT_PER_MINUTE ?? policy.limit) || policy.limit
    return (await countHit(c.env.BIBLE_LIMITER, actor, limit, policy.period)).allowed
  }
  return (await limiter(c.env, policy.binding).limit({ key: actor })).success
}

/**
 * O binding da Cloudflare é local ao PoP e deliberadamente aproximado. Isso é
 * suficiente para proteção contra abuso, mas não deve ser usado como medidor.
 */
export const applyRateLimit: MiddlewareHandler<App> = async (c, next) => {
  if (c.req.method === 'OPTIONS' || c.req.path === '/health') {
    await next()
    return
  }

  const policy = rateLimitPolicy(c.req.path)
  const success = await withinLimit(c, policy)
  const describe = () => {
    c.header('X-RateLimit-Limit', String(policy.limit))
    c.header('X-RateLimit-Reset', String(Math.floor(Date.now() / 1000) + policy.period))
    c.header('X-RateLimit-Bucket', policy.bucket)
  }

  if (!success) {
    // Quem varre capítulo por capítulo espera cada resposta antes do próximo
    // pedido; segurar o 429 desacelera esse robô, e recusar na hora não.
    if (policy.bucket === 'bible') {
      const wait = Number(c.env.BIBLE_THROTTLE_MS ?? 0)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    }
    describe()
    c.header('X-RateLimit-Remaining', '0')
    c.header('Retry-After', String(policy.period))
    c.header('Cache-Control', 'no-store')
    return c.json(
      {
        error: 'Too Many Requests',
        message:
          policy.bucket === 'bible'
            ? 'Limite de capítulos excedido. Para a Bíblia inteira use /db/bible-bundle, um arquivo só.'
            : 'Limite de requisicoes excedido. Tente novamente em breve.',
        retry_after: policy.period,
        bucket: policy.bucket,
      },
      429,
    )
  }

  await next()
  // Só depois do handler: várias rotas devolvem um Response montado à mão, e o
  // que foi posto no contexto antes dele não chega à resposta.
  describe()
}
