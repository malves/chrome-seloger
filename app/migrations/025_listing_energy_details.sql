-- Caractéristiques énergétiques déclarées par l'annonce, en valeur brute du site
-- (SeLoger : `classified.sections.energy.features[].value`). La normalisation
-- éventuelle (ex. « Gaz » ↔ « Gaz naturel » ADEME) se fait à la comparaison.

ALTER TABLE listings ADD COLUMN energy_source TEXT;       -- ex. « Gaz », « Électricité »
ALTER TABLE listings ADD COLUMN heating_system TEXT;      -- ex. « Chauffage central: Radiateur »
ALTER TABLE listings ADD COLUMN property_condition TEXT;  -- ex. « Rénovation nécessaire »
