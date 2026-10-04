-- Paramètres globaux de l'application (administration).
-- Valeurs flexibles en TEXT contenant du JSON.

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
