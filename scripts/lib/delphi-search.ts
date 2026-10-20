import type { DatabaseSync } from 'node:sqlite'

export const MATERIALIZED_MUSIC_LISTS = ['LISTA_MUSICAS', 'LISTA_MUSICAS_ONL'] as const

// FireDAC lê TEXT como WideMemo. Campos exibidos precisam de NVARCHAR;
// somente as letras (conteúdo longo) continuam como memo. Os números abaixo
// são tamanhos mínimos, ampliados se o catálogo contiver valores maiores.
const MUSIC_LIST_COLUMNS = {
  ID_ALBUM: 'INTEGER',
  NOME_ALBUM: 512,
  NOME_ALBUM_COM: 1024,
  FAIXA: 'INTEGER',
  NOME: 512,
  NOME_COM: 1024,
  TIPO_HASD: 1,
  TIPO_JA: 1,
  TIPO_BAIXADA: 1,
  TIPO_WEB: 1,
  TIPO_PERSO: 1,
  TIPO: 1,
  URL_ALBUM: 512,
  ALBUM: 512,
  URL: 1024,
  URL_INSTRUMENTAL: 1024,
  IDIOMA: 16,
  LETRA: 'TEXT',
  NOME_SEMAC: 512,
  LETRA_SEMAC: 'TEXT',
  NOME_ALBUM_COM_SEMAC: 1024,
} as const

/**
 * Calcula os campos de busca uma vez, só no SQLite distribuído por HTTPS.
 * Os gatilhos preservam as alterações locais que antes apareciam nas views:
 * álbuns ignorados e a atualização de canais/playlists/vídeos pelo Delphi.
 */
export function materializeMusicLists(db: DatabaseSync) {
  const selects = new Map<string, string>()
  for (const name of MATERIALIZED_MUSIC_LISTS) {
    const view = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?")
      .get(name) as { sql: string } | undefined
    if (!view) throw new Error(`view ${name} ausente ao materializar a busca do Delphi`)
    const select = view.sql.replace(/^CREATE VIEW\s+\S+\s+AS\s+/i, '')
    selects.set(name, select)
    const columns = Object.entries({
      // IDs de vídeo são strings: "00123" não pode virar o número 123.
      ID: name === 'LISTA_MUSICAS' ? 'INTEGER' : 128,
      ...MUSIC_LIST_COLUMNS,
    })
    const sourceColumns = db
      .prepare(`PRAGMA table_info(${name})`)
      .all()
      .map((field) => field.name)
    if (sourceColumns.join(',') !== columns.map(([column]) => column).join(',')) {
      throw new Error(`colunas de ${name} divergiram do contrato tipado do Delphi`)
    }
    // Bytes UTF-8 também cobrem o tamanho em UTF-16 usado pelo Delphi, inclusive emoji.
    const sizes = db
      .prepare(
        `SELECT ${columns
          .filter(([, type]) => typeof type === 'number')
          .map(([column]) => `max(length(CAST(${column} AS BLOB))) AS ${column}`)
          .join(', ')} FROM ${name}`,
      )
      .get()!
    const schema = columns
      .map(
        ([column, type]) =>
          `${column} ${
            typeof type === 'number'
              ? `NVARCHAR(${Math.max(type, Number(sizes[column] ?? 0))})`
              : type
          }`,
      )
      .join(', ')
    db.exec(`
      DROP VIEW ${name};
      CREATE TABLE ${name} (${schema});
      INSERT INTO ${name} ${select};
    `)
  }

  db.exec(`
    CREATE INDEX idx_lista_musicas_id ON LISTA_MUSICAS (ID);
    CREATE INDEX idx_lista_musicas_album ON LISTA_MUSICAS (ID_ALBUM);
    CREATE INDEX idx_lista_musicas_onl_id ON LISTA_MUSICAS_ONL (ID);
    CREATE INDEX idx_onl_videos_id ON ONL_VIDEOS (VIDEO_ID);
    CREATE INDEX idx_onl_videos_playlist ON ONL_VIDEOS (PLAYLIST_ID);
    CREATE INDEX idx_onl_playlists_id ON ONL_PLAYLISTS (PLAYLIST_ID);
    CREATE INDEX idx_onl_playlists_canal ON ONL_PLAYLISTS (CANAL_ID);
    CREATE INDEX idx_onl_canais_id ON ONL_CANAIS (CANAL_ID);
  `)

  const sources = [
    { table: '_ALBUM_IGNORAR', key: 'ID', target: 'LISTA_MUSICAS' },
    { table: 'ONL_VIDEOS', key: 'VIDEO_ID', target: 'LISTA_MUSICAS_ONL' },
    { table: 'ONL_PLAYLISTS', key: 'PLAYLIST_ID', target: 'LISTA_MUSICAS_ONL' },
    { table: 'ONL_CANAIS', key: 'CANAL_ID', target: 'LISTA_MUSICAS_ONL' },
  ] as const

  for (const { table, key, target } of sources) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const keys = [
        ...(event !== 'INSERT' ? [`OLD.${key}`] : []),
        ...(event !== 'DELETE' ? [`NEW.${key}`] : []),
      ].join(', ')
      let predicate: string
      if (table === '_ALBUM_IGNORAR') predicate = `ID_ALBUM IN (${keys})`
      else if (table === 'ONL_VIDEOS') predicate = `ID IN (${keys})`
      else if (table === 'ONL_PLAYLISTS') {
        predicate = `ID IN (SELECT VIDEO_ID FROM ONL_VIDEOS WHERE PLAYLIST_ID IN (${keys}))`
      } else {
        predicate = `ID IN (
          SELECT VIDEO_ID FROM ONL_VIDEOS
          WHERE PLAYLIST_ID IN (SELECT PLAYLIST_ID FROM ONL_PLAYLISTS WHERE CANAL_ID IN (${keys}))
        )`
      }
      // Recalcula todos os vínculos do vídeo afetado: ele pode estar em várias playlists.
      db.exec(`
        CREATE TRIGGER sync_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
        BEGIN
          DELETE FROM ${target} WHERE ${predicate};
          INSERT INTO ${target} SELECT * FROM (${selects.get(target)}) WHERE ${predicate};
        END;
      `)
    }
  }
}
