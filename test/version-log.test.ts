import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index.ts'

const fetchMock = vi.fn<typeof fetch>()

async function call(path: string, init?: RequestInit) {
  const context = createExecutionContext()
  const response = await worker.fetch(new Request(`https://api.test${path}`, init), env, context)
  await waitOnExecutionContext(context)
  return response
}

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  await env.FILES.put(
    'meta/params.json',
    JSON.stringify({ pt_version: '26.11.0', es_version: '26.10.2' }),
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('/version_log', () => {
  it('busca a release correspondente e escapa as notas antes de montar o HTML', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ body: 'Correção importante\n<script>alert(1)</script>' }),
    )

    const response = await call('/version_log?lang=pt')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/louvorja/desktop/releases/tags/v26.11',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(html).toContain('<h1>26.11.0</h1>')
    expect(html).toContain('Correção importante<br>&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('aceita os nomes version e versao e devolve mensagem útil para release ausente', async () => {
    fetchMock.mockResolvedValue(Response.json({ message: 'Not Found' }, { status: 404 }))

    const response = await call('/version_log?versao=25.9.7&lang=es')
    const html = await response.text()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/louvorja/desktop/releases/tags/v25.9',
      expect.any(Object),
    )
    expect(html).toContain('<h1>25.9.7</h1>')
    expect(html).toContain('Não foi possivel encontrar informações sobre a versão 25.9.7!')
  })

  it('não consulta a rede para uma versão inválida', async () => {
    const response = await call('/version_log?version=%3Cscript%3E')
    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.text()).toContain('&lt;script&gt;')
  })
})
