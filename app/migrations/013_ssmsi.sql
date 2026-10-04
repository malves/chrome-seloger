-- Base SSMSI (délinquance enregistrée, échelle communale et départementale).

CREATE TABLE ssmsi_import_jobs (
  id            INTEGER PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'pending',
  source_label  TEXT,
  source_url    TEXT,
  rows_commune  INTEGER NOT NULL DEFAULT 0,
  rows_dep      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX idx_ssmsi_import_jobs_created ON ssmsi_import_jobs(created_at DESC);

CREATE TABLE ssmsi_commune (
  insee_code    TEXT NOT NULL,
  year          INTEGER NOT NULL,
  indicator     TEXT NOT NULL,
  label         TEXT NOT NULL,
  volume        INTEGER,
  rate_per_1000 REAL,
  PRIMARY KEY (insee_code, year, indicator)
);

CREATE INDEX idx_ssmsi_commune_lookup ON ssmsi_commune(insee_code, year);

CREATE TABLE ssmsi_department (
  dept_code     TEXT NOT NULL,
  year          INTEGER NOT NULL,
  indicator     TEXT NOT NULL,
  label         TEXT NOT NULL,
  volume        INTEGER,
  rate_per_1000 REAL,
  PRIMARY KEY (dept_code, year, indicator)
);

CREATE INDEX idx_ssmsi_department_lookup ON ssmsi_department(dept_code, year);
