-- Projets de recherche : « Résidence principale », « Maison de campagne », ...
-- Une annonce peut appartenir à plusieurs projets ; elle en a toujours au
-- moins un, le projet par défaut servant de repli.

CREATE TABLE projects (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL,                   -- identifiant stable pour les URL et l'extension
  color      TEXT,                            -- couleur de pastille, choisie dans une palette fermée
  is_default INTEGER NOT NULL DEFAULT 0,      -- destination des annonces reçues sans projet
  created_at TEXT NOT NULL,
  UNIQUE (user_id, slug)
);

-- Un seul projet par défaut par compte, garanti par la base.
CREATE UNIQUE INDEX idx_projects_default ON projects(user_id) WHERE is_default = 1;

CREATE TABLE listing_projects (
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  added_at   TEXT NOT NULL,
  PRIMARY KEY (listing_id, project_id)
);
CREATE INDEX idx_listing_projects_project ON listing_projects(project_id);

-- Reprise de l'existant : un projet par défaut par compte, qui reçoit toutes
-- les annonces déjà enregistrées.
INSERT INTO projects (user_id, name, slug, color, is_default, created_at)
SELECT id, 'Recherche principale', 'recherche-principale', '#0b3d2c', 1, created_at
FROM users;

INSERT INTO listing_projects (listing_id, project_id, added_at)
SELECT l.id, p.id, l.first_saved_at
FROM listings l
JOIN projects p ON p.user_id = l.user_id AND p.is_default = 1;
