import { describe, expect, it } from 'vitest'
import { COLLECTIONS, filterRows, likeMatcher, sortRows } from '../src/features/rest.ts'
import { foldText } from '../src/lib/sql.ts'

type Row = Record<string, unknown>

// As versões abaixo são as originais, lentas e óbvias. Ficam aqui como gabarito:
// a otimização só vale se devolver exatamente o mesmo em qualquer entrada.

const FOLD: Array<[string, string]> = [
  ['áàâãäÁÀÂÃÄ', 'a'],
  ['éèêëÉÈÊË', 'e'],
  ['íìîïÍÌÎÏ', 'i'],
  ['óòôõöÓÒÔÕÖ', 'o'],
  ['úùûüÚÙÛÜ', 'u'],
  ['çÇ', 'c'],
  ['ñÑ', 'n'],
]

function referenceFold(text: string): string {
  let out = text
  for (const [chars, to] of FOLD) for (const ch of chars) out = out.replaceAll(ch, to)
  return out.toLowerCase()
}

function referenceLike(value: string, pattern: string): boolean {
  const input = [...referenceFold(value)]
  const wildcard = [...referenceFold(pattern)]
  let previous = Array<boolean>(input.length + 1).fill(false)
  previous[0] = true
  for (const token of wildcard) {
    const current = Array<boolean>(input.length + 1).fill(false)
    if (token === '%') current[0] = previous[0] ?? false
    for (let i = 1; i <= input.length; i++) {
      current[i] =
        token === '%'
          ? (previous[i] ?? false) || (current[i - 1] ?? false)
          : (token === '_' || token === input[i - 1]) && (previous[i - 1] ?? false)
    }
    previous = current
  }
  return previous[input.length] ?? false
}

function referenceCompare(a: unknown, b: unknown, text: boolean): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  if (!text && typeof a === 'number' && typeof b === 'number') return a - b
  const left = referenceFold(String(a))
  const right = referenceFold(String(b))
  return left < right ? -1 : left > right ? 1 : 0
}

