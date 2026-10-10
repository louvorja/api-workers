/**
 * Validação no formato do Lumen de origem: regras por campo, mensagens em
 * português e o mesmo corpo de erro 422 que o painel sabe ler.
 */
export type Body = Record<string, unknown>
export type Messages = Record<string, string[]>

const label = (attribute: string) => attribute.replace(/_/g, ' ')

export const blank = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0)

/** O `filled()` do Laravel: presente e não vazio. */
export const filled = (body: Body, key: string) => !blank(body[key])

export class Validator {
  readonly messages: Messages = {}
  private readonly body: Body
  private readonly db: D1Database

  // Campos declarados à mão: este arquivo também é carregado pelos scripts, e o
  // strip-types do Node não aceita "parameter properties".
  constructor(body: Body, db: D1Database) {
    this.body = body
    this.db = db
  }

  private add(attribute: string, message: string) {
    const list = this.messages[attribute]
    if (list) list.push(message)
    else this.messages[attribute] = [message]
  }

  /**
   * `required` é regra implícita no Laravel: quando ela falha, as demais regras
   * do campo não rodam. Devolve true se o campo pode seguir sendo validado.
   */
  required(attribute: string, message?: string): boolean {
    if (!blank(this.body[attribute])) return true
    this.add(attribute, message ?? `O campo ${label(attribute)} é obrigatório.`)
    return false
  }

  /** Sem tradução na origem o Lumen devolve a própria chave da mensagem. */
  string(attribute: string, message = 'validation.string') {
    if (typeof this.body[attribute] !== 'string') this.add(attribute, message)
  }

  email(attribute: string) {
    const value = this.body[attribute]
    if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      this.add(attribute, `O campo ${label(attribute)} deve conter um endereço de email válido.`)
    }
  }

  min(attribute: string, length: number, message?: string) {
    if (String(this.body[attribute] ?? '').length < length) {
      this.add(
        attribute,
        message ?? `O campo ${label(attribute)} deve ter no mínimo ${length} caracteres.`,
      )
    }
  }

  fail(attribute: string, message: string) {
    this.add(attribute, message)
  }

  async exists(attribute: string, table: string, column: string) {
    const row = await this.db
      .prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`)
      .bind(this.body[attribute])
      .first()
    if (!row) this.add(attribute, `O ${label(attribute)} escolhido é inválido.`)
  }

  /**
   * `unique:tabela,coluna,ignorar,chave,coluna_extra,valor_extra` do Laravel.
   * NOCASE porque no MySQL de origem essa comparação ignora caixa.
   */
  async unique(
    attribute: string,
    table: string,
    column: string,
    options: { ignore?: { key: string; id: unknown }; where?: { column: string; value: unknown } },
  ) {
    const conditions = [`${column} = ? COLLATE NOCASE`]
    const params: unknown[] = [this.body[attribute]]
    if (options.ignore && options.ignore.id !== null && options.ignore.id !== undefined) {
      conditions.push(`${options.ignore.key} <> ?`)
      params.push(options.ignore.id)
    }
    if (options.where) {
      conditions.push(`${options.where.column} = ?`)
      params.push(options.where.value ?? null)
    }

    const row = await this.db
      .prepare(`SELECT 1 FROM ${table} WHERE ${conditions.join(' AND ')} LIMIT 1`)
      .bind(...params)
      .first()
    if (row) this.add(attribute, `O ${label(attribute)} já está em uso.`)
  }

  get failed(): boolean {
    return Object.keys(this.messages).length > 0
  }
}

/** Corpo do erro 422 como o Handler da origem o monta. */
export function validationError(messages: Messages) {
  return {
    error: Object.values(messages).flat().join('\n'),
    messages,
    code: 422,
  }
}
