-- Cache des données départementales, partagé entre toutes les annonces et tous
-- les utilisateurs (prix Immo Data `geoLevel=department`, délinquance SSMSI
-- départementale). Même modèle que `commune_data`, clé par code département.
CREATE TABLE department_data (
  dept_code  TEXT NOT NULL,
  provider   TEXT NOT NULL,
  data       TEXT NOT NULL,                   -- JSON
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (dept_code, provider)
);
