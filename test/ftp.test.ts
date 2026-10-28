import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { FTP_MESSAGES } from '../src/features/ftp.ts'
import worker from '../src/index.ts'

const call = async (path: string, origin = 'https://api.test') => {
  const ctx = createExecutionContext()
  const response = await worker.fetch(new Request(`${origin}${path}`), env, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

const decode = (value: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)))

beforeAll(async () => {
  await env.FILES.put('meta/params.json', JSON.stringify({ db_version: 185, help: 'x' }))
})

describe('FTP desligado, com aviso às versões antigas do Delphi', () => {
  it('anuncia conn_ftp em /params, no JSON e no INI, sem perder o cache', async () => {
    const response = await call('/params')
    // Sempre o domínio antigo, qualquer que seja o domínio do pedido: é o único
    // em que a Cloudflare deixa o Delphi passar, e o cache de /params é um só.
    expect(await response.json()).toEqual({
      db_version: 185,
      help: 'x',
      conn_ftp: 'https://api.louvorja.com.br/ftp',
    })
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=3600, stale-while-revalidate=86400',
    )

    const ini = await (await call('/params?type=env')).text()
    expect(ini).toBe('db_version=185\r\nhelp=x\r\nconn_ftp=https://api.louvorja.com.br/ftp\r\n')
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
        expect(await (await call('/params', origin)).json()).toEqual({
          db_version: 185,
          coletaneas_online: 'https://api.louvorja.com.br/onlinevideos',
          version_log: 'https://api.louvorja.com.br/version_log',
          help: 'https://louvorja.com.br/ajuda/',
          pt_download: 'https://github.com/louvorja/desktop/releases/download/v1/x.exe',
          conn_ftp: 'https://api.louvorja.com.br/ftp',
        })
      }
    } finally {
      await env.FILES.put('meta/params.json', JSON.stringify({ db_version: 185, help: 'x' }))
    }
  })

  it('devolve ftp_msg em Base64, como o Delphi lê o aperto de mão', async () => {
    // O Delphi acrescenta `?data=...&lang=` ao endereço; o token vem de
    // /params antigos que ainda estejam em cache.
    for (const path of ['/ftp?data=JmxhbmQ9eA==&lang=PT', '/ftp?token=abc&data=x&lang=PT']) {
      const response = await call(path)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/plain; charset=UTF-8')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(decode(await response.text())).toBe(`ftp_msg=${FTP_MESSAGES.pt}\r\n`)
    }
  })

  it('escolhe o idioma pelo caminho ou pela query', async () => {
    expect(decode(await (await call('/es/ftp')).text())).toBe(`ftp_msg=${FTP_MESSAGES.es}\r\n`)
    expect(decode(await (await call('/ftp?data=x&lang=ES')).text())).toBe(
      `ftp_msg=${FTP_MESSAGES.es}\r\n`,
    )
    expect(decode(await (await call('/pt/ftp')).text())).toBe(`ftp_msg=${FTP_MESSAGES.pt}\r\n`)
  })

  it('escreve as mensagens só em ASCII, numa linha', () => {
    for (const message of Object.values(FTP_MESSAGES)) {
      expect(message).toMatch(/^[\x20-\x7e]+$/)
    }
  })
})
