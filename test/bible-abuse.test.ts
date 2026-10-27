import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import worker from '../src/index.ts'
import {
  type BibleAbuseState,
  bibleRetryAfter,
  recordBibleOutcome,
} from '../src/lib/bible-abuse.ts'
import type { Bindings } from '../src/types.ts'

const NOW = 1_800_000_000_000
const outcomes = (count: number, status = 404, at = NOW, initial?: BibleAbuseState) => {
  let state = initial
  for (let i = 0; i < count; i++) state = recordBibleOutcome(state, status, at)
  return state
}

describe('suspensão por capítulos inexistentes', () => {
  it('permite 49 erros e suspende após 50, por 30 minutos', () => {
    const almost = outcomes(49)
    expect(bibleRetryAfter(almost, NOW)).toBe(0)
    const blocked = recordBibleOutcome(almost, 404, NOW)
    expect(bibleRetryAfter(blocked, NOW)).toBe(1800)
    expect(bibleRetryAfter(blocked, NOW + 1_799_001)).toBe(1)
    expect(bibleRetryAfter(blocked, NOW + 1_800_000)).toBe(0)
  })

  it('exige pelo menos 90% de erros, incluindo 206 e 304 como sucessos', () => {
    let state = outcomes(2, 200)
    state = outcomes(2, 206, NOW, state)
    state = outcomes(2, 304, NOW, state)
    state = outcomes(50, 404, NOW, state)
    expect(bibleRetryAfter(state, NOW)).toBe(0)
    state = outcomes(4, 404, NOW, state) // 54/60 = 90%
    expect(bibleRetryAfter(state, NOW)).toBe(1800)
  })

  it('ignora falhas de infraestrutura, preflights e respostas do próprio limite', () => {
    for (const status of [204, 400, 403, 405, 412, 416, 429, 500, 503]) {
      expect(outcomes(60, status)).toBeUndefined()
    }
  })

  it('atravessa a virada da janela fixa, mas descarta erros de cinco minutos atrás', () => {
    const start = NOW + 299_000
    const first = outcomes(25, 404, start)
    expect(bibleRetryAfter(outcomes(25, 404, start + 2000, first), start + 2000)).toBe(1800)
    const expired = outcomes(49, 404)
    expect(bibleRetryAfter(outcomes(1, 404, NOW + 300_000, expired), NOW + 300_000)).toBe(0)
  })

  it('não prolonga a suspensão com respostas em voo; reincidência em 24h dura duas horas', () => {
    const first = outcomes(50)
    expect(recordBibleOutcome(first, 404, NOW + 1000)).toEqual(first)
    const repeatedAt = NOW + 1_800_000
    const repeat = outcomes(50, 404, repeatedAt, first)
    expect(bibleRetryAfter(repeat, repeatedAt)).toBe(7200)
    const later = repeatedAt + 86_400_000
    expect(bibleRetryAfter(outcomes(50, 404, later, repeat), later)).toBe(1800)
  })
})

const bindings = env as unknown as Bindings
const request = (ip: string, path: string, method = 'GET', extra: Partial<Bindings> = {}) =>
  worker.request(
    `https://api.test${path}`,
    {
      method,
      headers: { 'CF-Connecting-IP': ip },
    },
    { ...bindings, BIBLE_THROTTLE_MS: '0', ...extra },
  )

