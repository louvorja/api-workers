import { env } from 'cloudflare:test'
import { beforeAll, expect, it } from 'vitest'
import { serveObject } from '../src/lib/r2.ts'

const get = (headers: Record<string, string> = {}, method = 'GET') =>
  serveObject(
    env.FILES,
    'range-test.zip',
    new Request('https://api.test/db/bundle', { headers, method }),
    'private, max-age=3600',
  )
beforeAll(async () => {
  await env.FILES.put('range-test.zip', '0123456789')
})
it('HEAD tem tamanho, ETag e nenhum corpo', async () => {
  const res = (await get({}, 'HEAD'))!
  expect(res.status).toBe(200)
  expect(res.headers.get('content-length')).toBe('10')
  expect(res.headers.get('etag')).toBeTruthy()
  expect(await res.text()).toBe('')
})
it('Range normal, aberto, sufixo e truncamento', async () => {
  for (const [range, expected] of [
    ['bytes=0-3', '0123'],
    ['bytes=8-', '89'],
    ['bytes=-2', '89'],
    ['bytes=8-30', '89'],
  ]) {
    const res = (await get({ Range: range! }))!
    expect(res.status).toBe(206)
    expect(await res.text()).toBe(expected)
  }
})
it('intervalo fora do arquivo resulta em 416', async () => {
  const res = (await get({ Range: 'bytes=100-' }))!
  expect(res.status).toBe(416)
  expect(res.headers.get('content-range')).toBe('bytes */10')
})
it('If-Match rejeita ETag incorreto e fraco com 412', async () => {
  const tag = (await get({}, 'HEAD'))!.headers.get('etag')!
  for (const value of ['"wrong"', `W/${tag}`])
    expect((await get({ 'If-Match': value }))!.status).toBe(412)
  expect((await get({ 'If-Match': tag }))!.status).toBe(200)
})
it('If-None-Match aceita ETag fraco e tem precedência sobre data', async () => {
  const tag = (await get({}, 'HEAD'))!.headers.get('etag')!
  expect((await get({ 'If-None-Match': `W/${tag}` }))!.status).toBe(304)
  expect(
    (await get({
      'If-None-Match': '"wrong"',
      'If-Modified-Since': 'Sun, 11 Oct 2099 00:00:00 GMT',
    }))!.status,
  ).toBe(200)
})
it('If-Range antigo ou fraco retorna arquivo completo; correto retorna trecho', async () => {
  const tag = (await get({}, 'HEAD'))!.headers.get('etag')!
  for (const value of ['"wrong"', `W/${tag}`]) {
    const res = (await get({ Range: 'bytes=0-3', 'If-Range': value }))!
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('0123456789')
  }
  const res = (await get({ Range: 'bytes=0-3', 'If-Range': tag }))!
  expect(res.status).toBe(206)
  expect(await res.text()).toBe('0123')
})
it('data de modificação respeita condicionais', async () => {
  const modified = (await get({}, 'HEAD'))!.headers.get('last-modified')!
  expect((await get({ 'If-Modified-Since': modified }))!.status).toBe(304)
  expect((await get({ 'If-Unmodified-Since': 'Mon, 01 Jan 2001 00:00:00 GMT' }))!.status).toBe(412)
})
it('Range inválido/múltiplo e HEAD são ignorados', async () => {
  for (const range of ['bytes=4-2', 'bytes=0-1,4-5', 'nonsense'])
    expect((await get({ Range: range }))!.status).toBe(200)
  expect((await get({ Range: 'bytes=100-' }, 'HEAD'))!.status).toBe(200)
})
