import { COMMON_HEADERS } from './http.ts'
import { mimeOf } from './mime.ts'

/**
 * Content-Disposition com nome de arquivo acentuado.
 *
 * A API legada mandava o nome cru no header, o que quebra em runtimes que
 * validam ISO-8859-1. Aqui vai o par ASCII + RFC 5987, que todo cliente aceita.
 */
function disposition(key: string): string {
  const name = key.slice(key.lastIndexOf('/') + 1)
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * Serve um objeto do R2 honrando Range e requisições condicionais.
 * Devolve null quando a chave não existe, para o chamador decidir o 404.
 */
export async function serveObject(
  bucket: R2Bucket,
  key: string,
  request: Request,
  cacheControl: string,
): Promise<Response | null> {
  const object = await bucket.get(key, {
    range: request.headers,
    onlyIf: request.headers,
  })
  if (object === null) return null

  const headers = new Headers(COMMON_HEADERS)
  object.writeHttpMetadata(headers)
  if (!headers.has('content-type')) headers.set('Content-Type', mimeOf(key))
  headers.set('ETag', object.httpEtag)
  headers.set('Cache-Control', cacheControl)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Content-Disposition', disposition(key))

  const body = 'body' in object ? object.body : null
  if (body === null) return new Response(null, { status: 304, headers })

  const range = object.range
  if (range && 'offset' in range && request.headers.has('range')) {
    const offset = range.offset ?? 0
    const length = range.length ?? object.size - offset
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
    return new Response(body, { status: 206, headers })
  }

  return new Response(body, { status: 200, headers })
}
