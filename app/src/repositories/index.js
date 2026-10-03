/**
 * Construit l'ensemble des repositories à partir d'une connexion.
 *
 * C'est le seul point à adapter pour passer un jour à MySQL/Postgres : les
 * routes et les services ne connaissent que ces objets.
 */

import createUsersRepository from "./users.repo.js";
import createExtensionRepository from "./extension.repo.js";
import createListingsRepository from "./listings.repo.js";
import createProjectsRepository from "./projects.repo.js";
import createAddressesRepository from "./addresses.repo.js";
import createEnrichmentsRepository from "./enrichments.repo.js";

export default function createRepositories(db) {
  const projects = createProjectsRepository(db);

  return {
    users: createUsersRepository(db),
    extension: createExtensionRepository(db),
    projects,
    addresses: createAddressesRepository(db),
    listings: createListingsRepository(db, { projects }),
    enrichments: createEnrichmentsRepository(db),

    /** Exécute plusieurs écritures de façon atomique. */
    transaction(fn) {
      return db.transaction(fn)();
    },
  };
}
