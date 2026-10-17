/**
 * Plan de travaux d'une annonce : proposition de l'IA tant que l'utilisateur
 * n'a rien modifié, puis version enregistrée (réconciliée avec la galerie).
 */

import HttpError from "../lib/http-error.js";
import {
  parseWorksPlan,
  reconcileWorksPlan,
  seedWorksPlan,
  worksRoomsSummary,
} from "../lib/works/works-plan.js";

export default function createWorksPlanService({ repositories, photoAnalysisRun }) {
  function context(listing) {
    const photos = repositories.listings.listPhotos(listing.id);
    const analysis = photoAnalysisRun.readStored(listing);
    return {
      photos,
      analysis,
      aiAnalyzedAt: analysis?.analyzed_at || analysis?.cached_at || null,
    };
  }

  /**
   * @returns {{ plan, stored: boolean, aiStatus: string, aiAnalyzedAt, photos: string[], updatedAt }}
   */
  function getPlan(listing) {
    const { photos, analysis, aiAnalyzedAt } = context(listing);
    const row = repositories.worksPlans.find(listing.id);
    const aiStatus = analysis?.ready ? analysis.status : "pending";
    if (row?.data) {
      return {
        plan: reconcileWorksPlan(row.data, photos),
        stored: true,
        aiStatus,
        aiAnalyzedAt,
        // Le plan enregistré part d'une analyse plus ancienne que celle en cache.
        aiNewer: Boolean(aiAnalyzedAt && row.ai_analyzed_at && aiAnalyzedAt !== row.ai_analyzed_at),
        analysis,
        photos,
        updatedAt: row.updated_at,
      };
    }
    return {
      plan: seedWorksPlan(analysis, photos, { listing }),
      stored: false,
      aiStatus,
      aiAnalyzedAt,
      aiNewer: false,
      analysis,
      photos,
      updatedAt: null,
    };
  }

  function save(listing, payload) {
    const parsed = parseWorksPlan(payload);
    if (!parsed.ok) throw HttpError.badRequest(parsed.error);
    const { photos, aiAnalyzedAt } = context(listing);
    const plan = reconcileWorksPlan(parsed.plan, photos);
    // On garde la référence à l'analyse dont le plan est issu, pas la dernière en cache.
    const basedOn = repositories.worksPlans.find(listing.id)?.ai_analyzed_at || aiAnalyzedAt;
    repositories.worksPlans.upsert(listing.id, plan, { aiAnalyzedAt: basedOn });
    return getPlan(listing);
  }

  function reset(listing) {
    repositories.worksPlans.remove(listing.id);
    return getPlan(listing);
  }

  function summary(listing) {
    return worksRoomsSummary(getPlan(listing));
  }

  return { getPlan, save, reset, summary };
}
