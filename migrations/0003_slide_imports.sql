-- Registro idempotente da fila de pacotes .slja/.lja.
--
-- A mídia pode ser enviada ao R2 antes da transação no D1. Este registro liga
-- o conteúdo do pacote à música criada: uma repetição da mesma tarefa vira
-- no-op e uma troca de conteúdo sob a mesma chave da fila é recusada.

CREATE TABLE slide_imports (
  source_key    TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL UNIQUE,
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('local', 'r2')),
  source_name   TEXT NOT NULL,
  id_music      INTEGER NOT NULL UNIQUE REFERENCES musics (id_music),
  imported_at   TEXT NOT NULL
);

CREATE INDEX slide_imports_imported_at ON slide_imports (imported_at);
