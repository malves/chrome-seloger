-- Agrégat national SSMSI par indicateur et par année, calculé à l'import à
-- partir du fichier départemental (somme des faits / somme des populations).
-- Sert de référence « moyenne France » pour situer une commune.

CREATE TABLE ssmsi_national (
  year          INTEGER NOT NULL,
  indicator     TEXT NOT NULL,
  label         TEXT NOT NULL,
  volume        INTEGER,
  population    INTEGER,
  rate_per_1000 REAL,
  PRIMARY KEY (year, indicator)
);
