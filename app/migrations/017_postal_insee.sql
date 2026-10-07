-- Correspondance code postal / code INSEE (fichier HexaSmal, La Poste).

CREATE TABLE postal_insee (
  postal_code TEXT NOT NULL,
  insee_code  TEXT NOT NULL,
  PRIMARY KEY (postal_code, insee_code)
);

CREATE INDEX idx_postal_insee_postal ON postal_insee(postal_code);
