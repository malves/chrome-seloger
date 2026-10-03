-- Schéma initial du carnet de recherche.
-- Dates en ISO 8601 UTC (TEXT), montants en euros entiers (INTEGER),
-- objets flexibles en TEXT contenant du JSON.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  settings      TEXT NOT NULL DEFAULT '{}',   -- JSON : financement par défaut, adresses de référence
  created_at    TEXT NOT NULL
);

CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,          -- SHA-256 du jeton ; le jeton en clair n'est jamais stocké
  label        TEXT,                          -- ex. "Chrome – PC bureau"
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id, created_at DESC);

CREATE TABLE listings (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source           TEXT NOT NULL,             -- "seloger", "leboncoin", "bienici", "pap", ...
  source_id        TEXT,                      -- identifiant de l'annonce sur le site source
  url              TEXT NOT NULL,             -- URL canonique (sans paramètres de tracking)
  dedup_key        TEXT NOT NULL,             -- source + ":" + (source_id ou hash de l'URL canonique)
  transaction_type TEXT NOT NULL DEFAULT 'sale',  -- "sale" | "rent"
  property_type    TEXT,                      -- "house" | "apartment" | "land" | "other"
  title            TEXT,
  description      TEXT,
  price            INTEGER,
  surface          REAL,                      -- m² habitables
  land_surface     REAL,                      -- m² terrain
  rooms            INTEGER,
  bedrooms         INTEGER,
  floor            INTEGER,
  year_built       INTEGER,
  dpe              TEXT,                      -- A..G
  ges              TEXT,                      -- A..G
  is_new_build     INTEGER NOT NULL DEFAULT 0,
  city             TEXT,
  postal_code      TEXT,
  insee_code       TEXT,                      -- résolu côté serveur si absent
  lat              REAL,
  lng              REAL,
  agency           TEXT,                      -- JSON : { name, phone, fees_included, fees_percent }
  features         TEXT,                      -- JSON : tableau de chaînes ("garage", "cave", ...)
  extension_data   TEXT,                      -- JSON : données calculées par l'extension
  raw              TEXT,                      -- JSON : payload brut tel que reçu
  status           TEXT NOT NULL DEFAULT 'new',
  is_favorite      INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  first_saved_at   TEXT NOT NULL,
  last_saved_at    TEXT NOT NULL,
  UNIQUE (user_id, dedup_key)
);
CREATE INDEX idx_listings_user ON listings(user_id, last_saved_at DESC);
CREATE INDEX idx_listings_user_status ON listings(user_id, status);

CREATE TABLE listing_photos (
  id         INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  url        TEXT NOT NULL
);
CREATE INDEX idx_listing_photos_listing ON listing_photos(listing_id, position);

CREATE TABLE price_history (
  id          INTEGER PRIMARY KEY,
  listing_id  INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  price       INTEGER NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX idx_price_history_listing ON price_history(listing_id, observed_at);

-- Résultats d'enrichissement propres à une annonce (ex. financement personnalisé)
CREATE TABLE listing_enrichments (
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  status     TEXT NOT NULL,                   -- "ok" | "error" | "pending"
  data       TEXT,                            -- JSON
  error      TEXT,
  fetched_at TEXT,
  PRIMARY KEY (listing_id, provider)
);

-- Cache des données communales, partagé entre toutes les annonces et tous les utilisateurs
CREATE TABLE commune_data (
  insee_code TEXT NOT NULL,
  provider   TEXT NOT NULL,
  data       TEXT NOT NULL,                   -- JSON
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (insee_code, provider)
);

-- Store de sessions express-session
CREATE TABLE sessions (
  sid    TEXT PRIMARY KEY,
  expire INTEGER NOT NULL,
  sess   TEXT NOT NULL
);
