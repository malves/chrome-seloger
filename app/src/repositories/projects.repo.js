/**
 * Accès aux tables `projects` et `listing_projects`.
 *
 * Toutes les lectures et écritures passent par `user_id` : un projet d'un
 * autre compte est introuvable, et une annonce ne peut être rattachée qu'à un
 * projet de son propriétaire.
 */

import { nowIso } from "../lib/time.js";

const SELECT_PROJECT = `
  SELECT p.*,
    (SELECT COUNT(*) FROM listing_projects lp WHERE lp.project_id = p.id) AS listing_count
  FROM projects p
`;

/** Ordre d'affichage : le projet par défaut d'abord, puis par nom. */
const ORDER = "ORDER BY p.is_default DESC, p.name COLLATE NOCASE";

/** Ordre choisi à la main par l'utilisateur (glisser-déposer). */
const ORDER_LIST = "ORDER BY p.position, p.id";

function hydrate(row) {
  if (!row) return null;
  return { ...row, is_default: Boolean(row.is_default) };
}

export default function createProjectsRepository(db) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO projects (user_id, name, slug, color, is_default, position, created_at)
       VALUES (@user_id, @name, @slug, @color, @is_default, @position, @created_at)`
    ),
    maxPosition: db.prepare(
      "SELECT COALESCE(MAX(position), -1) AS max FROM projects WHERE user_id = ?"
    ),
    updatePosition: db.prepare(
      "UPDATE projects SET position = ? WHERE id = ? AND user_id = ?"
    ),
    byId: db.prepare(`${SELECT_PROJECT} WHERE p.id = ? AND p.user_id = ?`),
    bySlug: db.prepare(`${SELECT_PROJECT} WHERE p.user_id = ? AND p.slug = ?`),
    byName: db.prepare(
      `${SELECT_PROJECT} WHERE p.user_id = ? AND p.name = ? COLLATE NOCASE ${ORDER} LIMIT 1`
    ),
    defaultForUser: db.prepare(
      `${SELECT_PROJECT} WHERE p.user_id = ? AND p.is_default = 1`
    ),
    byUser: db.prepare(`${SELECT_PROJECT} WHERE p.user_id = ? ${ORDER_LIST}`),
    rename: db.prepare(
      "UPDATE projects SET name = ?, slug = ? WHERE id = ? AND user_id = ?"
    ),
    clearDefault: db.prepare(
      "UPDATE projects SET is_default = 0 WHERE user_id = ? AND is_default = 1"
    ),
    markDefault: db.prepare(
      "UPDATE projects SET is_default = 1 WHERE id = ? AND user_id = ?"
    ),
    remove: db.prepare(
      "DELETE FROM projects WHERE id = ? AND user_id = ? AND is_default = 0"
    ),
    countByUser: db.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?"),

    link: db.prepare(
      `INSERT INTO listing_projects (listing_id, project_id, added_at)
       VALUES (?, ?, ?)
       ON CONFLICT (listing_id, project_id) DO NOTHING`
    ),
    unlinkAll: db.prepare("DELETE FROM listing_projects WHERE listing_id = ?"),
    forListing: db.prepare(
      `SELECT p.id, p.name, p.slug, p.color, p.is_default
       FROM listing_projects lp
       JOIN projects p ON p.id = lp.project_id
       WHERE lp.listing_id = ?
       ${ORDER}`
    ),
    /** Annonces du compte qui ne sont plus rattachées à aucun projet. */
    orphans: db.prepare(
      `SELECT l.id FROM listings l
       WHERE l.user_id = ?
         AND NOT EXISTS (SELECT 1 FROM listing_projects lp WHERE lp.listing_id = l.id)`
    ),

    /* ----------- Adresses de référence (liaison vers le carnet) ----------- */

    addressesByProject: db.prepare(
      `SELECT a.id, a.label, a.address, a.lat, a.lng, l.position
       FROM project_address_links l
       JOIN addresses a ON a.id = l.address_id
       WHERE l.project_id = ?
       ORDER BY l.position, a.id`
    ),
    countAddresses: db.prepare(
      "SELECT COUNT(*) AS n FROM project_address_links WHERE project_id = ?"
    ),
    maxLinkPosition: db.prepare(
      "SELECT COALESCE(MAX(position), -1) AS max FROM project_address_links WHERE project_id = ?"
    ),
    isLinked: db.prepare(
      "SELECT 1 FROM project_address_links WHERE project_id = ? AND address_id = ?"
    ),
    linkAddress: db.prepare(
      `INSERT INTO project_address_links (project_id, address_id, position, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, address_id) DO NOTHING`
    ),
    unlinkAddress: db.prepare(
      "DELETE FROM project_address_links WHERE project_id = ? AND address_id = ?"
    ),
  };

  const repository = {
    create({ userId, name, slug, color = null, isDefault = false }) {
      const info = statements.insert.run({
        user_id: userId,
        name,
        slug,
        color,
        is_default: isDefault ? 1 : 0,
        // Un nouveau projet se range toujours à la fin de l'ordre choisi.
        position: statements.maxPosition.get(userId).max + 1,
        created_at: nowIso(),
      });
      return hydrate(statements.byId.get(info.lastInsertRowid, userId));
    },

    findById(userId, id) {
      return hydrate(statements.byId.get(id, userId));
    },

    findBySlug(userId, slug) {
      return hydrate(statements.bySlug.get(userId, String(slug || "")));
    },

    findByName(userId, name) {
      return hydrate(statements.byName.get(userId, String(name || "").trim()));
    },

    findDefault(userId) {
      return hydrate(statements.defaultForUser.get(userId));
    },

    listByUser(userId) {
      return statements.byUser.all(userId).map(hydrate);
    },

    countByUser(userId) {
      return statements.countByUser.get(userId).n;
    },

    rename(userId, id, name, slug) {
      return statements.rename.run(name, slug, id, userId).changes > 0;
    },

    /** Déplace le drapeau « par défaut » ; il reste toujours exactement un projet par défaut. */
    setDefault: db.transaction((userId, id) => {
      statements.clearDefault.run(userId);
      return statements.markDefault.run(id, userId).changes > 0;
    }),

    /** Le projet par défaut est protégé : il n'est jamais supprimable. */
    remove(userId, id) {
      return statements.remove.run(id, userId).changes > 0;
    },

    /**
     * Fige l'ordre d'affichage choisi à la main : chaque identifiant reçoit sa
     * position dans la liste fournie. Seuls les projets du compte sont touchés.
     */
    reorder: db.transaction((userId, orderedIds) => {
      orderedIds.forEach((id, index) => {
        statements.updatePosition.run(index, id, userId);
      });
    }),

    /* ------------------------ Table de liaison ------------------------ */

    /** Ajoute sans retirer : une annonce déjà classée conserve ses projets. */
    addListing: db.transaction((listingId, projectIds, at = nowIso()) => {
      for (const projectId of projectIds) {
        statements.link.run(listingId, projectId, at);
      }
    }),

    /** Remplace l'ensemble des projets d'une annonce. */
    setListingProjects: db.transaction((listingId, projectIds, at = nowIso()) => {
      statements.unlinkAll.run(listingId);
      for (const projectId of projectIds) {
        statements.link.run(listingId, projectId, at);
      }
    }),

    listForListing(listingId) {
      return statements.forListing.all(listingId).map(hydrate);
    },

    /**
     * Projets de plusieurs annonces en une requête : évite un appel par carte
     * sur la page de liste.
     */
    forListings(listingIds) {
      const byListing = new Map();
      if (!listingIds.length) return byListing;

      const placeholders = listingIds.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT lp.listing_id, p.id, p.name, p.slug, p.color, p.is_default
           FROM listing_projects lp
           JOIN projects p ON p.id = lp.project_id
           WHERE lp.listing_id IN (${placeholders})
           ${ORDER}`
        )
        .all(listingIds);

      for (const row of rows) {
        const { listing_id: listingId, ...project } = row;
        if (!byListing.has(listingId)) byListing.set(listingId, []);
        byListing.get(listingId).push(hydrate(project));
      }
      return byListing;
    },

    orphanListingIds(userId) {
      return statements.orphans.all(userId).map((row) => row.id);
    },

    /* ----------- Adresses de référence (liaison vers le carnet) ----------- */

    /** Adresses du carnet reliées à ce projet, dans l'ordre d'affichage. */
    listAddresses(projectId) {
      return statements.addressesByProject.all(projectId);
    },

    countAddresses(projectId) {
      return statements.countAddresses.get(projectId).n;
    },

    isAddressLinked(projectId, addressId) {
      return Boolean(statements.isLinked.get(projectId, addressId));
    },

    /** Relie une adresse du carnet au projet (sans doublon). */
    linkAddress(projectId, addressId) {
      const position = statements.maxLinkPosition.get(projectId).max + 1;
      return (
        statements.linkAddress.run(projectId, addressId, position, nowIso())
          .changes > 0
      );
    },

    /** Détache une adresse du projet ; l'adresse reste dans le carnet. */
    unlinkAddress(projectId, addressId) {
      return statements.unlinkAddress.run(projectId, addressId).changes > 0;
    },
  };

  return repository;
}
