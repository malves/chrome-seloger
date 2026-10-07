-- Médianes DVF précalculées par département / année / type, pour comparer
-- l'évolution communale au marché départemental (courbe façon SeLoger).
-- SQLite n'a pas de MEDIAN : les valeurs sont recalculées à l'import.

CREATE TABLE dvf_department_stats (
  dept_code       TEXT NOT NULL,
  type_local      TEXT NOT NULL,       -- 'house' | 'apartment'
  year            INTEGER NOT NULL,
  count           INTEGER NOT NULL,
  median_price_m2 REAL NOT NULL,
  PRIMARY KEY (dept_code, type_local, year)
);

-- Parcours ordonné pour le calcul des médianes départementales.
CREATE INDEX idx_dvf_mutation_dept_stats
  ON dvf_mutation(dept_code, type_local, year, price_per_m2);
