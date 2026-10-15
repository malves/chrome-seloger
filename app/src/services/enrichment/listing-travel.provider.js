/**
 * Trajets voiture depuis l'adresse réelle du bien vers les adresses de
 * référence du projet. Lancé uniquement quand l'adresse du bien change (ou
 * quand les adresses de référence changent) ; le résultat reste dans
 * `listing_enrichments` et ne touche jamais aux données de l'extension.
 */

import ProviderSkipped from "./skipped.js";
import createTravelService from "../travel.service.js";
import createProjectsService from "../projects.service.js";
import {
  resolveTravelProject,
  resolveTravelOrigin,
  destinationsFromProject,
  listingTravelInputFingerprint,
  toExtensionTravelTimes,
} from "../../lib/listing-travel.js";

export default {
  key: "listing-travel",
  scope: "listing",
  order: 35,
  ttlDays: 30,
  label: "Trajets depuis l'adresse du bien",
  display: false,
  standalone: true,

  async fetch({ listing, repositories, logger }) {
    const origin = resolveTravelOrigin(listing);
    if (!origin) {
      throw new ProviderSkipped(
        "Pas d'adresse réelle géocodée : les trajets de l'extension sont conservés."
      );
    }

    const travel = createTravelService({ logger });
    if (!travel.configured()) {
      throw new ProviderSkipped(
        "Calcul d'itinéraire indisponible (clé OpenRouteService absente)."
      );
    }

    const projects = createProjectsService({ repositories });
    const project = resolveTravelProject(listing, projects, listing.user_id);
    const destinations = project?.id ? destinationsFromProject(repositories, project.id) : [];
    if (!destinations.length) {
      throw new ProviderSkipped("Aucune adresse de référence dans le projet.");
    }

    const { results } = await travel.compute({ origin, destinations });
    const travelTimes = toExtensionTravelTimes(results);
    if (!travelTimes.length) {
      throw new Error("Aucun trajet n'a pu être calculé depuis l'adresse du bien.");
    }

    return {
      inputFingerprint: listingTravelInputFingerprint(listing, project.id, destinations),
      project_id: project.id,
      travel_times: travelTimes,
      computed_at: new Date().toISOString(),
    };
  },
};
