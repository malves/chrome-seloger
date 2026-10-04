-- Progression intra-journée de l'import DPE : permet d'afficher une barre qui
-- avance pendant le traitement d'une même journée (jusqu'à ~13 000 lignes),
-- afin de distinguer « ça tourne toujours » de « ça a planté ».

ALTER TABLE dpe_import_jobs ADD COLUMN day_rows_total INTEGER NOT NULL DEFAULT 0; -- lignes attendues pour le jour en cours
ALTER TABLE dpe_import_jobs ADD COLUMN day_rows_done  INTEGER NOT NULL DEFAULT 0; -- lignes déjà enregistrées pour ce jour
