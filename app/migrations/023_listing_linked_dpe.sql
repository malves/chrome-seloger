-- DPE officiel associé à l'adresse réelle (sélection via « Déterminer l'adresse »).
ALTER TABLE listings ADD COLUMN linked_dpe_numero TEXT;
