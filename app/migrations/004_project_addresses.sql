-- Adresses de référence d'un projet : points depuis lesquels on veut connaître
-- le temps de trajet voiture d'une annonce (domicile, bureau, école, gare…).
-- Un projet peut en compter plusieurs ; les coordonnées sont géocodées côté
-- serveur à l'enregistrement (nullables tant que le géocodage n'a rien donné).

CREATE TABLE project_addresses (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label      TEXT,                       -- libellé libre : « Bureau », « École »…
  address    TEXT NOT NULL,              -- adresse saisie, géocodée telle quelle
  lat        REAL,                       -- latitude géocodée (nullable)
  lng        REAL,                       -- longitude géocodée (nullable)
  position   INTEGER NOT NULL DEFAULT 0, -- ordre d'affichage
  created_at TEXT NOT NULL
);

CREATE INDEX idx_project_addresses_project
  ON project_addresses(project_id, position, id);
