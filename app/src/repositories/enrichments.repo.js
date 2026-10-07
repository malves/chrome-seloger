/**
 * Accès aux résultats d'enrichissement.
 *
 * Trois portées :
 *  - `listing_enrichments` : résultat propre à une annonce ;
 *  - `commune_data` : cache partagé par code INSEE entre tous les comptes ;
 *  - `department_data` : cache partagé par code département.
 */

import { nowIso } from "../lib/time.js";
import { fromJson, toJson } from "../lib/json.js";

function hydrate(row) {
  if (!row) return null;
  return { ...row, data: fromJson(row.data, null) };
}

export default function createEnrichmentsRepository(db) {
  const statements = {
    upsertListing: db.prepare(
      `INSERT INTO listing_enrichments (listing_id, provider, status, data, error, fetched_at)
       VALUES (@listing_id, @provider, @status, @data, @error, @fetched_at)
       ON CONFLICT(listing_id, provider) DO UPDATE SET
         status = excluded.status,
         data = excluded.data,
         error = excluded.error,
         fetched_at = excluded.fetched_at`
    ),
    listByListing: db.prepare(
      "SELECT * FROM listing_enrichments WHERE listing_id = ?"
    ),
    oneByListing: db.prepare(
      "SELECT * FROM listing_enrichments WHERE listing_id = ? AND provider = ?"
    ),
    removeByListing: db.prepare(
      "DELETE FROM listing_enrichments WHERE listing_id = ? AND provider = ?"
    ),
    removeCommune: db.prepare(
      "DELETE FROM commune_data WHERE insee_code = ? AND provider = ?"
    ),
    clearCommuneProvider: db.prepare(
      "DELETE FROM commune_data WHERE provider = ?"
    ),

    getCommune: db.prepare(
      "SELECT * FROM commune_data WHERE insee_code = ? AND provider = ?"
    ),
    upsertCommune: db.prepare(
      `INSERT INTO commune_data (insee_code, provider, data, fetched_at)
       VALUES (@insee_code, @provider, @data, @fetched_at)
       ON CONFLICT(insee_code, provider) DO UPDATE SET
         data = excluded.data,
         fetched_at = excluded.fetched_at`
    ),
    getDepartment: db.prepare(
      "SELECT * FROM department_data WHERE dept_code = ? AND provider = ?"
    ),
    upsertDepartment: db.prepare(
      `INSERT INTO department_data (dept_code, provider, data, fetched_at)
       VALUES (@dept_code, @provider, @data, @fetched_at)
       ON CONFLICT(dept_code, provider) DO UPDATE SET
         data = excluded.data,
         fetched_at = excluded.fetched_at`
    ),
    removeDepartment: db.prepare(
      "DELETE FROM department_data WHERE dept_code = ? AND provider = ?"
    ),
    removeListingForInseeProvider: db.prepare(
      `DELETE FROM listing_enrichments
       WHERE provider = ?
         AND listing_id IN (SELECT id FROM listings WHERE insee_code = ?)`
    ),
  };

  function countCommuneBrowse({ provider = null, q = null } = {}) {
    const { where, params } = communeBrowseWhere({ provider, q });
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM commune_data WHERE ${where}`)
      .get(params);
    return row?.n ?? 0;
  }

  function communeBrowseWhere({ provider, q }) {
    const parts = ["1 = 1"];
    const params = {};
    if (provider) {
      parts.push("provider = @provider");
      params.provider = provider;
    }
    if (q) {
      parts.push("insee_code LIKE @q");
      params.q = `${q}%`;
    }
    return { where: parts.join(" AND "), params };
  }

  function countDepartmentBrowse({ provider = null, q = null } = {}) {
    const { where, params } = departmentBrowseWhere({ provider, q });
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM department_data WHERE ${where}`)
      .get(params);
    return row?.n ?? 0;
  }

  function departmentBrowseWhere({ provider, q }) {
    const parts = ["1 = 1"];
    const params = {};
    if (provider) {
      parts.push("provider = @provider");
      params.provider = provider;
    }
    if (q) {
      parts.push("dept_code LIKE @q");
      params.q = `${q}%`;
    }
    return { where: parts.join(" AND "), params };
  }

  function countListingBrowse({ provider = null, q = null, providers = null } = {}) {
    const { where, params } = listingBrowseWhere({ provider, q, providers });
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM listing_enrichments le
         JOIN listings l ON l.id = le.listing_id
         JOIN users u ON u.id = l.user_id
         WHERE ${where}`
      )
      .get(params);
    return row?.n ?? 0;
  }

  function listingBrowseWhere({ provider, q, providers = null }) {
    const parts = ["1 = 1"];
    const params = {};
    if (provider) {
      parts.push("le.provider = @provider");
      params.provider = provider;
    } else if (Array.isArray(providers)) {
      // Restreint la vue « par annonce » aux providers réellement de portée
      // annonce (évite d'afficher les statuts d'erreur des providers communaux
      // ou départementaux, dont la donnée vit dans un autre cache).
      if (!providers.length) {
        parts.push("1 = 0");
      } else {
        const placeholders = providers.map((_, i) => `@provK${i}`);
        providers.forEach((key, i) => {
          params[`provK${i}`] = key;
        });
        parts.push(`le.provider IN (${placeholders.join(", ")})`);
      }
    }
    if (q) {
      parts.push(
        "(CAST(le.listing_id AS TEXT) = @qExact OR l.title LIKE @like OR u.email LIKE @like OR l.insee_code LIKE @inseeLike)"
      );
      params.qExact = q;
      params.like = `%${q}%`;
      params.inseeLike = `${q}%`;
    }
    return { where: parts.join(" AND "), params };
  }

  return {
    saveListingResult(listingId, provider, { status, data, error }) {
      statements.upsertListing.run({
        listing_id: listingId,
        provider,
        status,
        data: toJson(data),
        error: error ? String(error).slice(0, 2000) : null,
        fetched_at: nowIso(),
      });
    },

    findByListing(listingId) {
      const results = {};
      for (const row of statements.listByListing.all(listingId)) {
        results[row.provider] = hydrate(row);
      }
      return results;
    },

    findOne(listingId, provider) {
      return hydrate(statements.oneByListing.get(listingId, provider));
    },

    removeOne(listingId, provider) {
      statements.removeByListing.run(listingId, provider);
    },

    removeCommune(inseeCode, provider) {
      if (!inseeCode) return;
      statements.removeCommune.run(inseeCode, provider);
    },

    clearCommuneProvider(provider) {
      statements.clearCommuneProvider.run(provider);
    },

    findCommune(inseeCode, provider) {
      return hydrate(statements.getCommune.get(inseeCode, provider));
    },

    saveCommune(inseeCode, provider, data) {
      statements.upsertCommune.run({
        insee_code: inseeCode,
        provider,
        data: toJson(data),
        fetched_at: nowIso(),
      });
    },

    findDepartment(deptCode, provider) {
      if (!deptCode) return null;
      return hydrate(statements.getDepartment.get(deptCode, provider));
    },

    saveDepartment(deptCode, provider, data) {
      statements.upsertDepartment.run({
        dept_code: deptCode,
        provider,
        data: toJson(data),
        fetched_at: nowIso(),
      });
    },

    removeDepartment(deptCode, provider) {
      if (!deptCode) return;
      statements.removeDepartment.run(deptCode, provider);
    },

    cacheStats() {
      const commune = db.prepare("SELECT COUNT(*) AS n FROM commune_data").get()?.n ?? 0;
      const department =
        db.prepare("SELECT COUNT(*) AS n FROM department_data").get()?.n ?? 0;
      const listing =
        db.prepare("SELECT COUNT(*) AS n FROM listing_enrichments").get()?.n ?? 0;
      return { commune, department, listing };
    },

    /** Vide les trois tables de cache enrichissement (communal, départemental, annonce). */
    clearAllCaches() {
      const purge = db.transaction(() => {
        const commune = db.prepare("DELETE FROM commune_data").run().changes;
        const department = db.prepare("DELETE FROM department_data").run().changes;
        const listing = db.prepare("DELETE FROM listing_enrichments").run().changes;
        return { commune, department, listing };
      });
      return purge();
    },

    listCacheProviders() {
      const rows = db
        .prepare(
          `SELECT provider FROM commune_data
           UNION
           SELECT provider FROM department_data
           UNION
           SELECT provider FROM listing_enrichments
           ORDER BY provider`
        )
        .all();
      return rows.map((row) => row.provider);
    },

    listCommuneCache({ provider = null, q = null, limit = 25, offset = 0 } = {}) {
      const { where, params } = communeBrowseWhere({ provider, q });
      return db
        .prepare(
          `SELECT insee_code, provider, fetched_at,
                  length(data) AS data_bytes,
                  substr(data, 1, 160) AS data_preview
           FROM commune_data
           WHERE ${where}
           ORDER BY fetched_at DESC, insee_code, provider
           LIMIT @limit OFFSET @offset`
        )
        .all({ ...params, limit, offset });
    },

    listDepartmentCache({ provider = null, q = null, limit = 25, offset = 0 } = {}) {
      const { where, params } = departmentBrowseWhere({ provider, q });
      return db
        .prepare(
          `SELECT dept_code, provider, fetched_at,
                  length(data) AS data_bytes,
                  substr(data, 1, 160) AS data_preview
           FROM department_data
           WHERE ${where}
           ORDER BY fetched_at DESC, dept_code, provider
           LIMIT @limit OFFSET @offset`
        )
        .all({ ...params, limit, offset });
    },

    listListingCache({
      provider = null,
      q = null,
      providers = null,
      limit = 25,
      offset = 0,
    } = {}) {
      const { where, params } = listingBrowseWhere({ provider, q, providers });
      return db
        .prepare(
          `SELECT le.listing_id, le.provider, le.status, le.error, le.fetched_at,
                  length(le.data) AS data_bytes,
                  substr(le.data, 1, 160) AS data_preview,
                  l.title, l.insee_code, u.email AS user_email
           FROM listing_enrichments le
           JOIN listings l ON l.id = le.listing_id
           JOIN users u ON u.id = l.user_id
           WHERE ${where}
           ORDER BY le.fetched_at DESC, le.listing_id, le.provider
           LIMIT @limit OFFSET @offset`
        )
        .all({ ...params, limit, offset });
    },

    countCommuneBrowse,
    countDepartmentBrowse,
    countListingBrowse,

    /** Supprime une entrée communal + les statuts d'annonces liés (même INSEE). */
    revokeCommune(inseeCode, provider) {
      if (!inseeCode || !provider) return { commune: 0, listings: 0 };
      const revoke = db.transaction(() => {
        const listings = statements.removeListingForInseeProvider.run(
          provider,
          inseeCode
        ).changes;
        const commune = statements.removeCommune.run(inseeCode, provider).changes;
        return { commune, listings };
      });
      return revoke();
    },

    /** Supprime une entrée départementale (cache partagé par code département). */
    revokeDepartment(deptCode, provider) {
      if (!deptCode || !provider) return { department: 0 };
      const department = statements.removeDepartment.run(deptCode, provider).changes;
      return { department };
    },

    revokeListing(listingId, provider) {
      if (!listingId || !provider) return 0;
      return statements.removeByListing.run(listingId, provider).changes;
    },

    adminCommunePayload(inseeCode, provider) {
      const row = statements.getCommune.get(inseeCode, provider);
      if (!row) return null;
      return {
        scope: "commune",
        insee_code: row.insee_code,
        provider: row.provider,
        fetched_at: row.fetched_at,
        data: fromJson(row.data, null),
      };
    },

    adminDepartmentPayload(deptCode, provider) {
      const row = statements.getDepartment.get(deptCode, provider);
      if (!row) return null;
      return {
        scope: "department",
        dept_code: row.dept_code,
        provider: row.provider,
        fetched_at: row.fetched_at,
        data: fromJson(row.data, null),
      };
    },

    adminListingPayload(listingId, provider) {
      const row = hydrate(statements.oneByListing.get(listingId, provider));
      if (!row) return null;
      return {
        scope: "listing",
        listing_id: row.listing_id,
        provider: row.provider,
        status: row.status,
        error: row.error,
        fetched_at: row.fetched_at,
        data: row.data,
      };
    },
  };
}
