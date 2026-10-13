/**
 * Endereços de mídia do catálogo.
 *
 * O catálogo é guardado com o caminho do arquivo dentro do armazenamento
 * ("/musics/..."). Quem lê recebe o endereço completo, direto no armazenamento:
 * arquivo entregue pela API conta na cota diária de requisições do Worker.
 */

export const FILES_URL = 'https://files.louvorja.com.br'

export const ORIGINALS_URL = 'https://mp3.louvorja.com.br'

/**
 * `current` preserva a extensão publicada em FILES_URL.
 * `legacy` troca áudios Opus por MP3 em ORIGINALS_URL.
 */
export type MediaVariant = 'current' | 'legacy'

/** Pacote do catálogo com os endereços de cada variante já escritos. */
export const BUNDLE_KEY = 'meta/bundle.zip'
export const BUNDLE_VARIANT_KEYS: Record<MediaVariant, string> = {
  current: 'meta/bundle-files.zip',
  legacy: 'meta/bundle-legacy.zip',
}

const MEDIA_FIELD = /"(url(?:_[a-z_]+)?)":("(?:[^"\\]|\\.)*")/g
const MEDIA_PATH =
  /^(?:(?:https:\/\/(?:api\.louvorja\.workers\.dev|api\.louvorja\.com\.br))?\/file|https:\/\/files\.louvorja\.com\.br)?\/(covers|images|musics)\/(.+)$/

/** Só endereços do nosso acervo; URLs externas e links de paginação ficam intactos. */
export function catalogMediaPath(value: string): string | null {
  const match = MEDIA_PATH.exec(value)
  return match ? `${match[1]}/${match[2]}` : null
}

/** Troca os caminhos de mídia de um JSON do catálogo pelos endereços completos. */
export function withMediaUrls(text: string, variant: MediaVariant): string {
  // A maior tabela (a lista de músicas) não tem mídia: evita varrê-la à toa.
  if (!text.includes('"url')) return text
  return text.replace(MEDIA_FIELD, (match, key: string, encoded: string) => {
    const path = catalogMediaPath(JSON.parse(encoded) as string)
    if (path === null) return match
    const url =
      variant === 'legacy' && path.startsWith('musics/')
        ? `${ORIGINALS_URL}/${path.replace(/\.opus(?=[?#]|$)/, '.mp3')}`
        : `${FILES_URL}/${path}`
    return `"${key}":${JSON.stringify(url)}`
  })
}

export const CATALOG_VARIANT_KEYS: Record<MediaVariant, string> = {
  current: 'meta/catalog-bundle-files.zip',
  legacy: 'meta/catalog-bundle-legacy.zip',
}
export const MANIFEST_VARIANT_KEYS: Record<MediaVariant, string> = {
  current: 'meta/manifest-files.json',
  legacy: 'meta/manifest-legacy.json',
}
