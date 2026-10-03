-- Ordre d'affichage des projets, défini à la main par l'utilisateur (poignée
-- de glisser-déposer sur la page « Projets »). Une fois rangés, les projets
-- s'affichent toujours dans cet ordre, et dans aucun autre.

ALTER TABLE projects ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- Reprise de l'existant : on fige l'ordre affiché jusqu'ici (projet par défaut
-- d'abord, puis par nom) comme position de départ, par compte.
WITH ordered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY is_default DESC, name COLLATE NOCASE
    ) - 1 AS pos
  FROM projects
)
UPDATE projects
SET position = (SELECT pos FROM ordered WHERE ordered.id = projects.id);

CREATE INDEX idx_projects_position ON projects(user_id, position, id);
