/**
 * Projets de recherche.
 *
 * Invariant central : une annonce appartient toujours à au moins un projet.
 * Si aucun projet n'est précisé — ou si l'utilisateur les décoche tous — elle
 * retombe dans le projet par défaut du compte.
 */

export const MAX_NAME_LENGTH = 60;
export const DEFAULT_PROJECT_NAME = "Recherche principale";

/** Adresses de référence : garde-fous de saisie. */
export const MAX_ADDRESSES = 8;
export const MAX_ADDRESS_LENGTH = 200;
export const MAX_LABEL_LENGTH = 40;

/**
 * Palette fermée : la couleur est écrite telle quelle dans un attribut
 * `style`, elle ne doit donc jamais venir d'une saisie libre.
 */
export const PALETTE = [
  "#0b3d2c",
  "#2e8b6b",
  "#e0541f",
  "#3b5bdb",
  "#9c36b5",
  "#b38600",
  "#0c8599",
  "#c2255c",
];

export function slugify(value) {
  const slug = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LENGTH);
  return slug || "projet";
}

export function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
}

export default function createProjectsService({ repositories }) {
  /** Slug libre pour ce compte : « maison-de-campagne », puis « -2 », « -3 »… */
  function uniqueSlug(userId, name, excludeId = null) {
    const base = slugify(name);
    let candidate = base;
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const existing = repositories.projects.findBySlug(userId, candidate);
      if (!existing || existing.id === excludeId) return candidate;
      candidate = `${base}-${suffix}`;
    }
    return `${base}-${Date.now()}`;
  }

  function nextColor(userId) {
    const used = new Set(
      repositories.projects.listByUser(userId).map((project) => project.color)
    );
    return PALETTE.find((color) => !used.has(color)) || PALETTE[0];
  }

  /**
   * Projet par défaut du compte, créé à la volée si besoin : un compte sans
   * projet ne doit jamais pouvoir exister.
   */
  function ensureDefault(userId) {
    const existing = repositories.projects.findDefault(userId);
    if (existing) return existing;
    return repositories.projects.create({
      userId,
      name: DEFAULT_PROJECT_NAME,
      slug: uniqueSlug(userId, DEFAULT_PROJECT_NAME),
      color: PALETTE[0],
      isDefault: true,
    });
  }

  function create(userId, rawName) {
    const name = cleanName(rawName);
    if (!name) return { project: null, error: "Donnez un nom au projet." };

    const duplicate = repositories.projects.findByName(userId, name);
    if (duplicate) {
      return { project: null, error: `Le projet « ${name} » existe déjà.` };
    }

    const project = repositories.projects.create({
      userId,
      name,
      slug: uniqueSlug(userId, name),
      color: nextColor(userId),
      isDefault: !repositories.projects.findDefault(userId),
    });
    return { project, error: null };
  }

  function rename(userId, id, rawName) {
    const project = repositories.projects.findById(userId, id);
    if (!project) return { project: null, error: "Projet introuvable." };

    const name = cleanName(rawName);
    if (!name) return { project: null, error: "Donnez un nom au projet." };

    const duplicate = repositories.projects.findByName(userId, name);
    if (duplicate && duplicate.id !== project.id) {
      return { project: null, error: `Le projet « ${name} » existe déjà.` };
    }

    repositories.projects.rename(userId, id, name, uniqueSlug(userId, name, id));
    return { project: repositories.projects.findById(userId, id), error: null };
  }

  /**
   * Supprime un projet sans supprimer les annonces : celles qui n'étaient que
   * là retombent dans le projet par défaut.
   */
  function remove(userId, id) {
    const project = repositories.projects.findById(userId, id);
    if (!project) return { removed: false, error: "Projet introuvable." };
    if (project.is_default) {
      return {
        removed: false,
        error: "Le projet par défaut ne peut pas être supprimé.",
      };
    }

    return repositories.transaction(() => {
      repositories.projects.remove(userId, id);
      const fallback = ensureDefault(userId);
      const orphans = repositories.projects.orphanListingIds(userId);
      for (const listingId of orphans) {
        repositories.projects.addListing(listingId, [fallback.id]);
      }
      return { removed: true, error: null, reassigned: orphans.length };
    });
  }

  function setDefault(userId, id) {
    const project = repositories.projects.findById(userId, id);
    if (!project) return { project: null, error: "Projet introuvable." };
    repositories.projects.setDefault(userId, id);
    return { project: repositories.projects.findById(userId, id), error: null };
  }

  /**
   * Fige l'ordre d'affichage des projets. Les identifiants reçus sont filtrés
   * sur ceux du compte (sécurité), dédoublonnés, et tout projet omis est
   * replacé à la fin pour qu'aucun ne disparaisse de l'ordre.
   */
  function reorder(userId, references) {
    const owned = repositories.projects.listByUser(userId);
    const validIds = new Set(owned.map((project) => project.id));

    const requested = (Array.isArray(references) ? references : [references])
      .map((value) => Number(value))
      .filter((id) => validIds.has(id));

    const seen = new Set();
    const ordered = [];
    for (const id of requested) {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    // Projets non mentionnés : conservés, rangés à la fin dans leur ordre actuel.
    for (const project of owned) {
      if (!seen.has(project.id)) ordered.push(project.id);
    }

    repositories.projects.reorder(userId, ordered);
    return { order: ordered, error: null };
  }

  /**
   * Résout des références hétérogènes en projets du compte : identifiant
   * numérique, slug ou nom. Une référence inconnue est ignorée, comme tout
   * champ facultatif invalide du payload.
   */
  function resolve(userId, references) {
    const list = Array.isArray(references) ? references : [references];
    const found = new Map();

    for (const reference of list) {
      if (reference === null || reference === undefined || reference === "") continue;

      let project = null;
      if (typeof reference === "number" || /^\d+$/.test(String(reference).trim())) {
        project = repositories.projects.findById(userId, Number(reference));
      }
      if (!project) {
        const text = String(reference).trim();
        project =
          repositories.projects.findBySlug(userId, slugify(text)) ||
          repositories.projects.findByName(userId, text);
      }
      if (project) found.set(project.id, project);
    }

    return [...found.values()];
  }

  /** Remplace les projets d'une annonce, avec repli sur le projet par défaut. */
  function setForListing(userId, listingId, references) {
    const resolved = resolve(userId, references);
    const target = resolved.length ? resolved : [ensureDefault(userId)];
    repositories.projects.setListingProjects(
      listingId,
      target.map((project) => project.id)
    );
    return target;
  }

  /**
   * Ajoute sans retirer. Utilisé à la réception d'une annonce : une nouvelle
   * capture ne doit jamais défaire un classement fait à la main.
   */
  function addToListing(userId, listingId, references) {
    const resolved = resolve(userId, references);
    if (resolved.length) {
      repositories.projects.addListing(
        listingId,
        resolved.map((project) => project.id)
      );
    }
    const current = repositories.projects.listForListing(listingId);
    if (current.length) return current;

    // Annonce sans aucun projet : elle rejoint le projet par défaut.
    const fallback = ensureDefault(userId);
    repositories.projects.addListing(listingId, [fallback.id]);
    return [fallback];
  }

  /* --------------------- Adresses de référence --------------------- */

  function cleanAddress(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, MAX_ADDRESS_LENGTH);
  }

  function cleanLabel(value) {
    const label = String(value || "").trim().replace(/\s+/g, " ").slice(0, MAX_LABEL_LENGTH);
    return label || null;
  }

  function listAddresses(userId, projectId) {
    const project = repositories.projects.findById(userId, projectId);
    if (!project) return [];
    return repositories.projects.listAddresses(project.id);
  }

  /**
   * Ajoute une adresse de référence au projet. L'adresse rejoint le carnet du
   * compte si elle n'y est pas déjà (déduplication par adresse, casse ignorée),
   * puis est reliée au projet. Les coordonnées fournies (géocodage côté serveur)
   * complètent une entrée de carnet encore non localisée ; `null` est accepté.
   */
  function addAddress(userId, projectId, { label, address, lat = null, lng = null }) {
    const project = repositories.projects.findById(userId, projectId);
    if (!project) return { address: null, error: "Projet introuvable." };

    const cleaned = cleanAddress(address);
    if (!cleaned) return { address: null, error: "Saisissez une adresse." };

    // Upsert dans le carnet : réutilise l'entrée existante, sinon la crée.
    let entry = repositories.addresses.findByAddress(userId, cleaned);
    if (!entry) {
      entry = repositories.addresses.insert({
        userId,
        label: cleanLabel(label),
        address: cleaned,
        lat,
        lng,
      });
    } else if (entry.lat == null && lat != null && lng != null) {
      // Complète les coordonnées manquantes avec un géocodage frais.
      entry = repositories.addresses.update({
        id: entry.id,
        userId,
        label: entry.label,
        address: entry.address,
        lat,
        lng,
      });
    }

    // Déjà reliée : rien à faire, l'ajout est idempotent.
    if (repositories.projects.isAddressLinked(project.id, entry.id)) {
      return { address: entry, error: null };
    }

    if (repositories.projects.countAddresses(project.id) >= MAX_ADDRESSES) {
      return {
        address: null,
        error: `Un projet est limité à ${MAX_ADDRESSES} adresses de référence.`,
      };
    }

    repositories.projects.linkAddress(project.id, entry.id);
    return { address: entry, error: null };
  }

  /**
   * Adresses du carnet proposées à l'autocomplétion d'un projet : tout le
   * carnet, moins les adresses déjà reliées au projet courant.
   */
  function listAddressSuggestions(userId, excludeProjectId = null) {
    const linked = new Set(
      excludeProjectId
        ? repositories.projects.listAddresses(excludeProjectId).map((a) => a.id)
        : []
    );
    return repositories.addresses
      .listByUser(userId)
      .filter((row) => !linked.has(row.id))
      .map((row) => ({
        label: cleanLabel(row.label),
        address: cleanAddress(row.address),
      }));
  }

  /**
   * Coordonnées déjà géocodées d'une adresse identique du carnet (comparaison
   * serveur, insensible à la casse/espaces). Permet de réutiliser un géocodage
   * existant sans jamais faire confiance à des coordonnées envoyées par le
   * client. Renvoie `null` si aucune correspondance localisée.
   */
  function findUserAddressCoords(userId, addressText) {
    const cleaned = cleanAddress(addressText);
    if (!cleaned) return null;
    const entry = repositories.addresses.findByAddress(userId, cleaned);
    return entry && entry.lat != null && entry.lng != null
      ? { lat: entry.lat, lng: entry.lng }
      : null;
  }

  /**
   * Retire une adresse d'un projet (détache la liaison). L'adresse reste dans
   * le carnet et dans les autres projets qui l'utilisent.
   */
  function unlinkAddress(userId, projectId, addressId) {
    const project = repositories.projects.findById(userId, projectId);
    if (!project) return { removed: false, error: "Projet introuvable." };
    const removed = repositories.projects.unlinkAddress(project.id, addressId);
    if (!removed) return { removed: false, error: "Adresse introuvable." };
    return { removed: true, error: null };
  }

  function addressToApi(address) {
    return {
      id: address.id,
      label: address.label || null,
      address: address.address,
      lat: address.lat ?? null,
      lng: address.lng ?? null,
    };
  }

  /** Projection minimale renvoyée par l'API, adresses de référence incluses. */
  function toApi(project) {
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      is_default: Boolean(project.is_default),
      addresses: repositories.projects.listAddresses(project.id).map(addressToApi),
      ...(project.listing_count === undefined
        ? {}
        : { listing_count: project.listing_count }),
    };
  }

  return {
    ensureDefault,
    create,
    rename,
    remove,
    setDefault,
    reorder,
    resolve,
    setForListing,
    addToListing,
    toApi,
    addressToApi,
    listAddresses,
    listAddressSuggestions,
    findUserAddressCoords,
    addAddress,
    unlinkAddress,
    list: (userId) => repositories.projects.listByUser(userId),
  };
}
