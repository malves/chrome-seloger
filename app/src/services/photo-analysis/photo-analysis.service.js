/**
 * Orchestration de l'analyse des photos d'une annonce :
 *
 *   téléchargement → passe A (par image) → passe B (synthèse)
 *   → post-traitements déterministes (couverture, pièces manquantes,
 *     traçabilité, qualité) → résultat structuré.
 *
 * Le modèle identifie et décrit ; tout ce qui est comptable (distribution,
 * couverture, qualité, filtrage des preuves) est calculé ici, en JS.
 */

import config from "../../config.js";
import createImageFetcher from "./image-fetcher.service.js";
import createVisionClient from "./vision-client.js";
import createImagePassService from "./image-pass.service.js";
import createSynthesisPassService from "./synthesis-pass.service.js";
import {
  analysisQuality,
  missingVisualCoverage,
  photoCoverage,
  photoDistribution,
  photoDistributionWarning,
} from "../../lib/photo-analysis/coverage.js";
import {
  imageIndex,
  filterImageIds,
  traceFinding,
  usableForNegotiation,
} from "../../lib/photo-analysis/traceability.js";
import { VIRTUAL_CLASSIFICATIONS } from "../../lib/photo-analysis/enums.js";
import { scopeClaims } from "../../lib/photo-analysis/claims.js";
import { applyConditionFloors } from "../../lib/photo-analysis/condition-floor.js";
import {
  splitCommonAreaWorks,
  usableForWorks,
  worksForUnassignedPhotos,
} from "../../lib/photo-analysis/works.js";

/** Les pièces logiques ne doivent référencer que des images réelles connues. */
function traceRooms(rooms, index, records) {
  const assigned = new Set();
  const traced = [];
  for (const room of rooms) {
    const ids = filterImageIds(room.image_ids, index, { usableOnly: false }).filter(
      (id) => !VIRTUAL_CLASSIFICATIONS.has(records.get(id)?.classification)
    );
    if (!ids.length) continue;
    for (const id of ids) assigned.add(id);
    traced.push({ ...room, image_ids: ids });
  }
  return { rooms: traced, assigned };
}

/** Synthèse de l'état visible des équipements, utile aux moteurs aval (DPE, travaux). */
function visibleEquipmentSummary(rooms) {
  const windows = rooms.map((r) => r.windows).filter(Boolean);
  const heating = rooms.map((r) => r.heating).filter(Boolean);
  return {
    windows_apparent_ages: windows.map((w) => w.apparent_age),
    windows_replacement_may_be_relevant: windows.some((w) => w.replacement_may_be_relevant),
    heating_equipments: [...new Set(heating.map((h) => h.equipment))],
    heating_modernization_may_be_relevant: heating.some((h) => h.modernization_may_be_relevant),
  };
}

