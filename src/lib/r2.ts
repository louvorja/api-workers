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

/** HTTP dates have second precision. */
const modifiedAt = (object: R2Object) => Math.floor(object.uploaded.getTime() / 1000) * 1000
const date = (value: string | null) => (value === null ? Number.NaN : Date.parse(value))
const tags = (value: string) => value.split(',').map((tag) => tag.trim())

function precondition(request: Request, object: R2Object): 304 | 412 | null {
  const h = request.headers
  const match = h.get('if-match')
  if (match !== null && match !== '*' && !tags(match).includes(object.httpEtag)) return 412
  const unmodified = date(h.get('if-unmodified-since'))
  if (match === null && Number.isFinite(unmodified) && modifiedAt(object) > unmodified) return 412
  const none = h.get('if-none-match')
  if (none !== null) {
    if (none === '*' || tags(none).some((tag) => tag.replace(/^W\//, '') === object.httpEtag))
      return 304
  } else {
    const since = date(h.get('if-modified-since'))
    if (Number.isFinite(since) && modifiedAt(object) <= since) return 304
  }
  return null
}

/** Unsupported/invalid ranges are ignored; a valid unsatisfiable range returns false. */
function byteRange(value: string | null, size: number): R2Range | false | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value ?? '')
  if (!match || (!match[1] && !match[2])) return undefined
  const start = match[1] ? Number(match[1]) : null
  const end = match[2] ? Number(match[2]) : null
  if (
    (start !== null && !Number.isSafeInteger(start)) ||
    (end !== null && !Number.isSafeInteger(end))
  )
    return false
  if (start !== null && end !== null && end < start) return undefined
  if (size === 0 || (start !== null && start >= size) || (start === null && end === 0)) return false
  const offset = start ?? Math.max(0, size - (end ?? 0))
  const last = start === null || end === null ? size - 1 : Math.min(size - 1, end)
  return { offset, length: last - offset + 1 }
}

/** Serve GET/HEAD with RFC 9110 conditionals, without combining different object generations. */
export async function serveObject(
  bucket: R2Bucket,
  key: string,
  request: Request,
  cacheControl: string,
): Promise<Response | null> {
  const conditional = [
    'range',
    'if-match',
    'if-none-match',
    'if-modified-since',
    'if-unmodified-since',
  ].some((header) => request.headers.has(header))
  const inspect = request.method === 'HEAD' || conditional
  for (let attempt = 0; attempt < 3; attempt++) {
    const object = inspect ? await bucket.head(key) : await bucket.get(key)
    if (object === null) return null
    const headers = new Headers(COMMON_HEADERS)
    object.writeHttpMetadata(headers)
    if (!headers.has('content-type')) headers.set('Content-Type', mimeOf(key))
    headers.set('ETag', object.httpEtag)
    headers.set('Last-Modified', object.uploaded.toUTCString())
    headers.set('Cache-Control', cacheControl)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Content-Disposition', disposition(key))
    const status = precondition(request, object)
    if (status) return new Response(null, { status, headers })

    let range: R2Range | false | undefined
    if (request.method === 'GET') {
      const ifRange = request.headers.get('if-range')
      if (ifRange === null || ifRange === object.httpEtag || date(ifRange) === modifiedAt(object)) {
        range = byteRange(request.headers.get('range'), object.size)
      }
    }
    if (range === false) {
      headers.set('Content-Range', `bytes */${object.size}`)
      return new Response(null, { status: 416, headers })
    }
    headers.set('Content-Length', String(object.size))
    if (request.method === 'HEAD') return new Response(null, { headers })
    const result = inspect
      ? await bucket.get(key, { onlyIf: { etagMatches: object.etag }, ...(range ? { range } : {}) })
      : object
    if (!result || !('body' in result)) continue // Object changed between HEAD and GET: re-evaluate.
    if (range && 'offset' in range) {
      const offset = range.offset ?? 0
      const length = range.length ?? object.size - offset
      headers.set('Content-Length', String(length))
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
      return new Response(result.body as ReadableStream, { status: 206, headers })
    }
    return new Response(result.body as ReadableStream, { headers })
  }
  return new Response(null, {
    status: 503,
    headers: { ...COMMON_HEADERS, 'Cache-Control': 'no-store', 'Retry-After': '1' },
  })
}