describe('proteção no Worker e armazenamento durável', () => {
  it('persiste contagem e suspensão após reinício, bloqueia antes do R2 e preserva outras rotas/IPs', async () => {
    const ip = '198.51.100.111'
    const stub = bindings.BIBLE_LIMITER.get(bindings.BIBLE_LIMITER.idFromName(ip))
    for (let i = 0; i < 49; i++) {
      expect(
        (await request(ip, `/json_db/bible_999_999_${i}`, i % 2 ? 'HEAD' : 'GET')).status,
      ).toBe(404)
    }
    await evictDurableObject(stub)
    expect((await request(ip, '/json_db/bible_999_999_50')).status).toBe(404)
    await evictDurableObject(stub)
    const read = vi.fn(() => {
      throw new Error('R2 não deve ser chamado durante a suspensão')
    })
    const blocked = await request(ip, '/json_db/bible_1_1_1', 'GET', {
      FILES: { get: read, head: read } as unknown as R2Bucket,
    })
    expect(blocked.status).toBe(429)
    expect(read).not.toHaveBeenCalled()
    expect(blocked.headers.get('x-ratelimit-reason')).toBe('invalid-bible-queries')
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(1790)
    expect(blocked.headers.get('cache-control')).toBe('no-store')
    expect(blocked.headers.get('access-control-expose-headers')).toContain('Retry-After')
    expect(await blocked.json()).toMatchObject({ bucket: 'bible', reason: 'invalid-bible-queries' })
    await bindings.FILES.put('json_db/bible_1_1_1.json', '[]')
    expect((await request('198.51.100.112', '/json_db/bible_1_1_1')).status).toBe(200)
    for (const path of ['/health', '/db/bible-bundle', '/json_db/pt_bible_version']) {
      expect((await request(ip, path)).status, path).not.toBe(429)
    }
    expect((await request(ip, '/json_db/bible_1_1_1', 'OPTIONS')).status).toBe(204)
  })

  it('não perde resultados concorrentes no mesmo IP', async () => {
    const stub = bindings.BIBLE_LIMITER.get(bindings.BIBLE_LIMITER.idFromName('198.51.100.113'))
    await Promise.all(Array.from({ length: 50 }, () => stub.recordResult(404)))
    expect(await stub.hit(150, 60)).toMatchObject({
      allowed: false,
      reason: 'invalid-bible-queries',
    })
  })

  it('preserva um IP com consultas válidas misturadas a 50 capítulos inexistentes', async () => {
    const ip = '198.51.100.116'
    await bindings.FILES.put('json_db/bible_1_1_1.json', '[]')
    for (let i = 0; i < 10; i++) {
      expect((await request(ip, '/json_db/bible_1_1_1')).status).toBe(200)
    }
    for (let i = 0; i < 50; i++) {
      expect((await request(ip, `/json_db/bible_999_998_${i}`)).status).toBe(404)
    }
    expect((await request(ip, '/json_db/bible_1_1_1')).status).toBe(200)
  })

  it('limpa o histórico vencido sem remover suspensões vigentes', async () => {
    const stub = bindings.BIBLE_LIMITER.get(bindings.BIBLE_LIMITER.idFromName('198.51.100.114'))
    await stub.recordResult(404)
    await runDurableObjectAlarm(stub)
    await runInDurableObject(stub, async (_instance, state) => {
      const values = await state.storage.list<BibleAbuseState>()
      expect(values.size).toBe(1)
      for (const [key, value] of values) {
        await state.storage.put(key, { ...value, expiresAt: Date.now() - 1 })
      }
    })
    await runDurableObjectAlarm(stub)
    await runInDurableObject(stub, async (_instance, state) => {
      expect((await state.storage.list()).size).toBe(0)
    })
  })

  it('falha aberta se o contador ficar indisponível, sem mascarar a resposta da rota', async () => {
    await bindings.FILES.put('json_db/bible_1_1_1.json', '[]')
    const unavailable = {
      idFromName: () => 'id',
      get: () => ({
        hit: async () => {
          throw new Error('offline')
        },
        recordResult: async () => {
          throw new Error('offline')
        },
      }),
    } as unknown as Bindings['BIBLE_LIMITER']
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(
        (
          await request('198.51.100.115', '/json_db/bible_1_1_1', 'GET', {
            BIBLE_LIMITER: unavailable,
          })
        ).status,
      ).toBe(200)
      expect(log).toHaveBeenCalledWith('window_counter_failed', expect.any(Error))
      expect(log).toHaveBeenCalledWith('bible_outcome_counter_failed', expect.any(Error))
    } finally {
      log.mockRestore()
    }
  })
})
