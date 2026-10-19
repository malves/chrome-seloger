/**
 * Catalogue éditable des questions de visite (`visit_questions`).
 * Une ligne = une question ; `data` porte le contenu (JSON), les colonnes
 * l'organisation (étape, position, niveau, archivage).
 */

import { nowIso } from "../lib/time.js";
import { fromJson, toJson } from "../lib/json.js";

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    section: row.section,
    position: row.position,
    essential: row.essential === 1,
    builtin: row.builtin === 1,
    data: fromJson(row.data, {}) || {},
    archivedAt: row.archived_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default function createVisitQuestionsRepository(db) {
  const statements = {
    listActive: db.prepare(
      "SELECT * FROM visit_questions WHERE archived_at IS NULL ORDER BY section, position, id"
    ),
    listArchived: db.prepare(
      "SELECT * FROM visit_questions WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, id"
    ),
    ids: db.prepare("SELECT id FROM visit_questions"),
    byId: db.prepare("SELECT * FROM visit_questions WHERE id = ?"),
    count: db.prepare("SELECT COUNT(*) AS n FROM visit_questions"),
    maxPosition: db.prepare(
      "SELECT COALESCE(MAX(position), -1) AS p FROM visit_questions WHERE section = ? AND archived_at IS NULL"
    ),
    insert: db.prepare(
      `INSERT OR IGNORE INTO visit_questions
         (id, section, position, essential, builtin, data, archived_at, created_at, updated_at)
       VALUES (@id, @section, @position, @essential, @builtin, @data, NULL, @now, @now)`
    ),
    update: db.prepare(
      `UPDATE visit_questions
          SET section = @section, position = @position, essential = @essential,
              data = @data, updated_at = @now
        WHERE id = @id`
    ),
    placement: db.prepare(
      `UPDATE visit_questions
          SET section = @section, position = @position, essential = @essential, updated_at = @now
        WHERE id = @id AND archived_at IS NULL`
    ),
    archive: db.prepare(
      "UPDATE visit_questions SET archived_at = @now, updated_at = @now WHERE id = @id AND archived_at IS NULL"
    ),
    restore: db.prepare(
      `UPDATE visit_questions
          SET archived_at = NULL, section = @section, position = @position, updated_at = @now
        WHERE id = @id AND archived_at IS NOT NULL`
    ),
  };

  function nextPosition(section) {
    return statements.maxPosition.get(section).p + 1;
  }

  return {
    listActive() {
      return statements.listActive.all().map(hydrate);
    },

    listArchived() {
      return statements.listArchived.all().map(hydrate);
    },

    allIds() {
      return statements.ids.all().map((r) => r.id);
    },

    byId(id) {
      return hydrate(statements.byId.get(String(id)));
    },

    count() {
      return statements.count.get().n;
    },

    nextPosition,

    /** Insère sans écraser une ligne existante. Renvoie true si insérée. */
    insert({ id, section, position, essential = false, builtin = false, data }) {
      const info = statements.insert.run({
        id,
        section,
        position: Number.isInteger(position) ? position : nextPosition(section),
        essential: essential ? 1 : 0,
        builtin: builtin ? 1 : 0,
        data: toJson(data),
        now: nowIso(),
      });
      return info.changes > 0;
    },

    update(id, { section, position, essential, data }) {
      statements.update.run({
        id,
        section,
        position,
        essential: essential ? 1 : 0,
        data: toJson(data),
        now: nowIso(),
      });
      return this.byId(id);
    },

    /** Étape, position et niveau de plusieurs questions, en une transaction. */
    reorder(placements) {
      const now = nowIso();
      db.transaction(() => {
        for (const p of placements) {
          statements.placement.run({
            id: p.id,
            section: p.section,
            position: p.position,
            essential: p.essential ? 1 : 0,
            now,
          });
        }
      })();
    },

    archive(id) {
      return statements.archive.run({ id, now: nowIso() }).changes > 0;
    },

    /** Restaure en fin d'étape. */
    restore(id, section) {
      return (
        statements.restore.run({ id, section, position: nextPosition(section), now: nowIso() })
          .changes > 0
      );
    },

    transaction(fn) {
      return db.transaction(fn)();
    },
  };
}
