/**
 * Accès aux tables `listings`, `listing_photos` et `price_history`.
 *
 * Toutes les lectures prennent `userId` en premier argument : une annonce
 * d'un autre compte est introuvable, jamais seulement masquée.
 */

import { nowIso } from "../lib/time.js";
import { fromJson, toJson } from "../lib/json.js";

/** Colonnes descriptives, écrasées à chaque réception d'une annonce. */
const DESCRIPTIVE_COLUMNS = [
  "source",
  "source_id",
  "url",
  "transaction_type",
  "property_type",
  "title",
  "description",
  "price",
  "surface",
  "land_surface",
  "rooms",
  "bedrooms",
  "floor",
  "year_built",
  "dpe",
  "ges",
  "dpe_value",
  "ges_value",
  "is_new_build",
  "city",
  "postal_code",
  "insee_code",
  "lat",
  "lng",
  "agency",
  "features",
  "extension_data",
  "raw",
];

const JSON_COLUMNS = new Set(["agency", "features", "extension_data", "raw"]);

/** Tris proposés dans l'interface ; aucune valeur libre n'atteint le SQL. */
export const SORTS = {
  saved: {
    label: "Enregistrement récent",
    sql: "l.last_saved_at DESC, l.id DESC",
  },
  price: {
    label: "Prix croissant",
    sql: "l.price IS NULL, l.price ASC, l.id DESC",
  },
  price_desc: {
    label: "Prix décroissant",
    sql: "l.price IS NULL, l.price DESC, l.id DESC",
  },
  price_m2: {
    label: "Prix au m² croissant",
    sql: "price_per_m2 IS NULL, price_per_m2 ASC, l.id DESC",
  },
  surface: {
    label: "Surface décroissante",
    sql: "l.surface IS NULL, l.surface DESC, l.id DESC",
  },
};

export const DEFAULT_SORT = "saved";

/** Restriction à un projet, réutilisée par la recherche et par les compteurs. */
const PROJECT_CLAUSE = `EXISTS (
  SELECT 1 FROM listing_projects lp
  WHERE lp.listing_id = l.id AND lp.project_id = @project_id
)`;

const SELECT_CARD = `
  SELECT l.*,
    (SELECT p.url FROM listing_photos p
      WHERE p.listing_id = l.id ORDER BY p.position LIMIT 1) AS photo_url,
    (SELECT COUNT(*) FROM listing_photos p WHERE p.listing_id = l.id) AS photo_count,
    (SELECT ph.price FROM price_history ph
      WHERE ph.listing_id = l.id
      ORDER BY ph.observed_at DESC, ph.id DESC LIMIT 1 OFFSET 1) AS previous_price,
    (SELECT COUNT(*) FROM price_history ph WHERE ph.listing_id = l.id) AS price_points,
    CASE WHEN l.price IS NOT NULL AND l.surface > 0
      THEN l.price / l.surface END AS price_per_m2
  FROM listings l
`;

/** Transforme une ligne SQL en objet exploitable par les vues. */
export function hydrateListing(row) {
  if (!row) return null;
  const listing = { ...row };
  listing.agency = fromJson(row.agency, null);
  listing.features = fromJson(row.features, []);
  listing.extension_data = fromJson(row.extension_data, null);
  listing.raw = fromJson(row.raw, null);
  listing.is_new_build = Boolean(row.is_new_build);
  listing.is_favorite = Boolean(row.is_favorite);

  listing.price_per_m2 =
    row.price != null && row.surface > 0
      ? Math.round(row.price / row.surface)
      : null;

  if (row.previous_price != null && row.price != null && row.previous_price !== row.price) {
    const delta = row.price - row.previous_price;
    listing.price_change = {
      direction: delta < 0 ? "down" : "up",
      delta,
      percent: row.previous_price
        ? Math.round((delta / row.previous_price) * 1000) / 10
        : null,
      previous: row.previous_price,
    };
  } else {
    listing.price_change = null;
  }

  return listing;
}

