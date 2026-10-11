/**
 * Analyse des photos côté web : provider ignoré sans clé / sans photo, panneau
 * en attente puis rendu depuis le cache, recalcul réservé à l'administration.
 */

import test from "node:test";
import assert from "node:assert/strict";
import config from "../src/config.js";
import { createTestApp, createUser, extractCsrf, listingPayload, loginAgent } from "./helpers.js";
import createListingsService from "../src/services/listings.service.js";
import {
  PHOTO_ANALYSIS_PROVIDER,
  photoAnalysisCachePayload,
} from "../src/lib/photo-analysis-cache.js";

const PHOTOS = [
  "https://p.example.com/salon.jpg",
  "https://p.example.com/cuisine.jpg",
  "https://p.example.com/projection.jpg",
];

function storedAnalysis(listing, photos) {
  return photoAnalysisCachePayload(listing, photos, {
    status: "ok",
    photo_count: 3,
    usable_photo_count: 2,
    virtual_image_count: 1,
    images: [
      { id: "img_001", order: 1, url: photos[0], classification: "real_interior", usable_for_condition_analysis: true, room_type: "living_room", exclusion_reason: null },
      { id: "img_002", order: 2, url: photos[1], classification: "real_interior", usable_for_condition_analysis: true, room_type: "kitchen", exclusion_reason: null },
      { id: "img_003", order: 3, url: photos[2], classification: "architect_projection", usable_for_condition_analysis: false, room_type: "kitchen", exclusion_reason: "virtual_or_projection", virtual_content: { status: "confirmed" } },
    ],
    excluded_images: [{ image_id: "img_003", classification: "architect_projection", reason: "virtual_or_projection" }],
    image_relationships: [
      { relationship: "current_vs_projected", image_ids: ["img_002", "img_003"], current_image: "img_002", projected_image: "img_003", confidence: 0.9 },
    ],
    rooms: [
      { room_id: "room_01", room_type: "living_room", label: "Séjour", image_ids: ["img_001"], condition: "good", condition_confidence: 0.8, floor: { material: "old_wood_parquet", condition: "good", apparent_age: "dated", confidence: 0.8 }, windows: { material: "wood", apparent_age: "dated", glazing: "unknown", replacement_may_be_relevant: true, confidence: 0.7 }, strengths: ["Moulures"] },
      { room_id: "room_02", room_type: "kitchen", label: "Cuisine", image_ids: ["img_002"], condition: "dated", condition_confidence: 0.9, kitchen: { layout: "closed", condition: "dated_but_usable", apparent_age: "very_dated", confidence: 0.9 } },
    ],
    missing_visual_coverage: [{ room_type: "bathroom", label: "Salle de bain / d'eau", missing_count: 1, reason: "expected_but_not_shown", importance: "high" }],
    photo_distribution: { living_room: 1, kitchen: 1 },
    photo_distribution_warning: { status: false, observation: null },
    photo_coverage: { score: 35, level: "poor", room_coverage: 0.4, missing: ["Salle de bain / d'eau"] },
    anomalies: [
      { finding_id: "anomaly_01", type: "possible_humidity", room_id: "room_01", severity: "medium", confidence: 0.77, image_ids: ["img_001"], observation: "Zone sombre près du plafond.", interpretation: "Compatible avec un ancien dégât des eaux.", needs_confirmation: true, evidence_missing: false },
    ],
    potential_works: [
      { work_id: "work_01", work_type: "kitchen_replacement", label: "Remplacement de la cuisine", room_id: "room_02", necessity: "likely", scope: "full", category: "necessary", quantity: 1, confidence: 0.85, image_ids: ["img_002"], rationale: "Meubles et plan de travail très datés.", evidence_missing: false },
    ],
    strengths: [{ label: "Parquet ancien en bon état apparent", confidence: 0.9, image_ids: ["img_001"], evidence_missing: false }],
    warnings: [{ label: "Cuisine à remplacer", severity: "medium", confidence: 0.85, image_ids: ["img_002"], evidence_missing: false }],
    description_contradictions: [{ claim: "entièrement rénové", status: "contradicted", reason: "La cuisine est visiblement ancienne.", image_ids: ["img_002"] }],
    structured_data_notes: [],
    renovation: { level: "moderate_renovation", confidence: 0.85, cosmetic_only_suspected: false, note: null },
    overall_condition: { score: 58, label: "average", confidence: 0.82 },
    wide_angle: { likely: true, image_ids: ["img_001"] },
    possible_photo_inconsistency: { status: false, confidence: 0, note: null },
    analysis_quality: { score: 61, photo_count: 3, usable_photo_count: 2, room_coverage: 0.4, confidence: "good", partial: false },
    summary: "Le logement semble habitable mais la cuisine est datée.",
    visit_questions: ["De quelle année date la cuisine ?"],
    visit_checks: ["Vérifier la trace au plafond du séjour."],
    negotiation_points: [{ label: "Cuisine à remplacer", confidence: 0.85, image_ids: ["img_002"], evidence_missing: false }],
    model: "fake",
    analyzed_at: "2026-10-01T10:00:00.000Z",
  });
}

