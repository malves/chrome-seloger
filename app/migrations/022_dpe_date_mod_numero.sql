-- Pagination admin : filtre par jour de dernière modification + tri par n° DPE.

CREATE INDEX IF NOT EXISTS idx_dpe_records_date_mod_numero
  ON dpe_records(date_derniere_modification_dpe, numero_dpe);
