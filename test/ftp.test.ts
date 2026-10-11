import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../src/index.ts'
import type { Bindings } from '../src/types.ts'

const FTP = JSON.stringify({
  pt: { host: '203.0.113.7', port: 21, root: '/', username: 'usuario', password: 'se=nha' },
  es: { host: '203.0.113.7', port: 2121, root: '/es/', username: 'usuario', password: 'se=nha' },
})

const call = async (path: string, overrides: Partial<Bindings> = {}, init: RequestInit = {}) => {
  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request(`https://api.test${path}`, init),
    { ...env, ...overrides } as Bindings,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return response
}

const decode = (value: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)))

const claimsOf = (token: string) => {
  const payload = (token.split('.')[1] ?? '').replaceAll('-', '+').replaceAll('_', '/')
  return JSON.parse(decode(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))) as {
    iat: number
    exp: number
    sub: string
  }
}

const handshakeOf = async (overrides: Partial<Bindings>) => {
  const body = (await (await call('/params', overrides)).json()) as { conn_ftp: string }
  return new URL(body.conn_ftp)
}

beforeAll(async () => {
  await env.FILES.put('meta/params.json', JSON.stringify({ db_version: 185, help: 'x' }))
})

describe('FTP desligado (sem servidor configurado)', () => {
  it('não anuncia conn_ftp e avisa que o FTP foi descontinuado', async () => {
    expect(await (await call('/params')).json()).toEqual({ db_version: 185, help: 'x' })
    for (const path of ['/ftp', '/pt/ftp']) {
      const response = await call(path)
      expect(response.status).toBe(410)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })
})

describe('FTP entregue ao Delphi', () => {
  const on = { FTP_COMPAT_CONFIG: FTP }

  it('anuncia conn_ftp em /params, no JSON e no INI, sem perder o cache', async () => {
    const response = await call('/params', on)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ db_version: 185, help: 'x' })
    // Sempre o domínio antigo, qualquer que seja o domínio do pedido: é o único
    // em que a Cloudflare deixa o Delphi passar, e o cache de /params é um só.
    expect(String(body.conn_ftp)).toMatch(/^https:\/\/api\.louvorja\.com\.br\/ftp\?token=/)
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=3600, stale-while-revalidate=86400',
    )

    const ini = await (await call('/params?type=env', on)).text()
    expect(ini).toMatch(
      /^db_version=185\r\nhelp=x\r\nconn_ftp=https:\/\/api\.louvorja\.com\.br\/ftp\?token=.+\r\n$/,
    )
  })

  // /params pode ser servido do cache por uma hora e vencido por mais um dia.
  // O Delphi busca os vídeos online no endereço de `coletaneas_online`. No
  // workers.dev a Cloudflare responde 403 à identificação dele.
  it('entrega com o domínio antigo todo endereço desta API em /params', async () => {
    await env.FILES.put(
      'meta/params.json',
      JSON.stringify({
        db_version: 185,
        coletaneas_online: 'https://api.louvorja.workers.dev/onlinevideos',
        version_log: 'https://api.louvorja.workers.dev/version_log',
        help: 'https://louvorja.com.br/ajuda/',
        pt_download: 'https://github.com/louvorja/desktop/releases/download/v1/x.exe',
      }),
    )
    try {
      for (const origin of ['https://api.louvorja.workers.dev', 'https://api.louvorja.com.br']) {
        const ctx = createExecutionContext()
        const response = await worker.fetch(new Request(`${origin}/params`), env, ctx)
        await waitOnExecutionContext(ctx)
        expect(await response.json()).toEqual({
          db_version: 185,
          coletaneas_online: 'https://api.louvorja.com.br/onlinevideos',
          version_log: 'https://api.louvorja.com.br/version_log',
          help: 'https://louvorja.com.br/ajuda/',
          pt_download: 'https://github.com/louvorja/desktop/releases/download/v1/x.exe',
        })
      }
    } finally {
      await env.FILES.put('meta/params.json', JSON.stringify({ db_version: 185, help: 'x' }))
    }
  })

  it('emite um token que sobrevive ao cache de /params', async () => {
    const claims = claimsOf((await handshakeOf(on)).searchParams.get('token') ?? '')
    expect(claims.sub).toBe('ftp')
    expect(claims.exp - claims.iat).toBeGreaterThanOrEqual(26 * 60 * 60)
  })

  it('devolve o INI em Base64 com as chaves e a ordem da API PHP', async () => {
    const url = await handshakeOf(on)
    // O Delphi acrescenta os dados dele depois do token.
    const response = await call(`${url.pathname}${url.search}&data=JmxhbmQ9eA==&lang=PT`, on)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=UTF-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(decode(await response.text())).toBe(
      'host=203.0.113.7\r\nport=21\r\nroot=/\r\npassword=se=nha\r\nusername=usuario\r\nlang=pt\r\n',
    )
  })

  it('escolhe o idioma pelo caminho ou pela query', async () => {
    const url = await handshakeOf(on)
    const byPath = decode(await (await call(`/es/ftp${url.search}`, on)).text())
    expect(byPath).toContain('port=2121\r\nroot=/es/\r\n')
    expect(byPath).toContain('lang=es\r\n')
    const byQuery = decode(await (await call(`/ftp${url.search}&lang=es`, on)).text())
    expect(byQuery).toContain('lang=es\r\n')
  })

  it('recusa token ausente, inválido ou de sessão do painel', async () => {
    expect((await call('/ftp', on)).status).toBe(401)
    expect((await call('/ftp?token=abc.def.ghi', on)).status).toBe(401)
  })

  // O token é público (está em /params) e assinado com o segredo do painel.
  it('não deixa o token do FTP abrir o painel nem chegar ao banco', async () => {
    const token = (await handshakeOf(on)).searchParams.get('token') ?? ''
    const semBanco = new Proxy({} as D1Database, {
      get() {
        throw new Error('token do FTP chegou ao D1')
      },
    })
    for (const path of ['/auth/me', '/admin/musics', '/tasks']) {
      const response = await call(
        path,
        { ...on, DB: semBanco },
        { headers: { Authorization: `Bearer ${token}` } },
      )
      expect(response.status, path).toBe(401)
    }
  })

  it('trata configuração inválida como FTP desligado', async () => {
    for (const config of ['não é json', '{}', JSON.stringify({ pt: { host: 'x' } })]) {
      const overrides = { FTP_COMPAT_CONFIG: config }
      expect(await (await call('/params', overrides)).json()).toEqual({
        db_version: 185,
        help: 'x',
      })
      expect((await call('/ftp', overrides)).status).toBe(410)
    }
  })
})
