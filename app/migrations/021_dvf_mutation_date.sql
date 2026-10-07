-- Date de mutation DVF (geo-dvf) pour pondérer les ventes récentes dans le rayon.
ALTER TABLE dvf_mutation ADD COLUMN mutation_date TEXT;
