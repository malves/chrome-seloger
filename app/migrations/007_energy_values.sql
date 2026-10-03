-- Valeurs chiffrées de la performance énergétique, en complément des notes
-- A..G déjà stockées dans `dpe` et `ges`. Elles permettent l'affichage
-- réglementaire du DPE/GES (consommation en kWhEP/m².an, émissions en
-- kg CO₂/m².an).

ALTER TABLE listings ADD COLUMN dpe_value REAL;  -- consommation énergie primaire (kWhEP/m².an)
ALTER TABLE listings ADD COLUMN ges_value REAL;  -- émissions de gaz à effet de serre (kg CO₂/m².an)
