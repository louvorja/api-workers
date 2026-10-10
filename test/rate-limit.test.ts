import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import worker from '../src/index.ts'
import { rateLimitPolicy } from '../src/lib/rate-limit.ts'
import type { Bindings } from '../src/types.ts'

const binding = (success: boolean) =>
  ({ limit: vi.fn(async () => ({ success })) }) as unknown as RateLimit

const call = async (path: string, overrides: Partial<Bindings> = {}, method = 'GET') => {
  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: { 'CF-Connecting-IP': '192.0.2.10' },
    }),
    { ...env, ...overrides } as Bindings,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return response
}

describe('rate limiting compatível com a API PHP', () => {
  it('classifica arquivos, metadados, idioma e rotas gerais', () => {
    expect(rateLimitPolicy('/file/musics/pt/a.mp3')).toMatchObject({
      bucket: 'files',
      limit: 10_000,
    })
    expect(rateLimitPolicy('/pt-BR/file/capa.bmp').bucket).toBe('files')
    expect(rateLimitPolicy('/player').bucket).toBe('files')
    expect(rateLimitPolicy('/version_log').bucket).toBe('metadata')
    expect(rateLimitPolicy('/params')).toMatchObject({ bucket: 'general', limit: 5_000 })
  })

  it('responde 429 no formato legado e não executa a rota', async () => {
    const denied = binding(false)
    const response = await call('/params', { RATE_LIMIT_GENERAL: denied })

    expect(response.status).toBe(429)
    expect(response.headers.get('x-ratelimit-bucket')).toBe('general')
    expect(response.headers.get('x-ratelimit-limit')).toBe('5000')
    expect(response.headers.get('retry-after')).toBe('60')
    expect(await response.json()).toEqual({
      error: 'Too Many Requests',
      message: 'Limite de requisicoes excedido. Tente novamente em breve.',
      retry_after: 60,
      bucket: 'general',
    })
    expect(denied.limit).toHaveBeenCalledWith({ key: '192.0.2.10' })
  })

  it('não limita health nem preflight', async () => {
    const denied = binding(false)
    const health = await call('/health', {
      RATE_LIMIT_GENERAL: denied,
      RATE_LIMIT_FILES: denied,
      RATE_LIMIT_METADATA: denied,
    })
    const preflight = await call(
      '/params',
      {
        RATE_LIMIT_GENERAL: denied,
        RATE_LIMIT_FILES: denied,
        RATE_LIMIT_METADATA: denied,
      },
      'OPTIONS',
    )

    expect(health.status).not.toBe(429)
    expect(preflight.status).toBe(204)
    expect(denied.limit).not.toHaveBeenCalled()
  })

  it('params não depende do segredo do painel', async () => {
    await env.FILES.put('meta/params.json', JSON.stringify({ db_version: 185 }))
    const response = await call('/params', { JWT_SECRET: '' })
    expect(response.status).toBe(200)
  })
})
