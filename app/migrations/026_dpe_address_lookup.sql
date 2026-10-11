-- Recherche du DPE d'une adresse saisie : index couvrant (aucune lecture de la
-- ligne JSON, un code postal pouvant compter ~70 000 DPE).

CREATE INDEX IF NOT EXISTS idx_dpe_records_address_lookup
  ON dpe_records(code_postal_ban, adresse_ban, adresse_brut, type_batiment, numero_dpe);