function toColumnValue(column, value) {
  if (JSON_COLUMNS.has(column)) return toJson(value);
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/**
 * `projects` est injecté plutôt que requêté ici : tout le SQL de la table de
 * liaison reste dans un seul repository.
 */
export default function createListingsRepository(db, { projects }) {
  const insertSql = `INSERT INTO listings (
      user_id, dedup_key, ${DESCRIPTIVE_COLUMNS.join(", ")},
      first_saved_at, last_saved_at
    ) VALUES (
      @user_id, @dedup_key, ${DESCRIPTIVE_COLUMNS.map((c) => `@${c}`).join(", ")},
      @first_saved_at, @last_saved_at
    )`;

  const updateSql = `UPDATE listings SET
      ${DESCRIPTIVE_COLUMNS.map((c) => `${c} = @${c}`).join(", ")},
      last_saved_at = @last_saved_at
    WHERE id = @id AND user_id = @user_id`;

  const statements = {
    insert: db.prepare(insertSql),
    update: db.prepare(updateSql),
    byId: db.prepare(`${SELECT_CARD} WHERE l.id = ? AND l.user_id = ?`),
    byIdOnly: db.prepare(`${SELECT_CARD} WHERE l.id = ?`),
    byDedupKey: db.prepare(
      "SELECT * FROM listings WHERE user_id = ? AND dedup_key = ?"
    ),
    byUrl: db.prepare("SELECT * FROM listings WHERE user_id = ? AND url = ?"),
    remove: db.prepare("DELETE FROM listings WHERE id = ? AND user_id = ?"),
    setInseeIfEmpty: db.prepare(
      "UPDATE listings SET insee_code = ? WHERE id = ? AND insee_code IS NULL"
    ),
    setInsee: db.prepare("UPDATE listings SET insee_code = ? WHERE id = ?"),
    setStatus: db.prepare(
      `UPDATE listings SET status = @status, status_progress = @status_progress
       WHERE id = @id AND user_id = @user_id`
    ),
    setFavorite: db.prepare(
      "UPDATE listings SET is_favorite = ? WHERE id = ? AND user_id = ?"
    ),
    setNotes: db.prepare(
      "UPDATE listings SET notes = ? WHERE id = ? AND user_id = ?"
    ),
    setUserAddress: db.prepare(
      `UPDATE listings SET
         user_address = @address,
         user_lat = @lat,
         user_lng = @lng,
         user_address_source = @source,
         user_address_updated_at = @updated_at
       WHERE id = @id AND user_id = @user_id`
    ),
    countByUser: db.prepare(
      `SELECT COUNT(*) AS n FROM listings l WHERE l.user_id = @user_id
       AND (@project_id IS NULL OR ${PROJECT_CLAUSE})`
    ),
    countFavorites: db.prepare(
      "SELECT COUNT(*) AS n FROM listings WHERE user_id = ? AND is_favorite = 1"
    ),
    cities: db.prepare(
      `SELECT l.city AS city, COUNT(*) AS n FROM listings l
       WHERE l.user_id = @user_id AND l.city IS NOT NULL AND l.city <> ''
         AND (@project_id IS NULL OR ${PROJECT_CLAUSE})
       GROUP BY l.city ORDER BY l.city COLLATE NOCASE`
    ),
    statusCounts: db.prepare(
      `SELECT l.status AS status, COUNT(*) AS n FROM listings l
       WHERE l.user_id = @user_id
         AND (@project_id IS NULL OR ${PROJECT_CLAUSE})
       GROUP BY l.status`
    ),
    anyById: db.prepare("SELECT id FROM listings WHERE id = ?"),

    insertPhoto: db.prepare(
      "INSERT INTO listing_photos (listing_id, position, url) VALUES (?, ?, ?)"
    ),
    deletePhotos: db.prepare("DELETE FROM listing_photos WHERE listing_id = ?"),
    listPhotos: db.prepare(
      "SELECT url FROM listing_photos WHERE listing_id = ? ORDER BY position"
    ),

    insertPrice: db.prepare(
      "INSERT INTO price_history (listing_id, price, observed_at) VALUES (?, ?, ?)"
    ),
    listPrices: db.prepare(
      `SELECT price, observed_at FROM price_history
       WHERE listing_id = ? ORDER BY observed_at, id`
    ),
  };

  function buildValues(userId, dedupKey, fields, timestamps) {
    const values = { user_id: userId, dedup_key: dedupKey, ...timestamps };
    for (const column of DESCRIPTIVE_COLUMNS) {
      values[column] = toColumnValue(column, fields[column]);
    }
    return values;
  }

  /** Ajoute `projects` à chaque annonce, en une seule requête de liaison. */
  function withProjects(listings) {
    const byListing = projects.forListings(listings.map((l) => l.id));
    for (const listing of listings) {
      listing.projects = byListing.get(listing.id) || [];
    }
    return listings;
  }

  return {
    findByDedupKey(userId, dedupKey) {
      return statements.byDedupKey.get(userId, dedupKey) || null;
    },

    findByUrl(userId, url) {
      return statements.byUrl.get(userId, url) || null;
    },

    findById(userId, id) {
      const listing = hydrateListing(statements.byId.get(id, userId));
      if (listing) withProjects([listing]);
      return listing;
    },

    /** Charge une annonce par identifiant (tous comptes), pour l'administration. */
    findByIdOnly(id) {
      const listing = hydrateListing(statements.byIdOnly.get(id));
      if (listing) withProjects([listing]);
      return listing;
    },

    /** Vrai si l'annonce existe, quel qu'en soit le propriétaire. */
    exists(id) {
      return Boolean(statements.anyById.get(id));
    },

    insert(userId, dedupKey, fields, at = nowIso()) {
      const info = statements.insert.run(
        buildValues(userId, dedupKey, fields, {
          first_saved_at: at,
          last_saved_at: at,
        })
      );
      return Number(info.lastInsertRowid);
    },

    /** Met à jour les champs descriptifs ; statut, notes et favori sont préservés. */
    update(userId, id, fields, at = nowIso()) {
      const values = buildValues(userId, null, fields, { last_saved_at: at });
      delete values.dedup_key;
      values.id = id;
      statements.update.run(values);
      return id;
    },

    remove(userId, id) {
      return statements.remove.run(id, userId).changes > 0;
    },

    setInseeCode(id, inseeCode, { force = false } = {}) {
      if (force) {
        statements.setInsee.run(inseeCode ?? null, id);
      } else {
        statements.setInseeIfEmpty.run(inseeCode, id);
      }
    },

    setStatus(userId, id, status, statusProgress = null) {
      return (
        statements.setStatus.run({
          status,
          status_progress: statusProgress,
          id,
          user_id: userId,
        }).changes > 0
      );
    },

    setFavorite(userId, id, isFavorite) {
      return (
        statements.setFavorite.run(isFavorite ? 1 : 0, id, userId).changes > 0
      );
    },

    setNotes(userId, id, notes) {
      return statements.setNotes.run(notes || null, id, userId).changes > 0;
    },

    /**
     * Adresse réelle du bien saisie par l'utilisateur. Une adresse vide efface
     * aussi les coordonnées et la source : le champ revient à son état initial.
     */
    setUserAddress(userId, id, { address, lat, lng, source } = {}) {
      const cleaned = address ? String(address) : null;
      return (
        statements.setUserAddress.run({
          id,
          user_id: userId,
          address: cleaned,
          lat: cleaned && lat != null ? lat : null,
          lng: cleaned && lng != null ? lng : null,
          source: cleaned ? source || "manual" : null,
          updated_at: cleaned ? nowIso() : null,
        }).changes > 0
      );
    },

    countByUser(userId, projectId = null) {
      return statements.countByUser.get({ user_id: userId, project_id: projectId }).n;
    },

    countFavorites(userId) {
      return statements.countFavorites.get(userId).n;
    },

    citiesByUser(userId, projectId = null) {
      return statements.cities.all({ user_id: userId, project_id: projectId });
    },

    statusCounts(userId, projectId = null) {
      const counts = {};
      const rows = statements.statusCounts.all({
        user_id: userId,
        project_id: projectId,
      });
      for (const row of rows) {
        counts[row.status] = row.n;
      }
      return counts;
    },

    replacePhotos: db.transaction((listingId, urls) => {
      statements.deletePhotos.run(listingId);
      urls.forEach((url, index) => {
        statements.insertPhoto.run(listingId, index, url);
      });
    }),

    listPhotos(listingId) {
      return statements.listPhotos.all(listingId).map((row) => row.url);
    },

    addPricePoint(listingId, price, at = nowIso()) {
      statements.insertPrice.run(listingId, price, at);
    },

    listPriceHistory(listingId) {
      return statements.listPrices.all(listingId);
    },

    /**
     * Recherche filtrée et triée. Les fragments SQL proviennent uniquement de
     * constantes du module ; les valeurs passent par des paramètres liés.
     *
     * `filters.limit` et `filters.offset` paginent le résultat : utilisés par
     * la liste pour n'afficher qu'une page d'annonces à la fois.
     */
    search(userId, filters = {}) {
      const { where, params } = buildSearchClause(userId, filters);

      const sort = SORTS[filters.sort] ? filters.sort : DEFAULT_SORT;
      // Sans filtre de statut, les écartées restent visibles mais passent après
      // les autres, quel que soit le tri choisi.
      const rejectedLast = filters.status ? "" : "(l.status = 'rejected'), ";

      let sql = `${SELECT_CARD} WHERE ${where.join(" AND ")} ORDER BY ${rejectedLast}${SORTS[sort].sql}`;

      // LIMIT/OFFSET seulement si une pagination est demandée. Les valeurs sont
      // forcées en entiers avant d'atteindre le SQL.
      if (Number.isFinite(filters.limit)) {
        sql += " LIMIT @limit";
        params.limit = Math.max(0, Math.trunc(filters.limit));
        if (Number.isFinite(filters.offset)) {
          sql += " OFFSET @offset";
          params.offset = Math.max(0, Math.trunc(filters.offset));
        }
      }

      return withProjects(db.prepare(sql).all(params).map(hydrateListing));
    },

    /** Nombre d'annonces correspondant aux mêmes filtres que `search`. */
    countSearch(userId, filters = {}) {
      const { where, params } = buildSearchClause(userId, filters);
      const sql = `SELECT COUNT(*) AS n FROM listings l WHERE ${where.join(" AND ")}`;
      return db.prepare(sql).get(params).n;
    },
  };

  /**
   * Construit la clause WHERE partagée par `search` et `countSearch`. Les
   * fragments SQL sont des constantes ; seules les valeurs sont liées.
   */
  function buildSearchClause(userId, filters) {
    const where = ["l.user_id = @user_id"];
    const params = { user_id: userId };

    if (filters.status) {
      where.push("l.status = @status");
      params.status = filters.status;
    }
    if (filters.propertyType) {
      where.push("l.property_type = @property_type");
      params.property_type = filters.propertyType;
    }
    if (filters.transactionType) {
      where.push("l.transaction_type = @transaction_type");
      params.transaction_type = filters.transactionType;
    }
    if (filters.city) {
      where.push("l.city = @city COLLATE NOCASE");
      params.city = filters.city;
    }
    if (filters.favorite) {
      where.push("l.is_favorite = 1");
    }
    if (Number.isFinite(filters.priceMin)) {
      where.push("l.price >= @price_min");
      params.price_min = filters.priceMin;
    }
    if (Number.isFinite(filters.priceMax)) {
      where.push("l.price <= @price_max");
      params.price_max = filters.priceMax;
    }
    if (filters.projectId) {
      where.push(PROJECT_CLAUSE);
      params.project_id = filters.projectId;
    }

    return { where, params };
  }
}
