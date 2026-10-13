/**
 * Modèle d'affichage du panneau « État visible du bien » : tri, limitation
 * et jonction image ↔ position dans la galerie. Aucune logique métier ici.
 */

import { qualityLevelFromScore } from "./coverage.js";
import { filterPotentialWorks } from "./works.js";
import { usableForNegotiation } from "./traceability.js";

/** Libellé de fiabilité toujours dérivé du score (seuils à jour, y compris cache ancien). */
function analysisQualityForDisplay(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (raw.score == null || raw.score === "") return raw;
  return { ...raw, confidence: qualityLevelFromScore(raw.score) };
}

const NECESSITY_RANK = { very_likely: 4, likely: 3, possible: 2, optional: 1, unlikely: 0 };
const SEVERITY_RANK = { high: 2, medium: 1, low: 0 };
const CATEGORY_RANK = { necessary: 2, cosmetic: 1, comfort: 0 };

/**
 * @param {object} stored - sortie de `readStored`
 * @param {string[]} photos - URLs de la galerie (ordre d'affichage)
 * @param {object|null} dpeInsights - `buildDpeInsights` du DPE lié
 */
export function photoAnalysisViewModel(stored, photos = [], dpeInsights = null) {
  const base = {
    ready: Boolean(stored?.ready),
    status: stored?.status || "pending",
    warnings: stored?.warnings || [],
  };
  if (!stored?.ready || stored.status !== "ok") return base;

  const a = stored;
  const urlIndex = new Map(photos.map((url, i) => [url, i]));
  const imageById = new Map();
  for (const image of a.images || []) {
    const index = urlIndex.has(image.url) ? urlIndex.get(image.url) : image.order - 1;
    imageById.set(image.id, { ...image, index, url: image.url });
  }
  const refs = (ids) =>
    (ids || [])
      .map((id) => imageById.get(id))
      .filter(Boolean)
      .map((img) => ({ id: img.id, index: img.index, url: img.url, position: img.index + 1 }));

  const works = filterPotentialWorks([...(a.potential_works || [])])
    .filter((w) => w.necessity !== "unlikely")
    .sort(
      (x, y) =>
        (CATEGORY_RANK[y.category] ?? 0) - (CATEGORY_RANK[x.category] ?? 0) ||
        (NECESSITY_RANK[y.necessity] ?? 0) - (NECESSITY_RANK[x.necessity] ?? 0) ||
        (y.confidence ?? 0) - (x.confidence ?? 0)
    )
    .map((w) => ({ ...w, refs: refs(w.image_ids) }));

  const anomalies = [...(a.anomalies || [])]
    .sort(
      (x, y) =>
        (SEVERITY_RANK[y.severity] ?? 0) - (SEVERITY_RANK[x.severity] ?? 0) ||
        (y.confidence ?? 0) - (x.confidence ?? 0)
    )
    .map((an) => ({ ...an, refs: refs(an.image_ids) }));

  const rooms = (a.rooms || []).map((room) => ({ ...room, refs: refs(room.image_ids) }));
  const roomById = new Map(rooms.map((r) => [r.room_id, r]));

  const excluded = (a.excluded_images || [])
    .map((x) => ({ ...x, ref: refs([x.image_id])[0] || null }))
    .filter((x) => x.ref && x.reason !== "exterior");

  const exteriorImages = (a.images || []).filter(
    (img) => img.exclusion_reason === "exterior"
  );

  const galleryBadges = {};
  for (const image of a.images || []) {
    const ref = imageById.get(image.id);
    if (!ref) continue;
    galleryBadges[ref.index] = image.classification;
  }

  return {
    ...base,
    analysis: a,
    summary: a.summary,
    condition: a.overall_condition || {},
    renovation: a.renovation || {},
    quality: analysisQualityForDisplay(a.analysis_quality),
    coverage: a.photo_coverage || {},
    photoCount: a.photo_count,
    usablePhotoCount: a.usable_photo_count,
    virtualImageCount: a.virtual_image_count || 0,
    works,
    topWorks: works.slice(0, 6),
    anomalies,
    strengths: [...(a.strengths || [])]
      .sort((x, y) => (y.confidence ?? 0) - (x.confidence ?? 0))
      .map((s) => ({ ...s, refs: refs(s.image_ids) })),
    warnings: [...(a.warnings || [])]
      .sort(
        (x, y) =>
          (SEVERITY_RANK[y.severity] ?? 0) - (SEVERITY_RANK[x.severity] ?? 0) ||
          (y.confidence ?? 0) - (x.confidence ?? 0)
      )
      .map((w) => ({ ...w, refs: refs(w.image_ids) })),
    contradictions: (a.description_contradictions || []).map((c) => ({
      ...c,
      refs: refs(c.image_ids),
    })),
    structuredDataNotes: a.structured_data_notes || [],
    wideAngle: { ...(a.wide_angle || { likely: false, image_ids: [] }), refs: refs(a.wide_angle?.image_ids) },
    photoInconsistency: a.possible_photo_inconsistency || { status: false },
    missingRooms: a.missing_visual_coverage || [],
    distributionWarning: a.photo_distribution_warning || { status: false },
    distribution: a.photo_distribution || {},
    visitQuestions: (a.visit_questions || []).slice(0, 8),
    visitChecks: a.visit_checks || [],
    negotiationPoints: (a.negotiation_points || []).filter(usableForNegotiation),
    rooms,
    roomById,
    unassignedUsable: refs(a.unassigned_usable_image_ids),
    exterior: a.exterior || null,
    exteriorImages: exteriorImages.map((img) => ({ ...img, refs: refs([img.id]) })),
    excluded,
    relationships: (a.image_relationships || [])
      .filter((r) => r.relationship === "current_vs_projected")
      .map((r) => ({
        ...r,
        current: refs([r.current_image])[0] || null,
        projected: refs([r.projected_image])[0] || null,
      }))
      .filter((r) => r.current && r.projected),
    galleryBadges,
    architecturalCharacter: a.architectural_character,
    renovationPotential: a.renovation_potential,
    analyzedAt: a.analyzed_at || stored.cached_at || null,
    model: a.model || null,
  };
}
