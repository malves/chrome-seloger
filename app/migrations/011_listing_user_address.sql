-- Adresse réelle du bien, saisie à la main par l'utilisateur (ou, à terme,
-- déterminée automatiquement). Stockée dans des colonnes dédiées, distinctes
-- de la localisation déclarée par l'annonce (`city`, `postal_code`, `lat`,
-- `lng`) : une ré-importation par l'extension ne doit jamais l'écraser.

ALTER TABLE listings ADD COLUMN user_address TEXT;             -- adresse saisie
ALTER TABLE listings ADD COLUMN user_lat REAL;                 -- latitude géocodée (BAN/ORS)
ALTER TABLE listings ADD COLUMN user_lng REAL;                 -- longitude géocodée (BAN/ORS)
ALTER TABLE listings ADD COLUMN user_address_source TEXT;      -- 'manual' aujourd'hui, 'detected' demain
ALTER TABLE listings ADD COLUMN user_address_updated_at TEXT;  -- ISO 8601 UTC