export default function createPhotoAnalysisService({
  logger,
  chatCompletion,
  fetchImage,
  vision = config.vision,
} = {}) {
  const client = createVisionClient({ logger, chatCompletion, vision });
  const fetcher = createImageFetcher({ logger, fetchImage, vision });
  const imagePass = createImagePassService({ client, logger, vision });
  const synthesisPass = createSynthesisPassService({ client, logger, vision });

  function configured() {
    return client.configured();
  }

  /**
   * @param {object} listing
   * @param {string[]} photoUrls
   * @returns {Promise<object>} `{ status: "ok"|"unavailable"|"insufficient", ... }`
   */
  async function analyze(listing, photoUrls) {
    const urls = (photoUrls || []).filter(Boolean);
    if (!configured()) {
      return { status: "unavailable", warnings: ["Analyse des photos non configurée."] };
    }
    if (!urls.length) {
      return { status: "insufficient", warnings: ["Aucune photo à analyser."] };
    }

    const images = await fetcher.fetchAll(urls);
    const downloaded = images.filter((img) => img.dataUrl || img.duplicate_of);
    if (!downloaded.length) {
      return {
        status: "unavailable",
        warnings: ["Aucune photo n'a pu être téléchargée pour l'analyse."],
      };
    }

    const { records, failures, batches, debug: imagePassDebug } = await imagePass.run(images, {
      propertyType: listing?.property_type || null,
    });
    const usable = records.filter((r) => usableForWorks(r, listing?.property_type));

    let synthesis = null;
    let synthesisError = null;
    if (usable.length) {
      try {
        synthesis = await synthesisPass.run(listing, records, images);
      } catch (err) {
        synthesisError = String(err.message || err);
        logger?.warn?.({ err: err.message, listingId: listing?.id }, "synthèse photos en échec");
      }
    }

    if (!synthesis) {
      if (failures === batches) {
        return {
          status: "unavailable",
          warnings: ["Le service d'analyse d'images n'a pas répondu."],
          analysis_debug: {
            analyzed_at: new Date().toISOString(),
            model: vision.model,
            image_pass: imagePassDebug,
            synthesis_error: synthesisError,
          },
        };
      }
      synthesis = emptySynthesis();
    }

    return assemble(listing, records, synthesis, {
      failures,
      batches,
      imagePassDebug,
      synthesisError,
    });
  }

  function emptySynthesis() {
    return {
      rooms: [],
      exterior: { facade: null, common_areas: null, outdoor_spaces: [], to_check_in_documents: [] },
      image_relationships: [],
      anomalies: [],
      potential_works: [],
      strengths: [],
      warnings: [],
      description_contradictions: [],
      structured_data_notes: [],
      renovation: { level: "unknown", confidence: 0, cosmetic_only_suspected: false, note: null },
      condition_score: null,
      condition_label: "unknown",
      condition_confidence: 0,
      wide_angle_likely: false,
      possible_photo_inconsistency: { status: false, confidence: 0, note: null },
      architectural_character: null,
      renovation_potential: null,
      summary: "",
      visit_questions: [],
      visit_checks: [],
      negotiation_points: [],
    };
  }

  /** Assemble le résultat final à partir des fiches et de la synthèse. */
  function assemble(
    listing,
    records,
    synthesis,
    { failures = 0, batches = 1, imagePassDebug = null, synthesisError = null } = {}
  ) {
    const byId = new Map(records.map((r) => [r.id, r]));
    const known = imageIndex(records).known;

    const relationships = synthesis.image_relationships
      .map((rel) => ({
        ...rel,
        image_ids: (rel.image_ids || []).filter((id) => known.has(id)),
        current_image: known.has(rel.current_image) ? rel.current_image : null,
        projected_image: known.has(rel.projected_image) ? rel.projected_image : null,
      }))
      .filter((rel) => rel.image_ids.length >= 2);

    // Couples « actuel / projection » : la projection ne décrit jamais l'état
    // actuel, même si la passe A l'avait prise pour une vraie photo.
    for (const rel of relationships) {
      if (rel.relationship !== "current_vs_projected" || !rel.projected_image) continue;
      const projected = byId.get(rel.projected_image);
      if (projected && !VIRTUAL_CLASSIFICATIONS.has(projected.classification)) {
        projected.classification = "architect_projection";
        projected.usable_for_condition_analysis = false;
        projected.exclusion_reason = "virtual_or_projection";
      }
    }

    const propertyType = listing?.property_type || null;
    // Une maison n'a pas de parties communes : hall, escalier, palier sont ceux du logement.
    const synthesisRooms =
      propertyType === "house"
        ? synthesis.rooms.map((r) => (r.room_type === "common_area" ? { ...r, room_type: "hallway" } : r))
        : synthesis.rooms;

    const index = imageIndex(records);
    const { rooms: tracedRooms, assigned } = traceRooms(synthesisRooms, index, byId);
    const roomIds = new Set(tracedRooms.map((r) => r.room_id));
    const roomRef = (id) => (id && roomIds.has(id) ? id : null);

    // Maison : façade et extérieurs sont des preuves valables de travaux à la charge de l'acheteur.
    const worksIndex = imageIndex(
      records.map((r) => ({ id: r.id, usable_for_condition_analysis: usableForWorks(r, propertyType) }))
    );

    const anomalies = synthesis.anomalies.map((a) => ({
      ...traceFinding(a, worksIndex),
      room_id: roomRef(a.room_id),
    }));
    const floors = applyConditionFloors({
      rooms: tracedRooms,
      recordsById: byId,
      anomalies,
      condition: {
        score: synthesis.condition_score,
        label: synthesis.condition_label,
        confidence: synthesis.condition_confidence,
      },
      renovation: synthesis.renovation,
    });
    const rooms = floors.rooms;
    const { works: privateWorks, commonAreaWorks } = splitCommonAreaWorks(
      synthesis.potential_works,
      records,
      synthesisRooms,
      propertyType
    );
    const fallbackWorks = worksForUnassignedPhotos(records, assigned, privateWorks, propertyType);
    const potentialWorks = [...privateWorks, ...fallbackWorks].map((w) => ({
      ...traceFinding(w, worksIndex),
      room_id: roomRef(w.room_id),
    }));
    const strengths = synthesis.strengths.map((s) => traceFinding(s, index));
    const warnings = synthesis.warnings.map((w) => traceFinding(w, index));
    const contradictions = scopeClaims(
      synthesis.description_contradictions.map((c) => ({
        ...c,
        image_ids: filterImageIds(c.image_ids, index, { usableOnly: false }),
      })),
      { records, description: listing?.description, propertyType }
    );
    const negotiation = synthesis.negotiation_points
      .map((n) => traceFinding(n, index))
      .filter(usableForNegotiation);

    const exterior = {
      ...synthesis.exterior,
      facade: synthesis.exterior.facade
        ? { ...synthesis.exterior.facade, image_ids: filterImageIds(synthesis.exterior.facade.image_ids, index, { usableOnly: false }) }
        : null,
      common_areas: synthesis.exterior.common_areas
        ? { ...synthesis.exterior.common_areas, image_ids: filterImageIds(synthesis.exterior.common_areas.image_ids, index, { usableOnly: false }) }
        : null,
      outdoor_spaces: synthesis.exterior.outdoor_spaces.map((s) => ({
        ...s,
        image_ids: filterImageIds(s.image_ids, index, { usableOnly: false }),
      })),
      to_check_in_documents: [
        ...new Set([
          ...synthesis.exterior.to_check_in_documents,
          ...commonAreaWorks.map(
            (w) => `${w.label || w.work_type} : travaux d'immeuble à vérifier auprès de la copropriété`
          ),
        ]),
      ],
    };

    const missing = missingVisualCoverage(listing, rooms, records);
    const coverage = photoCoverage(listing, rooms, records);
    const distribution = photoDistribution(records);
    const distributionWarning = photoDistributionWarning(records, missing);
    const quality = analysisQuality({ records, coverage, failures, totalBatches: batches });

    const virtualImages = records.filter(
      (r) => VIRTUAL_CLASSIFICATIONS.has(r.classification) || r.virtual_content?.status !== "none"
    );
    const excludedImages = records.filter((r) => !r.usable_for_condition_analysis);
    const wideAngleImages = records.filter((r) => r.wide_angle_likely && r.wide_angle_confidence >= 0.6);
    const unassignedUsable = records.filter(
      (r) => r.usable_for_condition_analysis && !assigned.has(r.id)
    );

    const condition = floors.condition;

    return {
      status: "ok",
      photo_count: records.length,
      usable_photo_count: records.filter((r) => r.usable_for_condition_analysis).length,
      virtual_image_count: virtualImages.filter((r) => VIRTUAL_CLASSIFICATIONS.has(r.classification)).length,
      images: records.map((r) => ({
        ...r,
        room_id: rooms.find((room) => room.image_ids.includes(r.id))?.room_id || null,
      })),
      virtual_images: virtualImages.map((r) => ({
        image_id: r.id,
        classification: r.classification,
        virtual_content: r.virtual_content,
      })),
      excluded_images: excludedImages.map((r) => ({
        image_id: r.id,
        classification: r.classification,
        reason: r.exclusion_reason,
      })),
      image_relationships: relationships,
      rooms,
      unassigned_usable_image_ids: unassignedUsable.map((r) => r.id),
      exterior,
      missing_visual_coverage: missing,
      photo_distribution: distribution,
      photo_distribution_warning: distributionWarning,
      photo_coverage: coverage,
      anomalies,
      potential_works: potentialWorks,
      strengths,
      warnings,
      description_contradictions: contradictions,
      structured_data_notes: synthesis.structured_data_notes,
      renovation: floors.renovation,
      overall_condition: condition,
      wide_angle: {
        likely: synthesis.wide_angle_likely || wideAngleImages.length > 0,
        image_ids: wideAngleImages.map((r) => r.id),
      },
      possible_photo_inconsistency: synthesis.possible_photo_inconsistency,
      architectural_character: synthesis.architectural_character,
      renovation_potential: synthesis.renovation_potential,
      visible_equipment: visibleEquipmentSummary(rooms),
      analysis_quality: quality,
      summary: synthesis.summary,
      visit_questions: synthesis.visit_questions,
      visit_checks: synthesis.visit_checks,
      negotiation_points: negotiation,
      model: vision.model,
      analyzed_at: new Date().toISOString(),
      analysis_debug: {
        analyzed_at: new Date().toISOString(),
        model: vision.model,
        image_pass: {
          ...imagePassDebug,
          failed_batch_count: failures,
          batch_count: batches,
        },
        synthesis_error: synthesisError,
        common_area_works_excluded: commonAreaWorks.map((w) => w.label || w.work_type),
        unassigned_photo_works: fallbackWorks.length,
        condition_adjustments: floors.adjustments,
      },
    };
  }

  return { configured, analyze, assemble };
}
