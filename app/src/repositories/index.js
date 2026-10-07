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
import createDpeRepository from "./dpe.repo.js";
import createAppSettingsRepository from "./app-settings.repo.js";
import createSsmsiRepository from "./ssmsi.repo.js";
import createDvfRepository from "./dvf.repo.js";
import createPostalInseeRepository from "./postal-insee.repo.js";

export default function createRepositories(db) {
  const projects = createProjectsRepository(db);

  return {
    users: createUsersRepository(db),
    extension: createExtensionRepository(db),
    projects,
    addresses: createAddressesRepository(db),
    listings: createListingsRepository(db, { projects }),
    enrichments: createEnrichmentsRepository(db),
    dpe: createDpeRepository(db),
    appSettings: createAppSettingsRepository(db),
    ssmsi: createSsmsiRepository(db),
    dvf: createDvfRepository(db),
    postalInsee: createPostalInseeRepository(db),

    /** Exécute plusieurs écritures de façon atomique. */
    transaction(fn) {
      return db.transaction(fn)();
    },
  };
}