async function setup(t, { email = "a@example.com", photos = PHOTOS } = {}) {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const user = await createUser(ctx.repositories, email);
  const service = createListingsService({ repositories: ctx.repositories });
  const { id } = service.save(user, listingPayload({ photos, property_type: "apartment", rooms: 3, bedrooms: 2 }));
  const listing = ctx.repositories.listings.findById(user.id, id);
  const agent = await loginAgent(ctx.app, email);
  return { ...ctx, user, listing, agent };
}

test("provider : ignoré proprement sans clé vision (statut erreur, pas d'exception)", async (t) => {
  const { repositories, enrichment, user, listing } = await setup(t);
  const previousKey = config.vision.apiKey;
  config.vision.apiKey = "";
  t.after(() => {
    config.vision.apiKey = previousKey;
  });

  await enrichment.runForListing(user.id, listing.id, { only: PHOTO_ANALYSIS_PROVIDER });
  const row = repositories.enrichments.findOne(listing.id, PHOTO_ANALYSIS_PROVIDER);
  assert.equal(row.status, "error");
  assert.match(row.error, /non configurée/);

  const providers = await enrichment.listProviders();
  const def = providers.find((p) => p.key === PHOTO_ANALYSIS_PROVIDER);
  assert.equal(def.display, false);
  assert.equal(def.standalone, true);
});

test("provider standalone : exclu de la chaîne « tous », lancé seulement par `only`", async (t) => {
  const { repositories, enrichment, user, listing } = await setup(t);
  const previousKey = config.vision.apiKey;
  config.vision.apiKey = "";
  t.after(() => {
    config.vision.apiKey = previousKey;
  });
  await enrichment.runForListing(user.id, listing.id);
  assert.equal(repositories.enrichments.findOne(listing.id, PHOTO_ANALYSIS_PROVIDER), null);
});

