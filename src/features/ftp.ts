import { type Context, Hono } from 'hono'
import type { App } from '../types.ts'

/**
 * Aperto de mão do FTP das versões do Delphi anteriores à 27.0, que só baixam
 * banco e mídias por FTP. O FTP foi desligado: a resposta traz `ftp_msg`, que
 * o programa mostra antes de fechar a tela de download.
 */

/**
 * Sem acentos: o Delphi decodifica o Base64 byte a byte (Indy `enc8Bit`), e
 * qualquer caractere fora do ASCII sairia trocado.
 */
export const FTP_MESSAGES = {
  pt: 'O download por FTP foi encerrado. Para continuar baixando arquivos, instale o novo LouvorJA pelo site https://louvorja.com.br/',
  es: 'La descarga por FTP fue desactivada. Para seguir descargando archivos, instale el nuevo LoorJA desde https://louvorja.com.br/',
} as const

/**
 * Domínio em que o Delphi busca os dados do FTP. É fixo, e não o do pedido: o
 * cache de /params é um só para todos os domínios, e no workers.dev a
 * Cloudflare recusa a identificação do Delphi ("Indy Library", erro 1010).
 */
export const FTP_HANDSHAKE_ORIGIN = 'https://api.louvorja.com.br'

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

function handshake(c: Context<App>) {
  c.header('Cache-Control', 'no-store')
  const requested = String(
    c.req.param('lang') || c.req.query('lang') || c.req.query('id_language') || 'pt',
  ).toLowerCase()
  const lang = requested === 'es' ? 'es' : 'pt'

  console.log(
    JSON.stringify({
      event: 'ftp_handshake',
      lang,
      ...clientVersion(c.req.query('data') ?? c.req.query('p')),
    }),
  )

  return c.text(base64(`ftp_msg=${FTP_MESSAGES[lang]}\r\n`), 200, {
    'Content-Type': 'text/plain; charset=UTF-8',
  })
}

export const ftp = new Hono<App>()

ftp.get('/ftp', handshake)
ftp.get('/:lang/ftp', handshake)
