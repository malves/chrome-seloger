-- Base DPE open data (ADEME, dataset `dpe03existant`).
--
-- Importée depuis l'espace d'administration, jour par jour, via l'API JSON
-- paginée. On conserve des colonnes clés typées (recherche/affichage) et la
-- ligne complète (~180 champs) en JSON brut, afin que « tout reste enregistré ».
-- Déduplication par `numero_dpe` : un ré-import écrase la ligne existante.

CREATE TABLE dpe_records (
  numero_dpe               TEXT PRIMARY KEY,
  date_etablissement_dpe   TEXT,                 -- date d'établissement (YYYY-MM-DD)
  etiquette_dpe            TEXT,                 -- A..G
  etiquette_ges            TEXT,                 -- A..G
  type_batiment            TEXT,                 -- "maison" | "appartement" | "immeuble"
  annee_construction       INTEGER,
  surface_habitable_logement REAL,
  adresse_ban              TEXT,                 -- adresse géocodée BAN
  adresse_brut             TEXT,                 -- adresse brute saisie
  nom_commune_ban          TEXT,
  code_postal_ban          TEXT,
  code_insee_ban           TEXT,
  code_departement_ban     TEXT,
  raw                      TEXT NOT NULL,        -- JSON : ligne complète telle que reçue
  imported_at              TEXT NOT NULL
);

CREATE INDEX idx_dpe_records_date       ON dpe_records(date_etablissement_dpe);
CREATE INDEX idx_dpe_records_cp         ON dpe_records(code_postal_ban);
CREATE INDEX idx_dpe_records_insee      ON dpe_records(code_insee_ban);
CREATE INDEX idx_dpe_records_dept       ON dpe_records(code_departement_ban);
CREATE INDEX idx_dpe_records_commune    ON dpe_records(nom_commune_ban COLLATE NOCASE);
CREATE INDEX idx_dpe_records_etiquette  ON dpe_records(etiquette_dpe);

-- Suivi des imports (un seul actif à la fois). La progression est relue par
-- l'interface via un sondage htmx tant que `status = 'running'`.
CREATE TABLE dpe_import_jobs (
  id            INTEGER PRIMARY KEY,
  date_from     TEXT NOT NULL,          -- premier jour importé (YYYY-MM-DD)
  date_to       TEXT NOT NULL,          -- dernier jour importé (YYYY-MM-DD)
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error
  current_day   TEXT,                   -- jour en cours de traitement
  days_total    INTEGER NOT NULL DEFAULT 0,
  days_done     INTEGER NOT NULL DEFAULT 0,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX idx_dpe_import_jobs_created ON dpe_import_jobs(created_at DESC);
