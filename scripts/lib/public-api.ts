export const DEFAULT_PUBLIC_API_URL = 'https://api.louvorja.workers.dev'

/**
 * Origem gravada nas URLs dos snapshots (capas, áudios, links de /params). O
 * padrão é o endereço em que esta API realmente responde: api.louvorja.com.br
 * pertence ao servidor antigo, fora do nosso controle, e uma URL apontando para
 * lá deixaria os apps sem mídia. Só troque se o domínio passar a ser nosso.
 */
export function publicApiUrl(value: string | undefined): string {
  const raw = value ?? DEFAULT_PUBLIC_API_URL
  if (raw.trim() !== raw || raw === '') throw new Error('PUBLIC_API_URL inválida')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('PUBLIC_API_URL precisa ser uma URL absoluta')
  }

  const localHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('PUBLIC_API_URL precisa usar HTTPS (HTTP só é aceito localmente)')
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(
      'PUBLIC_API_URL deve conter somente a origem, sem credenciais, caminho ou query',
    )
  }
  return url.origin
}
