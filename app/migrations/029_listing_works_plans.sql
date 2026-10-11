-- Plan de travaux d'une annonce : pièces, état des surfaces (sol, murs,
-- plafond, ambiance) et rattachement des photos, prérempli par l'analyse des
-- photos puis corrigé par l'utilisateur. `data` est un JSON (voir
-- src/lib/works/works-plan.js).

CREATE TABLE listing_works_plans (
  listing_id      INTEGER PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
  data            TEXT NOT NULL,
  ai_analyzed_at  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
