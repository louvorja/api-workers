/**
 * Estado do pipeline, guardado no R2.
 *
 * Antes isso era `.ingest-state.json` no disco de quem rodava — o que só
 * funciona enquanto o pipeline roda sempre na mesma máquina. No CI o runner é
 * descartável, e depender do cache do Actions é frágil: se ele evapora, a
 * execução seguinte não sabe o que já foi feito e regrava as 18.060 tabelas.
 *
 * Fica em `state/`, não em `meta/`: o Worker serve `meta/manifest.json` e
 * `meta/bundle.zip` por chave fixa (src/features/db.ts), e o prefixo `state/`
 * não é roteado por nenhuma rota pública.
 */
import * as r2 from './r2.ts'

const KEY = 'state/pipeline.json'

export type PipelineState = {
  /** `version` do /db/config da origem na última execução que fechou inteira. */
  version: number
  version_number: number
  /** tabela -> hash MD5 do /db/manifest. */
  tables: Record<string, string>
  /** Mídias que faltaram por causa do teto por execução, a retomar no próximo ciclo. */
  media_pending: number
  last_run: string | null
}

const VAZIO: PipelineState = {
  version: 0,
  version_number: 0,
  tables: {},
  media_pending: 0,
  last_run: null,
}

export async function load(): Promise<PipelineState> {
  const raw = await r2.get(KEY)
  if (!raw) return { ...VAZIO }
  try {
    return { ...VAZIO, ...(JSON.parse(new TextDecoder().decode(raw)) as Partial<PipelineState>) }
  } catch {
    // Estado corrompido é o mesmo caso de estado ausente: reconstrói do zero.
    // Perder o estado custa uma passada completa, não corretude.
    return { ...VAZIO }
  }
}

export async function save(state: PipelineState): Promise<void> {
  await r2.put(
    KEY,
    new TextEncoder().encode(JSON.stringify({ ...state, last_run: new Date().toISOString() })),
    'application/json',
  )
}