test("fiche : panneau en attente sans cache, puis JSON `stored` en pending", async (t) => {
  const { agent, listing } = await setup(t);
  const page = await agent.get(`/listings/${listing.id}`).expect(200);
  assert.match(page.text, /panel__eyebrow" id="listing-photo-analysis-title">Analyse IA/);
  assert.doesNotMatch(page.text, /Ce que montrent les photos/);
  assert.match(page.text, /Analyse des photos en cours/);
  assert.match(page.text, new RegExp(`hx-get="/listings/${listing.id}/photo-analysis/panel"`));

  const stored = await agent.get(`/listings/${listing.id}/photo-analysis/stored`).expect(200);
  assert.equal(stored.body.ready, false);
  assert.equal(stored.body.status, "pending");
});

test("fiche : annonce sans photo → ni panneau en attente ni polling", async (t) => {
  const { agent, listing } = await setup(t, { photos: [] });
  const page = await agent.get(`/listings/${listing.id}`).expect(200);
  assert.doesNotMatch(page.text, /Analyse des photos en cours/);
  const stored = await agent.get(`/listings/${listing.id}/photo-analysis/stored`).expect(200);
  assert.equal(stored.body.status, "insufficient");
});

test("fiche : résultat en cache rendu avec verdict, travaux, anomalies, badges galerie", async (t) => {
  const { agent, repositories, listing } = await setup(t);
  repositories.enrichments.saveListingResult(listing.id, PHOTO_ANALYSIS_PROVIDER, {
    status: "ok",
    data: storedAnalysis(listing, PHOTOS),
  });

  const page = await agent.get(`/listings/${listing.id}`).expect(200);
  const html = page.text;
  assert.doesNotMatch(html, /Analyse des photos en cours/);
  assert.match(html, /Rénovation modérée probablement nécessaire/);
  assert.match(html, /58<span class="pa-hero__stat-unit">\/100/);
  assert.doesNotMatch(html, /pa-score/);
  assert.match(html, /Bonne : 61/);
  assert.match(html, /2 photos exploitables sur 3/);
  assert.match(html, /1 projection exclue/);
  assert.match(html, /Remplacement de la cuisine/);
  assert.match(html, /Potentiellement nécessaire/);
  assert.match(html, /Humidité possible — Séjour/);
  assert.match(html, /Observation :<\/strong> Zone sombre/);
  assert.match(html, /Parquet ancien en bon état apparent/);
  assert.match(html, /Aucune photo : Salle de bain \/ d&#39;eau/);
  assert.match(html, /« entièrement rénové »/);
  assert.match(html, /Contredit par les photos/);
  assert.match(html, /Grand-angle probable/);
  assert.match(html, /De quelle année date la cuisine/);
  assert.match(html, /Cuisine à remplacer/);
  // Le détail par pièce vit désormais dans la section Travaux et sa modale.
  assert.match(html, /État général &amp; Analyse du bien/);
  assert.match(html, /listing-works-head-aside[\s\S]*Paramétrer les pièces/);
  assert.doesNotMatch(html, /listing-photo-analysis[\s\S]*Paramétrer les pièces/);
  assert.match(html, /État actuel et projection de l'agence/);
  // Traçabilité : bouton « voir la photo » vers la 2e image (index 1).
  assert.match(html, /data-photo-jump="1"/);
  // Badge galerie sur la 3e photo (projection).
  assert.match(html, /carousel__flag carousel__flag--architect_projection">Projection</);
  assert.match(html, /carousel__thumb-flag" aria-hidden="true">Projection</);
  // Pas de bouton de relance pour un utilisateur standard.
  assert.doesNotMatch(html, /Relancer l'analyse des photos/);
  // Le panneau seul est servi aussi par la route htmx.
  const panel = await agent.get(`/listings/${listing.id}/photo-analysis/panel`).expect(200);
  assert.match(panel.text, /Rénovation modérée/);
  assert.doesNotMatch(panel.text, /<html/);
});

test("fiche : DPE lié → corrélation fenêtres affichée dans le bloc Cohérence", async (t) => {
  const { agent, repositories, listing, user } = await setup(t);
  repositories.enrichments.saveListingResult(listing.id, PHOTO_ANALYSIS_PROVIDER, {
    status: "ok",
    data: storedAnalysis(listing, PHOTOS),
  });
  repositories.dpe.upsertMany([
    {
      numero_dpe: "DPE-PHOTO-1",
      etiquette_dpe: "F",
      qualite_isolation_menuiseries: "insuffisante",
      type_batiment: "appartement",
    },
  ]);
  repositories.listings.setUserAddress(user.id, listing.id, {
    address: "1 rue des Lilas, 78120 Rambouillet",
    lat: 48.64,
    lng: 1.83,
    source: "detected",
    linkedDpeNumero: "DPE-PHOTO-1",
  });

  const page = await agent.get(`/listings/${listing.id}`).expect(200);
  assert.match(page.text, /Fenêtres et DPE/);
  assert.match(page.text, /Cohérent avec le DPE/);
});

test("effacer l'adresse HTMX retire les corrélations DPE du panneau photo", async (t) => {
  const { agent, repositories, listing, user } = await setup(t);
  repositories.enrichments.saveListingResult(listing.id, PHOTO_ANALYSIS_PROVIDER, {
    status: "ok",
    data: storedAnalysis(listing, PHOTOS),
  });
  repositories.dpe.upsertMany([
    {
      numero_dpe: "DPE-PHOTO-1",
      etiquette_dpe: "F",
      qualite_isolation_menuiseries: "insuffisante",
      type_batiment: "appartement",
    },
  ]);
  repositories.listings.setUserAddress(user.id, listing.id, {
    address: "1 rue des Lilas, 78120 Rambouillet",
    lat: 48.64,
    lng: 1.83,
    source: "detected",
    linkedDpeNumero: "DPE-PHOTO-1",
  });

  const csrf = extractCsrf((await agent.get(`/listings/${listing.id}`)).text);
  const cleared = await agent
    .post(`/listings/${listing.id}/address`)
    .set("HX-Request", "true")
    .type("form")
    .send({ _csrf: csrf, street: "", postal_code: "", city: "" })
    .expect(200);

  assert.doesNotMatch(cleared.text, /Fenêtres et DPE/);
  assert.doesNotMatch(cleared.text, /data-dpe-house-stage/);
  assert.equal(repositories.listings.findById(user.id, listing.id).linked_dpe_numero, null);

  const restored = await agent
    .post(`/listings/${listing.id}/address`)
    .set("HX-Request", "true")
    .type("form")
    .send({
      _csrf: csrf,
      street: "1 rue des Lilas",
      postal_code: "78120",
      city: "Rambouillet",
      address_source: "detected",
      linked_dpe_numero: "DPE-PHOTO-1",
    })
    .expect(200);

  assert.match(restored.text, /Fenêtres et DPE/);
  assert.match(restored.text, /data-dpe-house-stage/);
  assert.equal(
    repositories.listings.findById(user.id, listing.id).linked_dpe_numero,
    "DPE-PHOTO-1"
  );
});

test("recalcul : interdit aux utilisateurs, autorisé à l'admin (JSON stocké après erreur)", async (t) => {
  const { agent, listing } = await setup(t);
  const userPage = await agent.get(`/listings/${listing.id}`).expect(200);
  await agent
    .post(`/listings/${listing.id}/photo-analysis/run`)
    .set("HX-Request", "true")
    .set("X-CSRF-Token", extractCsrf(userPage.text))
    .expect(403);

  const adminEmail = config.adminEmails[0];
  const ctx = await setup(t, { email: adminEmail });
  const previousKey = config.vision.apiKey;
  config.vision.apiKey = "";
  t.after(() => {
    config.vision.apiKey = previousKey;
  });
  const adminPage = await ctx.agent.get(`/listings/${ctx.listing.id}`).expect(200);
  const res = await ctx.agent
    .post(`/listings/${ctx.listing.id}/photo-analysis/run`)
    .set("HX-Request", "true")
    .set("X-CSRF-Token", extractCsrf(adminPage.text))
    .expect(200);
  assert.match(res.text, /Analyse des photos en cours/);
  assert.doesNotMatch(res.text, /Relancer l'analyse des photos/);

  await ctx.enrichment.runForListing(ctx.user.id, ctx.listing.id, {
    only: PHOTO_ANALYSIS_PROVIDER,
  });
  const row = ctx.repositories.enrichments.findOne(ctx.listing.id, PHOTO_ANALYSIS_PROVIDER);
  assert.equal(row.status, "error");
});

test("diagnostic technique : interdit aux utilisateurs, HTML admin avec lots", async (t) => {
  const { agent, listing, repositories } = await setup(t);
  await agent.get(`/listings/${listing.id}/photo-analysis/debug`).expect(403);

  const adminEmail = config.adminEmails[0];
  const ctx = await setup(t, { email: adminEmail });
  const stored = storedAnalysis(ctx.listing, PHOTOS);
  stored.result.analysis_debug = {
    model: "test",
    image_pass: {
      batch_count: 1,
      failed_batch_count: 0,
      image_pass_batches: [
        {
          batch_index: 0,
          status: "ok",
          error: null,
          expected_ids: ["img_001"],
          received_ids: ["img_001"],
          missing_ids: [],
        },
      ],
    },
  };
  ctx.repositories.enrichments.saveListingResult(ctx.listing.id, PHOTO_ANALYSIS_PROVIDER, {
    status: "ok",
    data: stored,
  });

  const page = await ctx.agent.get(`/listings/${ctx.listing.id}`).expect(200);
  assert.match(page.text, /Diagnostic technique/);
  const debug = await ctx.agent.get(`/listings/${ctx.listing.id}/photo-analysis/debug`).expect(200);
  assert.match(debug.text, /Lots de la passe par image/);
  assert.match(debug.text, /batch_failed|missing_from_model_response|Motif d'exclusion/);
});
