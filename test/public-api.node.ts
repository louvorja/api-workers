import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_PUBLIC_API_URL, publicApiUrl } from '../scripts/lib/public-api.ts'

test('usa o domínio canônico quando PUBLIC_API_URL não foi definida', () => {
  assert.equal(publicApiUrl(undefined), DEFAULT_PUBLIC_API_URL)
})

test('aceita HTTPS e HTTP somente para desenvolvimento local', () => {
  assert.equal(publicApiUrl('https://api.exemplo.com'), 'https://api.exemplo.com')
  assert.equal(publicApiUrl('http://localhost:8787'), 'http://localhost:8787')
  assert.throws(() => publicApiUrl('http://api.exemplo.com'), /HTTPS/)
})

test('recusa valores que possam alterar caminhos ou vazar credenciais', () => {
  for (const value of [
    'https://user:secret@api.exemplo.com',
    'https://api.exemplo.com/v1',
    'https://api.exemplo.com?token=secret',
    ' https://api.exemplo.com',
  ]) {
    assert.throws(() => publicApiUrl(value))
  }
})
