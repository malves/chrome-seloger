-- Base DVF (Demandes de valeurs foncières, geo-dvf Etalab).
-- Ventes réelles géolocalisées : prix au m² commune/rayon + évolution.

CREATE TABLE dvf_import_jobs (
  id            INTEGER PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'pending',
  source_label  TEXT,
  source_url    TEXT,
  year_from     INTEGER,
  year_to       INTEGER,
  current_year  INTEGER,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX idx_dvf_import_jobs_created ON dvf_import_jobs(created_at DESC);

-- Mutations nettoyées, une ligne par bien vendu (maison ou appartement),
-- géolocalisée pour permettre les requêtes dans un rayon donné.
CREATE TABLE dvf_mutation (
  id            INTEGER PRIMARY KEY,
  insee_code    TEXT NOT NULL,
  dept_code     TEXT,
  year          INTEGER NOT NULL,
  type_local    TEXT NOT NULL,         -- 'house' | 'apartment'
  price         INTEGER NOT NULL,      -- valeur foncière en euros
  surface       REAL NOT NULL,         -- m² habitables (surface_reelle_bati)
  price_per_m2  REAL NOT NULL,
  lat           REAL,
  lng           REAL
);

-- Lecture commune (médianes annuelles) et rayon (pré-filtre bbox lat/lng).
CREATE INDEX idx_dvf_mutation_commune ON dvf_mutation(insee_code, type_local, year);
CREATE INDEX idx_dvf_mutation_bbox ON dvf_mutation(lat, lng);
-- Parcours ordonné pour le calcul des médianes au terme de l'import.
CREATE INDEX idx_dvf_mutation_stats ON dvf_mutation(insee_code, type_local, year, price_per_m2);

-- Statistiques précalculées par commune / année / type : médiane du prix au m²
-- (SQLite n'a pas de fonction MEDIAN native, on la calcule à l'import).
CREATE TABLE dvf_commune_stats (
  insee_code      TEXT NOT NULL,
  type_local      TEXT NOT NULL,       -- 'house' | 'apartment'
  year            INTEGER NOT NULL,
  count           INTEGER NOT NULL,
  median_price_m2 REAL NOT NULL,
  PRIMARY KEY (insee_code, type_local, year)
);
