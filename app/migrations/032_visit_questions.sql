-- Catalogue éditable des questions de la fiche de visite (administration).
-- Importé depuis src/lib/visit/visit-questions.js au premier accès (voir
-- src/services/visit-questions-config.service.js). `builtin` = 1 pour une
-- question du catalogue d'origine (rétablissable), 0 pour une question créée.
-- `data` est un JSON : { question, proTip, theme, audience, input, signals,
-- showWhen, photo, field }. Une question supprimée est archivée (`archived_at`)
-- pour que les réponses déjà saisies sur les fiches restent lisibles.

CREATE TABLE IF NOT EXISTS visit_questions (
  id          TEXT PRIMARY KEY,
  section     TEXT NOT NULL,
  position    INTEGER NOT NULL,
  essential   INTEGER NOT NULL DEFAULT 0,
  builtin     INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL,
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visit_questions_section ON visit_questions(section, position);