/** Gerador determinístico: uma falha se repete com a mesma entrada. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LETTERS = ['a', 'A', 'b', 'c', 'ç', 'Ç', 'á', 'Ã', 'é', 'ô', 'ñ', 'o', 'r', ' ', 'ý', '😀']
const PATTERN = [...LETTERS, '%', '%', '%', '_']

function word(next: () => number, alphabet: string[], max: number): string {
  const length = Math.floor(next() * (max + 1))
  return Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join('')
}

describe('dobra de texto numa passada', () => {
  it('devolve o mesmo que a troca caractere a caractere', () => {
    const next = random(1)
    for (let i = 0; i < 3000; i++) {
      const text = word(next, LETTERS, 12)
      expect(foldText(text), JSON.stringify(text)).toBe(referenceFold(text))
    }
    expect(foldText('Coração ÁRVORE ñandú')).toBe('coracao arvore nandu')
    expect(foldText('')).toBe('')
  })
})

describe('LIKE compilado', () => {
  it('casa como o algoritmo original em padrões aleatórios, com e sem _', () => {
    const next = random(2)
    let matched = 0
    for (let i = 0; i < 6000; i++) {
      const pattern = word(next, PATTERN, 6)
      const text = word(next, LETTERS, 8)
      const expected = referenceLike(text, pattern)
      if (expected) matched++
      expect(
        likeMatcher(pattern)(foldText(text)),
        `${JSON.stringify(text)} LIKE ${JSON.stringify(pattern)}`,
      ).toBe(expected)
    }
    // O sorteio precisa exercitar os dois resultados para o teste valer algo.
    expect(matched).toBeGreaterThan(300)
    expect(matched).toBeLessThan(5700)
  })

  it('respeita início, fim e a ordem dos trechos', () => {
    const cases: Array<[text: string, pattern: string, expected: boolean]> = [
      ['Coração aberto', '%coracao%', true],
      ['Coração aberto', 'coracao%', true],
      ['Coração aberto', '%aberto', true],
      ['Coração aberto', 'aberto%', false],
      ['Coração aberto', '%cora%aberto%', true],
      ['Coração aberto', '%aberto%cora%', false],
      ['aba', 'ab%ba', false],
      ['abba', 'ab%ba', true],
      ['abc', 'abc', true],
      ['abc', 'ab', false],
      ['', '%', true],
      ['', '', true],
      ['x', '', false],
      ['abc', 'a_c', true],
      ['ac', 'a_c', false],
    ]
    for (const [text, pattern, expected] of cases) {
      expect(likeMatcher(pattern)(foldText(text)), `${text} LIKE ${pattern}`).toBe(expected)
    }
  })
})

describe('filtro e ordenação das coleções públicas', () => {
  const spec = COLLECTIONS.lyrics
  if (!spec) throw new Error('coleção lyrics ausente')

  const rows = (next: () => number, total: number): Row[] =>
    Array.from({ length: total }, (_, index) => ({
      id_lyric: index + 1,
      id_music: Math.floor(next() * 20),
      lyric: next() < 0.1 ? null : word(next, LETTERS, 10),
      aux_lyric: next() < 0.5 ? null : word(next, LETTERS, 4),
      order: next() < 0.2 ? String(Math.floor(next() * 9)) : Math.floor(next() * 9),
      show_slide: next() < 0.5 ? 1 : 0,
    }))

  it('filtra como a comparação linha a linha original', () => {
    const next = random(3)
    const data = rows(next, 400)
    for (let i = 0; i < 300; i++) {
      // `*` é o curinga do protocolo da API; ela o troca por `%` antes de comparar.
      const pattern = word(next, ['a', 'ç', 'o', 'r', '*', '*'], 4)
      const sent = encodeURIComponent(pattern)
      const music = String(Math.floor(next() * 20))
      const query =
        i % 3 === 0
          ? `lyric=like:${sent}`
          : i % 3 === 1
            ? `id_music=${music}&lyric=orlike:${sent}`
            : `id_music=${music}&lyric=like:${sent}&aux_lyric=orlike:${sent}`
      const url = new URL(`https://api.test/pt/lyrics?${query}`)

      const expected = data.filter((row) => {
        const likeOf = (field: string) =>
          row[field] !== null && referenceLike(String(row[field]), pattern.replaceAll('*', '%'))
        const sameMusic = Number(row.id_music) === Number(music)
        // A corrente segue a ordem dos campos da coleção (id_music, lyric,
        // aux_lyric) e o AND tem precedência sobre o OR, como no SQL.
        if (i % 3 === 0) return likeOf('lyric')
        if (i % 3 === 1) return sameMusic || likeOf('lyric')
        return (sameMusic && likeOf('lyric')) || likeOf('aux_lyric')
      })
      expect(
        filterRows(data, 'lyrics', spec, url).map((row) => row.id_lyric),
        query,
      ).toEqual(expected.map((row) => row.id_lyric))
    }
  })

  it('ordena como o comparador original, inclusive com nulos, números e empates', () => {
    const next = random(4)
    const data = rows(next, 500)
    for (const sortBy of [
      'lyric',
      'lyric.desc',
      'order,lyric',
      'id_music.desc,aux_lyric',
      'inexistente',
    ]) {
      const url = new URL(`https://api.test/pt/lyrics?sort_by=${sortBy}`)
      const sorts = sortBy
        .split(',')
        .map((item) => item.split('.'))
        .filter(([field]) => field !== 'inexistente')
        .map(([field, direction]) => ({
          field: field as string,
          desc: direction === 'desc',
          text: spec.text.has(field as string),
        }))
      const expected = [...data].sort((left, right) => {
        for (const sort of sorts) {
          const result = referenceCompare(left[sort.field], right[sort.field], sort.text)
          if (result !== 0) return sort.desc ? -result : result
        }
        return 0
      })
      expect(
        sortRows(data, 'lyrics', spec, url).map((row) => row.id_lyric),
        sortBy,
      ).toEqual(expected.map((row) => row.id_lyric))
    }
  })
})
