/**
 * Montant travaux proposé par défaut dans le tableau de financement :
 * milieu de la fourchette du plan des pièces (même moteur que le budget travaux).
 */

import { buildDpeInsights } from "../dpe-insights.js";
import { reconcileWorksPlan, seedWorksPlan } from "./works-plan.js";
import { buildWorksOverview } from "./works-overview.js";
import { buildWorksSummary, midpointWorksBudget } from "./works-summary.js";

function linkedDpeInsights(listing, repositories) {
  const numero = listing?.linked_dpe_numero;
  if (!numero) return null;
  const record = repositories.dpe.findByNumero(numero);
  return record ? buildDpeInsights(record) : null;
}

/**
 * @param {object} input
 * @param {object} input.listing
 * @param {object} input.repositories
 * @param {object} input.analysis - sortie `photoAnalysisRun.readStored`
 * @param {object|null} [input.dpeInsights] - si omis, DPE lié à l'annonce
 */
export function financingWorksDefault({ listing, repositories, analysis, dpeInsights }) {
  const photos = repositories.listings.listPhotos(listing.id);
  const row = repositories.worksPlans.find(listing.id);
  const plan = row?.data
    ? reconcileWorksPlan(row.data, photos)
    : seedWorksPlan(analysis, photos);
  const resolvedDpe =
    dpeInsights === undefined ? linkedDpeInsights(listing, repositories) : dpeInsights;
  const overview = buildWorksOverview(listing, analysis, resolvedDpe, photos);
  const aiStatus = analysis?.ready ? analysis.status : "pending";
  const summary = buildWorksSummary({
    plan,
    overview,
    propertyType: overview.propertyType || "",
    aiStatus,
    aiNewer: false,
  });
  return midpointWorksBudget(summary.min, summary.max);
}
