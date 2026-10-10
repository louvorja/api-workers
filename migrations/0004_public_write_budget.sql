-- Teto diário para o que uma rota pública grava no banco.
--
-- O registro de downloads é feito sem autenticação, e no plano gratuito o D1
-- para de responder quando a cota diária de escrita estoura. A rota soma um
-- neste contador antes de gravar; passado o teto, nem o contador muda mais.
CREATE TABLE public_write_budget (
  day  TEXT NOT NULL,
  name TEXT NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY (day, name)
) WITHOUT ROWID;
