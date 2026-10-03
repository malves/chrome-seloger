-- Carnet d'adresses normalisé : une adresse est stockée une seule fois par
-- compte, puis réutilisée par les projets via une table de liaison. Le carnet
-- devient la source de vérité : modifier une adresse se répercute partout, la
-- supprimer la retire de tous les projets (cascade).

CREATE TABLE addresses (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      TEXT,                       -- libellé libre : « Bureau », « École »…
  address    TEXT NOT NULL,              -- adresse saisie, géocodée telle quelle
  lat        REAL,                       -- latitude géocodée (nullable)
  lng        REAL,                       -- longitude géocodée (nullable)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Une adresse par compte, insensible à la casse : garde-fou de la déduplication.
CREATE UNIQUE INDEX idx_addresses_user_address
  ON addresses(user_id, address COLLATE NOCASE);

-- Liaison projet ↔ adresse du carnet. ON DELETE CASCADE des deux côtés : retirer
-- un projet ou une adresse du carnet nettoie automatiquement les liaisons.
CREATE TABLE project_address_links (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  address_id INTEGER NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0, -- ordre d'affichage dans le projet
  added_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, address_id)
);

CREATE INDEX idx_project_address_links_address
  ON project_address_links(address_id);

-- Reprise de l'existant : une entrée de carnet par (compte, adresse), en
-- conservant le libellé et les coordonnées de la saisie la plus récente
-- (celle de plus grand id dans le groupe).
INSERT INTO addresses (user_id, label, address, lat, lng, created_at, updated_at)
SELECT p.user_id, pa.label, pa.address, pa.lat, pa.lng, pa.created_at, pa.created_at
FROM project_addresses pa
JOIN projects p ON p.id = pa.project_id
WHERE pa.id IN (
  SELECT MAX(pa2.id)
  FROM project_addresses pa2
  JOIN projects p2 ON p2.id = pa2.project_id
  GROUP BY p2.user_id, pa2.address COLLATE NOCASE
);

-- Reconstruit les liaisons projet ↔ carnet depuis les anciennes lignes.
INSERT OR IGNORE INTO project_address_links (project_id, address_id, position, added_at)
SELECT pa.project_id, a.id, pa.position, pa.created_at
FROM project_addresses pa
JOIN projects p ON p.id = pa.project_id
JOIN addresses a ON a.user_id = p.user_id AND a.address = pa.address COLLATE NOCASE;

DROP TABLE project_addresses;
