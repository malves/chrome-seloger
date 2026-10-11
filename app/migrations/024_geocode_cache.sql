-- Cache des géocodages du moteur de localisation probable (Nominatim / BAN).
-- Évite de re-frapper les fournisseurs soumis à des rate-limits (Nominatim
-- ~1 req/s) et accélère les estimations répétées sur une même annonce.

CREATE TABLE geocode_cache (
  query_hash  TEXT PRIMARY KEY,   -- empreinte de (provider + requête normalisée)
  provider    TEXT NOT NULL,      -- 'nominatim' | 'ban'
  query       TEXT NOT NULL,      -- requête lisible (debug)
  found       INTEGER NOT NULL,   -- 1 = lieu trouvé, 0 = aucun résultat (négatif mis en cache)
  place       TEXT,
  lat         REAL,
  lng         REAL,
  confidence  REAL,
  raw_json    TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_geocode_cache_created ON geocode_cache(created_at);
