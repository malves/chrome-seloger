-- Recherche admin par type de bâtiment seul (filtre + tri par date de modif.).

CREATE INDEX IF NOT EXISTS idx_dpe_records_type_batiment
  ON dpe_records(type_batiment, date_derniere_modification_dpe, numero_dpe);
