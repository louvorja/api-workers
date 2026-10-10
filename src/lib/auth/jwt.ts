/** JWT HS256, com as mesmas claims que o jwt-auth da origem emitia. */
export type Claims = {
  iss: string
  iat: number
  exp: number
  nbf: number
  jti: string
  sub: string
  name: string
  username: string
  id: number
}

/** A origem usa o padrão do jwt-auth: 60 minutos. */
export const TTL_SECONDS = 60 * 60

const encoder = new TextEncoder()

function toB64Url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64Url(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])

export async function sign(claims: Claims, secret: string): Promise<string> {
  const head = toB64Url(JSON.stringify({ typ: 'JWT', alg: 'HS256' }))
  const body = toB64Url(JSON.stringify(claims))
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(`${head}.${body}`),
  )
  return `${head}.${body}.${toB64Url(new Uint8Array(signature))}`
}

/** Devolve as claims quando assinatura e validade conferem; senão, null. */
export async function verify(token: string, secret: string, now: number): Promise<Claims | null> {
  const [head, body, signature] = token.split('.')
  if (!head || !body || !signature) return null

  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromB64Url(signature),
      encoder.encode(`${head}.${body}`),
    )
    if (!valid) return null

    const claims = JSON.parse(new TextDecoder().decode(fromB64Url(body))) as Claims
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null
    if (typeof claims.nbf === 'number' && claims.nbf > now) return null
    if (typeof claims.jti !== 'string' || typeof claims.sub !== 'string') return null
    return claims
  } catch {
    return null
  }
}
