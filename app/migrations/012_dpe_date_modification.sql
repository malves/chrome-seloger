-- Colonne indexée pour filtrer / ré-importer par jour de dernière modification
-- (open data ADEME), distincte de la date d'établissement du DPE.

ALTER TABLE dpe_records ADD COLUMN date_derniere_modification_dpe TEXT;

CREATE INDEX idx_dpe_records_date_mod ON dpe_records(date_derniere_modification_dpe);
