import { catalogMediaPath, type MediaVariant } from '../../src/lib/media-urls.ts'

/**
 * Confere as URLs contra as chaves reais antes de publicar o REST. Os retratos
 * antigos tinham nomes .opus de arquivos que só existem em .mp3; o domínio
 * direto não faz a troca de extensão que /file fazia.
 *
 * Preserva o prefixo publicado para permitir preparar os dados antes do deploy
 * do Worker. A resposta aplica withMediaUrls. Em /files, size descreve o mesmo
 * arquivo que url entrega, inclusive na variante dos MP3 originais.
 */
export function reconcileRestMedia(
  text: string,
  sizes: ReadonlyMap<string, number>,
  variant: MediaVariant = 'current',
): string {
  function visit(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(visit)
    if (node === null || typeof node !== 'object') return node
    const out: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(node)) {
      if (!/^url(?:_[a-z_]+)?$/.test(field) || typeof value !== 'string') {
        out[field] = visit(value)
        continue
      }
      const path = catalogMediaPath(value)
      if (path === null) {
        out[field] = value
        continue
      }
      const decoded = decodeURIComponent(path)
      if (decoded.split('/').some((part) => part === '..' || part === '.')) {
        throw new Error(`Caminho de mídia inválido: ${path}`)
      }
      const wanted =
        variant === 'legacy' && decoded.startsWith('musics/')
          ? decoded.replace(/\.opus$/, '.mp3')
          : decoded
      const alternative = wanted.endsWith('.opus')
        ? wanted.replace(/\.opus$/, '.mp3')
        : wanted.endsWith('.mp3')
          ? wanted.replace(/\.mp3$/, '.opus')
          : wanted.endsWith('.bmp')
            ? wanted.replace(/\.bmp$/, '.jpg')
            : wanted
      const key = sizes.has(wanted)
        ? wanted
        : variant === 'current' && sizes.has(alternative)
          ? alternative
          : null
      if (key === null) throw new Error(`Arquivo ausente no armazenamento (${variant}): ${wanted}`)
      out[field] = `${value.slice(0, -path.length)}${key}`
    }
    // size pode aparecer antes ou depois de url na serialização original.
    if ('id_file' in out && typeof out.url === 'string' && 'size' in out) {
      const key = catalogMediaPath(out.url)
      if (key !== null) out.size = sizes.get(key)
    }
    return out
  }
  return JSON.stringify(visit(JSON.parse(text)))
}
