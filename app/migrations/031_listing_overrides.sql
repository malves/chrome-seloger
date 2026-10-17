-- Valeurs de champ saisies ou corrigees par l'utilisateur (fiche de visite ou
-- correction manuelle depuis le listing) + etat de la fiche de visite.
-- `data` est un JSON (voir src/services/visit-sheet.service.js) :
--   { fields: { <champ>: { value, source:'user', origin:'visit'|'listing', confirmed, updatedAt } },
--     visit:  { applyToSheet, answers, startedAt, completedAt } }
-- La provenance structured / description / ai_photo est calculee au rendu ;
-- cette table ne stocke QUE la couche utilisateur (priorite maximale).

CREATE TABLE IF NOT EXISTS listing_overrides (
  listing_id  INTEGER PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
