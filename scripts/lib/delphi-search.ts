import type { DatabaseSync } from 'node:sqlite'

export const MATERIALIZED_MUSIC_LISTS = ['LISTA_MUSICAS', 'LISTA_MUSICAS_ONL'] as const

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
    db.exec(`DROP VIEW ${name}; CREATE TABLE ${name} AS ${select};`)
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
