-- Total de linhas das tabelas grandes, mantido por gatilho.
--
-- O painel mostra "1 a 10 de 75252 registros" em cada tela, e no SQLite contar
-- é percorrer a tabela: no D1 isso custava 75 mil linhas lidas da cota diária a
-- cada abertura da tela de letras. Com o total guardado, custa uma.
--
-- Em carga em massa cada linha inserida passa a custar uma escrita a mais; no
-- plano gratuito, aplique esta migration depois da carga inicial.

CREATE TABLE row_counts (
  name  TEXT PRIMARY KEY,
  total INTEGER NOT NULL
);

INSERT INTO row_counts (name, total) SELECT 'lyrics', count(*) FROM lyrics;
INSERT INTO row_counts (name, total) SELECT 'musics', count(*) FROM musics;
INSERT INTO row_counts (name, total) SELECT 'files', count(*) FROM files;
INSERT INTO row_counts (name, total) SELECT 'albums_musics', count(*) FROM albums_musics;

CREATE TRIGGER lyrics_count_insert AFTER INSERT ON lyrics
BEGIN
  UPDATE row_counts SET total = total + 1 WHERE name = 'lyrics';
END;

CREATE TRIGGER lyrics_count_delete AFTER DELETE ON lyrics
BEGIN
  UPDATE row_counts SET total = total - 1 WHERE name = 'lyrics';
END;

CREATE TRIGGER musics_count_insert AFTER INSERT ON musics
BEGIN
  UPDATE row_counts SET total = total + 1 WHERE name = 'musics';
END;

CREATE TRIGGER musics_count_delete AFTER DELETE ON musics
BEGIN
  UPDATE row_counts SET total = total - 1 WHERE name = 'musics';
END;

CREATE TRIGGER files_count_insert AFTER INSERT ON files
BEGIN
  UPDATE row_counts SET total = total + 1 WHERE name = 'files';
END;

CREATE TRIGGER files_count_delete AFTER DELETE ON files
BEGIN
  UPDATE row_counts SET total = total - 1 WHERE name = 'files';
END;

CREATE TRIGGER albums_musics_count_insert AFTER INSERT ON albums_musics
BEGIN
  UPDATE row_counts SET total = total + 1 WHERE name = 'albums_musics';
END;

CREATE TRIGGER albums_musics_count_delete AFTER DELETE ON albums_musics
BEGIN
  UPDATE row_counts SET total = total - 1 WHERE name = 'albums_musics';
END;
