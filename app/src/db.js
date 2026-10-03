/**
 * Connexion SQLite et exécution des migrations.
 *
 * Les migrations sont les fichiers `/migrations/NNN_*.sql` triés par nom.
 * Chacune est appliquée dans une transaction et enregistrée dans
 * `schema_migrations` : une migration déjà appliquée n'est jamais rejouée.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import config, { rootDir } from "./config.js";

const MIGRATIONS_DIR = path.join(rootDir, "migrations");

function ensureDirectory(filePath) {
  if (filePath === ":memory:" || filePath.startsWith("file:")) return;
  const dir = path.dirname(path.resolve(rootDir, filePath));
  fs.mkdirSync(dir, { recursive: true });
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => row.version)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const record = db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    })();
  }

  return files.length;
}

export function openDatabase(databasePath = config.databasePath) {
  ensureDirectory(databasePath);
  const resolved =
    databasePath === ":memory:"
      ? databasePath
      : path.resolve(rootDir, databasePath);

  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

let singleton = null;

/** Connexion partagée du process serveur. */
export function getDatabase() {
  if (!singleton) singleton = openDatabase();
  return singleton;
}
