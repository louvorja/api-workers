import { type Context, Hono } from 'hono'
import { sign, verify } from '../lib/auth/jwt.ts'
import type { App, Bindings } from '../types.ts'

/**
 * Entrega ao programa Delphi o servidor de FTP de onde ele baixa o acervo.
 *
 * O Worker não fala FTP: ele só responde o "aperto de mão" HTTPS que a API PHP
 * fazia, devolvendo host, porta e credenciais de um servidor que existe à parte.
 * Os dados vêm do secret FTP_COMPAT_CONFIG; sem ele, o FTP está desligado e a
 * rota avisa isso em vez de sumir.
 */
type FtpConnection = {
  host: string
  port: number
  root: string
  username: string
  password: string
}

const LANGS = new Set(['pt', 'es'])

/**
 * Validade do token de `conn_ftp`. /params fica em cache por uma hora e pode
 * ser servido vencido por mais um dia enquanto revalida: o token precisa
 * sobreviver a isso e à tela de atualização do Delphi. Ele não protege as
 * credenciais (qualquer um pede /params); só evita que /ftp seja varrido solto.
 */
const TOKEN_TTL_SECONDS = 48 * 60 * 60

const singleLine = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && !/[\0\r\n]/.test(text) ? text : null
}

export function ftpConnection(raw: string | undefined, lang: string): FtpConnection | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const candidate = (parsed[lang] ?? parsed) as Record<string, unknown>
    const host = singleLine(candidate.host)
    const root = singleLine(candidate.root ?? '/')
    const username = singleLine(candidate.username)
    const password = singleLine(candidate.password)
    const port = Number(candidate.port ?? 21)
    if (!host || !root || !username || !password) return null
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host, port, root, username, password }
  } catch {
    return null
  }
}

export const ftpEnabled = (env: Bindings) =>
  Boolean(env.JWT_SECRET) && ftpConnection(env.FTP_COMPAT_CONFIG, 'pt') !== null

/** URL que o Delphi lê em `conn_ftp`; ele acrescenta `&data=...&lang=...` e chama. */
export async function ftpHandshakeUrl(origin: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const token = await sign(
    {
      iss: origin,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
      nbf: now,
      jti: crypto.randomUUID(),
      sub: 'ftp',
      name: 'FTP',
      username: 'ftp',
      id: 0,
    },
    secret,
  )
  return `${origin}/ftp?token=${encodeURIComponent(token)}`
}

function base64(text: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Versão do programa que pediu, para acompanhar quem ainda usa o Delphi. */
function clientVersion(value: string | undefined): Record<string, string> {
  if (!value) return {}
  try {
    // O Delphi manda Base64 na query sem codificar: o `+` chega como espaço.
    const params = new URLSearchParams(atob(value.replace(/ /g, '+')).replace(/^&/, ''))
    const pick = (...keys: string[]) => keys.map((key) => params.get(key)).find(Boolean) ?? ''
    return {
      version: pick('version', 'versao').slice(0, 20),
      bin_version: pick('bin_version', 'versao_exe').slice(0, 20),
    }
  } catch {
    return {}
  }
}

async function handshake(c: Context<App>) {
  c.header('Cache-Control', 'no-store')
  const requested = String(
    c.req.param('lang') || c.req.query('lang') || c.req.query('id_language') || 'pt',
  ).toLowerCase()
  const lang = LANGS.has(requested) ? requested : 'pt'

  const connection = ftpConnection(c.env.FTP_COMPAT_CONFIG, lang)
  if (!connection || !c.env.JWT_SECRET) {
    return c.json(
      { error: 'FTP descontinuado', details: 'Baixe as mídias por HTTPS em /file/<caminho>' },
      410,
    )
  }

  const claims = await verify(
    c.req.query('token') ?? '',
    c.env.JWT_SECRET,
    Math.floor(Date.now() / 1000),
  )
  if (!claims || claims.sub !== 'ftp') return c.json({ error: 'Token inválido' }, 401)

  // Sem gravar no banco: a rota é pública. O registro vai para os logs do Worker.
  console.log(
    JSON.stringify({
      event: 'ftp_handshake',
      lang,
      ...clientVersion(c.req.query('data') ?? c.req.query('p')),
    }),
  )

  // Mesmas chaves, na mesma ordem e com as mesmas quebras da API PHP.
  const { host, port, root, password, username } = connection
  const text = `${Object.entries({ host, port, root, password, username, lang })
    .map(([key, value]) => `${key}=${value}`)
    .join('\r\n')}\r\n`
  return c.text(base64(text), 200, { 'Content-Type': 'text/plain; charset=UTF-8' })
}

export const ftp = new Hono<App>()

ftp.get('/ftp', handshake)
ftp.get('/:lang/ftp', handshake)
