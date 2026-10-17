/**
 * Plan de travaux : proposition de l'IA, réconciliation avec la galerie,
 * validation des données reçues, et routes de la modale « Pièces et état ».
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createUser, extractCsrf, listingPayload, loginAgent } from "./helpers.js";
import createListingsService from "../src/services/listings.service.js";
import {
  PHOTO_ANALYSIS_PROVIDER,
  photoAnalysisCachePayload,
} from "../src/lib/photo-analysis-cache.js";
import {
  captionFromObservations,
  emptyRoom,
  applyHeavyRenovationIssues,
  revertHeavyRenovationAutoIssues,
  HEAVY_RENOVATION_WORST_ISSUES,
  normalizePlannerRoomCondition,
  parseWorksPlan,
  plannerOptions,
  reconcileWorksPlan,
  seedWorksPlan,
  worksRoomsSummary,
} from "../src/lib/works/works-plan.js";

const PHOTOS = [
  "https://p.example.com/salon.jpg",
  "https://p.example.com/cuisine.jpg",
  "https://p.example.com/plan.jpg",
  "https://p.example.com/facade.jpg",
  "https://p.example.com/couloir.jpg",
];

function analysis(photos = PHOTOS) {
  return {
    status: "ok",
    ready: true,
    images: [
      {
        id: "img_001",
        order: 1,
        url: photos[0],
        exclusion_reason: null,
        observations: {
          floor: { material: "old_wood_parquet", notes: "Parquet usé près de la fenêtre" },
          walls: { notes: "Peinture défraîchie" },
          possible_defects: [{ observation: "Tache au plafond" }],
        },
      },
      { id: "img_002", order: 2, url: photos[1], exclusion_reason: null },
      { id: "img_003", order: 3, url: photos[2], exclusion_reason: "floor_plan" },
      { id: "img_004", order: 4, url: photos[3], exclusion_reason: "exterior" },
      { id: "img_005", order: 5, url: photos[4], exclusion_reason: null },
    ],
    excluded_images: [
      { image_id: "img_003", reason: "floor_plan" },
      { image_id: "img_004", reason: "exterior" },
    ],
    unassigned_usable_image_ids: ["img_005"],
    rooms: [
      {
        room_id: "room_01",
        room_type: "living_room",
        label: "Séjour",
        image_ids: ["img_001"],
        condition: "dated",
        summary: "Séjour lumineux mais daté.",
        floor: { material: "old_wood_parquet", condition: "worn", potential_work: "Ponçage à prévoir" },
        walls: { condition: "dated", notes: "Papier peint ancien" },
        ceiling: { condition: "good", notes: null },
        brightness: "bright",
        ceiling_height: "high",
        storage: "none_visible",
        view: { type: "open_view" },
      },
      { room_id: "room_02", room_type: "kitchen", label: "Cuisine", image_ids: ["img_002"], condition: "renovation_needed" },
    ],
  };
}

/* ------------------------------- Lib pure ------------------------------- */

test("options modale : cinq états généraux de pièce et « Non évalué »", () => {
  const labels = plannerOptions().roomConditions.map((o) => o.label);
  assert.deepEqual(labels, [
    "Neuf / Rénové",
    "Très bon",
    "Bon",
    "Moyen",
    "À rénover",
    "Rénovation lourde",
    "Non évalué",
  ]);
});

test("rénovation lourde : pires tags par catégorie", () => {
  assert.ok(HEAVY_RENOVATION_WORST_ISSUES.includes("floor_redo"));
  assert.ok(HEAVY_RENOVATION_WORST_ISSUES.includes("walls_damaged"));
  assert.ok(HEAVY_RENOVATION_WORST_ISSUES.includes("ceiling_damaged"));
  assert.ok(HEAVY_RENOVATION_WORST_ISSUES.includes("mold"));
  assert.ok(!HEAVY_RENOVATION_WORST_ISSUES.includes("electricity"), "l'électricité relève du logement entier");
  assert.ok(!HEAVY_RENOVATION_WORST_ISSUES.includes("floor_worn"));
  assert.ok(!HEAVY_RENOVATION_WORST_ISSUES.includes("paint"));
  const merged = applyHeavyRenovationIssues(["paint", "floor_worn", "kitchen_refresh"], "kitchen");
  assert.ok(merged.issues.includes("floor_redo"));
  assert.ok(merged.issues.includes("walls_damaged"));
  assert.ok(!merged.issues.includes("floor_worn"));
  assert.ok(!merged.issues.includes("paint"), "murs à refaire remplace la peinture");
  assert.ok(merged.added.includes("floor_redo"));
  const reverted = revertHeavyRenovationAutoIssues([...merged.issues, "kitchen_refresh"], merged.added);
  assert.ok(!reverted.includes("floor_redo") && !reverted.includes("walls_damaged"));
});

test("rénovation lourde : cuisine et salle d'eau seulement dans leurs pièces", () => {
  const kitchen = applyHeavyRenovationIssues([], "kitchen").issues;
  assert.ok(kitchen.includes("kitchen_redo"));
  assert.ok(!kitchen.includes("bathroom_redo"));
  const bath = applyHeavyRenovationIssues([], "bathroom").issues;
  assert.ok(bath.includes("bathroom_redo"));
  assert.ok(!bath.includes("kitchen_redo"));
  const living = applyHeavyRenovationIssues([], "living_room").issues;
  assert.ok(!living.includes("kitchen_redo"), "un séjour n'a pas forcément de cuisine");
  assert.ok(living.includes("floor_redo"));
});

test("points de cuisine ou de salle d'eau retirés d'une pièce qui n'en a pas", () => {
  const room = { ...emptyRoom("u_1", "bedroom", "Chambre"), issues: ["paint", "kitchen_redo", "bathroom_refresh"] };
  const base = { rooms: [room], groups: { unassigned: [], exterior: [], excluded: [] }, captions: {} };
  const parsed = parseWorksPlan(base);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.plan.rooms[0].issues, ["paint"]);
  const options = plannerOptions();
  assert.ok(options.issueCategories.some((c) => c.value === "fixtures"));
  assert.deepEqual(options.exclusiveIssues.find((p) => p.includes("kitchen_redo")), ["kitchen_refresh", "kitchen_redo"]);
});

test("schéma : résumé IA séparé de la note, raisons et pièce à préciser", () => {
  const legacy = { ...emptyRoom("room_01", "bathroom", "Salle de bain"), source: "ai", summary: "Résumé de l'IA", condition: "average" };
  delete legacy.ai_summary;
  delete legacy.issue_reasons;
  delete legacy.needs_review;
  const out = reconcileWorksPlan({ rooms: [legacy], groups: {}, captions: {} }, []);
  assert.equal(out.rooms[0].ai_summary, "Résumé de l'IA");
  assert.equal(out.rooms[0].summary, "");
  assert.equal(out.rooms[0].needs_review, true);

  const mine = reconcileWorksPlan({ rooms: [{ ...legacy, source: "user", summary: "Ma note" }], groups: {}, captions: {} }, []);
  assert.equal(mine.rooms[0].summary, "Ma note");

  const room = { ...emptyRoom("r", "bathroom"), issues: ["paint"], issues_ai: ["paint"], issue_reasons: { paint: "Murs tachés", mold: "hors IA" } };
  const parsed = parseWorksPlan({ rooms: [room], groups: { unassigned: [], exterior: [], excluded: [] }, captions: {} });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.plan.rooms[0].issue_reasons, { paint: "Murs tachés" });
  assert.equal(parsed.plan.rooms[0].needs_review, false);
});

test("normalisation planner : non évaluable et valeurs inconnues ne deviennent pas « Moyen »", () => {
  assert.equal(normalizePlannerRoomCondition("not_assessable"), "not_assessable");
  assert.equal(normalizePlannerRoomCondition("n_importe_quoi"), "not_assessable");
  assert.equal(normalizePlannerRoomCondition("heavy_renovation_likely"), "heavy_renovation_likely");
  assert.equal(normalizePlannerRoomCondition("refresh_needed"), "average");
});

test("seed : pièces, surfaces et groupes repris de l'analyse", () => {
  const plan = seedWorksPlan(analysis(), PHOTOS);
  assert.equal(plan.rooms.length, 2);
  const [salon, cuisine] = plan.rooms;
  assert.equal(salon.id, "room_01");
  assert.equal(salon.type, "living_room");
  assert.equal(salon.condition, "average", "« daté » IA est ramené à Moyen dans la modale");
  assert.equal(salon.condition_source, "ai");
  assert.deepEqual(salon.floor, {
    material: "old_wood_parquet",
    condition: "worn",
    note: "Ponçage à prévoir",
    source: "ai",
  });
  assert.equal(salon.walls.note, "Papier peint ancien");
  assert.equal(salon.ceiling.note, "");
  assert.deepEqual(
    { b: salon.ambiance.brightness, h: salon.ambiance.ceiling_height, s: salon.ambiance.storage, n: salon.ambiance.note },
    { b: "bright", h: "high", s: "none_visible", n: "Vue dégagée" }
  );
  assert.deepEqual(salon.photos, [PHOTOS[0]]);
  assert.deepEqual(cuisine.photos, [PHOTOS[1]]);
  assert.equal(cuisine.floor.condition, "unknown");
  assert.deepEqual(plan.groups, {
    unassigned: [PHOTOS[4]],
    exterior: [PHOTOS[3]],
    excluded: [PHOTOS[2]],
  });
  assert.match(plan.captions[PHOTOS[0]].text, /Sol : Parquet usé/);
  assert.match(plan.captions[PHOTOS[0]].text, /Tache au plafond/);
  assert.equal(plan.captions[PHOTOS[0]].source, "ai");
});

test("seed : points à signaler pré-cochés depuis les surfaces, l'ambiance et les anomalies", () => {
  const stored = analysis();
  stored.anomalies = [{ type: "possible_humidity", room_id: "room_01" }, { type: "crack", room_id: "room_99" }];
  stored.rooms[0].windows = { replacement_may_be_relevant: true };
  stored.rooms[0].ceiling_height = "low";
  const plan = seedWorksPlan(stored, PHOTOS);
  const [salon, cuisine] = plan.rooms;
  assert.deepEqual(salon.issues, ["floor_worn", "paint", "humidity"]);
  assert.deepEqual(salon.issues_ai, salon.issues);
  assert.equal(salon.ambiance.ceiling_height, "low", "plafond bas : caractéristique, pas un point à signaler");
  assert.deepEqual(cuisine.issues, []);
  const windows = plan.global.items.find((i) => i.key === "windows");
  assert.equal(windows.enabled, true, "fenêtres : chantier du logement entier pré-coché");
  assert.equal(windows.source, "ai");
  assert.equal(windows.quantity, 2, "une seule pièce concernée : ses fenêtres seulement");
  assert.ok(windows.reason);
});

test("murs : peinture et murs à refaire s'excluent, plus d'option « Fissures »", () => {
  const options = plannerOptions();
  assert.ok(!options.issues.some((i) => i.value === "cracks"));
  assert.deepEqual(options.exclusiveIssues.find((p) => p.includes("walls_damaged")), ["paint", "walls_damaged"]);
  const room = { ...emptyRoom("r", "bedroom", "Chambre"), photos: [], issues: ["paint", "walls_damaged"] };
  const parsed = parseWorksPlan({ rooms: [room], groups: { unassigned: [], exterior: [], excluded: [] }, captions: {} });
  assert.deepEqual(parsed.plan.rooms[0].issues, ["walls_damaged"], "murs à refaire inclut la peinture");
});

test("fissure relevée par l'IA : « Murs à refaire » coché, avec le constat", () => {
  const stored = analysis();
  stored.rooms[0].walls = { condition: "worn" };
  stored.anomalies = [{ type: "crack", room_id: "room_01", observation: "Fissure en escalier au-dessus de la porte" }];
  const [salon] = seedWorksPlan(stored, PHOTOS).rooms;
  assert.ok(salon.issues.includes("walls_damaged"));
  assert.ok(!salon.issues.includes("paint"), "la peinture est comprise dans les murs à refaire");
  assert.ok(!salon.issues.includes("cracks"));

  const synth = analysis();
  synth.rooms[0].issues = ["cracks"];
  synth.rooms[0].issue_reasons = { cracks: "Fissure verticale sur le mur du séjour" };
  const [fromSynthesis] = seedWorksPlan(synth, PHOTOS).rooms;
  assert.ok(fromSynthesis.issues.includes("walls_damaged"));
  assert.match(fromSynthesis.issue_reasons.walls_damaged, /Fissure verticale/);
});

test("sol, murs, plafond : définitions pour le « ? », humidité marquée sur une photo → murs à refaire", () => {
  const hints = Object.fromEntries(plannerOptions().issues.map((i) => [i.value, i.hint]));
  assert.match(hints.floor_worn, /ponçage|vitrification/i);
  assert.match(hints.floor_redo, /remplacer|dépose/i);
  assert.match(hints.paint, /papier peint/);
  assert.match(hints.walls_damaged, /fissures/);
  assert.match(hints.ceiling_paint, /peinture/i);
  assert.match(hints.ceiling_damaged, /fissuré|dégât/i);
  assert.match(hints.humidity, /Auréoles|humidité/i);
  assert.match(hints.mold, /Moisissures|ventilation/i);
  assert.match(hints.kitchen_refresh, /façades|crédence/i);
  assert.match(hints.bathroom_redo, /sanitaires|faïence/i);

  const stored = analysis();
  stored.images[0].usable_for_condition_analysis = true;
  stored.images[0].observations = { walls: { condition: "worn", defects: ["damp_marks"] } };
  const [salon] = seedWorksPlan(stored, PHOTOS).rooms;
  assert.ok(salon.issues.includes("walls_damaged"));
  assert.ok(!salon.issues.includes("paint"));
});

test("ancien plan avec « Fissures » : converti en « Murs à refaire », raison conservée", () => {
  const room = {
    ...emptyRoom("r", "bedroom", "Chambre"),
    photos: [],
    issues: ["paint", "cracks"],
    issues_ai: ["cracks"],
    issue_reasons: { cracks: "Fissure au plafond du couloir" },
  };
  const out = reconcileWorksPlan({ version: 2, rooms: [room], global: { items: [] }, groups: {}, captions: {} }, []);
  assert.deepEqual(out.rooms[0].issues, ["walls_damaged"]);
  assert.deepEqual(out.rooms[0].issues_ai, ["walls_damaged"]);
  assert.equal(out.rooms[0].issue_reasons.walls_damaged, "Fissure au plafond du couloir");
  assert.equal(parseWorksPlan({ ...out, rooms: [{ ...room }] }).ok, true, "un ancien client qui envoie « cracks » n'est pas rejeté");
});

/* --------------------------- Logement entier --------------------------- */

function wholeHomeAnalysis() {
  return {
    status: "ok",
    ready: true,
    images: [],
    rooms: [
      { room_id: "r1", room_type: "living_room", label: "Séjour", image_ids: [], condition: "dated" },
      { room_id: "r2", room_type: "bedroom", label: "Chambre", image_ids: [], condition: "dated" },
    ],
    anomalies: [],
    potential_works: [],
  };
}

const globalKeys = (plan) => plan.global.items.map((i) => i.key);

test("seed logement entier : électricité ancienne dans une pièce → mise en sécurité, hors pièce → réfection", () => {
  const stored = wholeHomeAnalysis();
  stored.potential_works = [{ work_type: "visible_electrical_modernization", room_id: "r1", necessity: "likely", rationale: "Prises anciennes" }];
  const local = seedWorksPlan(stored, []).global.items.find((i) => i.key === "electricity");
  assert.equal(local.variant, "safety");
  assert.match(local.reason, /Prises anciennes/);

  stored.potential_works.push({ work_type: "visible_electrical_modernization", room_id: null, necessity: "likely", rationale: "Tableau d'origine" });
  const whole = seedWorksPlan(stored, []).global.items.find((i) => i.key === "electricity");
  assert.equal(whole.variant, "full");
  assert.equal(whole.source, "ai");
});

test("seed logement entier : simple vitrage partout → toutes les fenêtres", () => {
  const stored = wholeHomeAnalysis();
  for (const r of stored.rooms) r.windows = { replacement_may_be_relevant: true };
  const windows = seedWorksPlan(stored, []).global.items.find((i) => i.key === "windows");
  assert.equal(windows.quantity, null, "« Toutes » : quantité estimée à partir des pièces");
});

test("seed logement entier : diagnostics selon l'année, préparation et imprévus seulement s'il y a des travaux", () => {
  assert.deepEqual(globalKeys(seedWorksPlan(wholeHomeAnalysis(), [], { listing: { year_built: 1930 } })), []);

  const stored = wholeHomeAnalysis();
  stored.rooms[0].windows = { replacement_may_be_relevant: true };
  const old = seedWorksPlan(stored, [], { listing: { year_built: 1930 } });
  assert.deepEqual(globalKeys(old), ["windows", "diagnostics", "preparation", "contingency"]);
  assert.match(old.global.items.find((i) => i.key === "diagnostics").reason, /plomb/);

  const recent = seedWorksPlan(stored, [], { listing: { year_built: 2005 } });
  assert.ok(!globalKeys(recent).includes("diagnostics"));
  assert.ok(!globalKeys(recent).includes("project_management"), "maîtrise d'œuvre : jamais proposée d'office");
});

test("migration v1 : électricité et fenêtres quittent les pièces, raisons conservées", () => {
  const room = (id, type, issues, reasons = {}) => ({
    ...emptyRoom(id, type, type), photos: [], issues, issues_ai: issues, issue_reasons: reasons,
  });
  const v1 = {
    version: 1,
    rooms: [
      room("a", "living_room", ["paint", "windows", "electricity"], { electricity: "Prises sans terre" }),
      room("b", "bedroom", ["joinery"]),
      room("c", "kitchen", []),
    ],
    groups: { unassigned: [], exterior: [], excluded: [] },
    captions: {},
  };
  const out = reconcileWorksPlan(v1, []);
  assert.equal(out.version, 2);
  assert.deepEqual(out.rooms[0].issues, ["paint"]);
  assert.deepEqual(out.rooms[1].issues, []);
  const byKey = Object.fromEntries(out.global.items.map((i) => [i.key, i]));
  assert.equal(byKey.electricity.variant, "full");
  assert.equal(byKey.electricity.reason, "Prises sans terre");
  assert.equal(byKey.windows.quantity, 3, "séjour (2) + chambre (1), la cuisine n'était pas cochée");
  assert.ok(byKey.preparation && byKey.contingency, "ancien plan avec travaux : frais de chantier ajoutés");
  assert.equal(parseWorksPlan(out).ok, true);

  const again = reconcileWorksPlan(out, []);
  assert.deepEqual(again.global, out.global, "migration idempotente");
});

test("validation logement entier : clés, variantes et quantités contrôlées, choix refusés conservés", () => {
  const base = { rooms: [], groups: { unassigned: [], exterior: [], excluded: [] }, captions: {} };
  const item = (over) => ({ key: "windows", enabled: true, variant: "double", quantity: 4, source: "user", reason: "", ...over });
  const ok = parseWorksPlan({ ...base, global: { items: [item(), item({ key: "electricity", enabled: false, variant: "full", quantity: null })] } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.plan.global.items.map((i) => [i.key, i.enabled]), [["electricity", false], ["windows", true]]);

  assert.equal(parseWorksPlan({ ...base, global: { items: [item({ key: "piscine" })] } }).ok, false);
  assert.equal(parseWorksPlan({ ...base, global: { items: [item({ quantity: 0 })] } }).ok, false);
  assert.equal(parseWorksPlan({ ...base, global: { items: [item({ quantity: 1000 })] } }).ok, false);
  assert.equal(parseWorksPlan(base).plan.global.items.length, 0, "sans bloc global : liste vide");
});

test("options : points groupés par catégorie, caractéristiques à part", () => {
  const o = plannerOptions();
  const categories = new Set(o.issueCategories.map((c) => c.value));
  assert.ok(o.issues.every((i) => categories.has(i.category)));
  assert.ok(!o.issues.some((i) => ["dark", "low_ceiling"].includes(i.value)));
  assert.deepEqual(o.traits.map((t) => t.value), ["bright", "dark", "high_ceiling", "low_ceiling"]);
});

test("points à signaler : clés inconnues rejetées, exclusions appliquées, anciens plans déduits", () => {
  const room = { ...emptyRoom("u_1", "bedroom", "Chambre"), photos: [] };
  const base = { rooms: [room], groups: { unassigned: [], exterior: [], excluded: [] }, captions: {} };
  assert.equal(parseWorksPlan({ ...base, rooms: [{ ...room, issues: ["piscine"] }] }).ok, false);
  const ok = parseWorksPlan({ ...base, rooms: [{ ...room, issues: ["floor_worn", "floor_redo", "mold"] }] });
  assert.deepEqual(ok.plan.rooms[0].issues, ["floor_redo", "mold"]);

  const legacy = { ...room, walls: { ...room.walls, condition: "damaged" } };
  delete legacy.issues;
  const out = reconcileWorksPlan({ rooms: [legacy], groups: {}, captions: {} }, []);
  assert.deepEqual(out.rooms[0].issues, ["walls_damaged"]);

  const withOldTraits = reconcileWorksPlan({ rooms: [{ ...room, issues: ["paint", "dark", "low_ceiling"] }], groups: {}, captions: {} }, []);
  assert.deepEqual(withOldTraits.rooms[0].issues, ["paint"]);
  assert.equal(withOldTraits.rooms[0].ambiance.brightness, "dark");
  assert.equal(withOldTraits.rooms[0].ambiance.ceiling_height, "low");
});

test("seed : sans analyse, toutes les photos sont à classer", () => {
  const plan = seedWorksPlan({ ready: false, status: "pending" }, PHOTOS);
  assert.equal(plan.rooms.length, 0);
  assert.deepEqual(plan.groups.unassigned, PHOTOS);
});

test("légende : vide sans observation exploitable", () => {
  assert.equal(captionFromObservations(null), "");
  assert.equal(captionFromObservations({ floor: { material: "unknown" } }), "");
  assert.equal(captionFromObservations({ floor: { material: "tiles" } }), "Sol : carrelage");
});

test("réconciliation : corrections conservées, photo retirée, nouvelle photo à classer, doublon dédupliqué", () => {
  const plan = seedWorksPlan(analysis(), PHOTOS);
  plan.rooms[0].label = "Grand salon";
  plan.rooms[0].photos.push(PHOTOS[1]);
  plan.captions[PHOTOS[1]] = { text: "Cuisine en formica", source: "user" };

  const nextGallery = [PHOTOS[0], PHOTOS[1], PHOTOS[3], PHOTOS[4], "https://p.example.com/nouvelle.jpg"];
  const out = reconcileWorksPlan(plan, nextGallery);
  assert.equal(out.rooms[0].label, "Grand salon");
  assert.deepEqual(out.rooms[0].photos, [PHOTOS[0], PHOTOS[1]]);
  assert.deepEqual(out.rooms[1].photos, [], "la cuisine perd le doublon déjà placé dans le séjour");
  assert.deepEqual(out.groups.excluded, [], "le plan supprimé de la galerie disparaît");
  assert.deepEqual(out.groups.unassigned, [PHOTOS[4], "https://p.example.com/nouvelle.jpg"]);
  assert.equal(out.captions[PHOTOS[1]].text, "Cuisine en formica");
  assert.equal(out.captions[PHOTOS[2]], undefined);
});

test("validation : plan valide accepté, enums et textes invalides rejetés", () => {
  const room = { ...emptyRoom("u_1", "bedroom", "Chambre"), photos: [PHOTOS[0]] };
  const base = { rooms: [room], groups: { unassigned: [], exterior: [], excluded: [] }, captions: {} };
  const ok = parseWorksPlan(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.plan.version, 2);

  assert.equal(parseWorksPlan({ ...base, rooms: [{ ...room, type: "piscine" }] }).ok, false);
  assert.equal(
    parseWorksPlan({ ...base, rooms: [{ ...room, floor: { ...room.floor, condition: "parfait" } }] }).ok,
    false
  );
  assert.equal(parseWorksPlan({ ...base, rooms: [{ ...room, label: "x".repeat(61) }] }).ok, false);
  assert.equal(parseWorksPlan({ ...base, rooms: [{ ...room, id: "<script>" }] }).ok, false);
  assert.equal(parseWorksPlan({ ...base, rooms: [room, room] }).ok, false, "identifiants en double");
  assert.equal(parseWorksPlan({ ...base, captions: { [PHOTOS[0]]: { text: "y".repeat(401) } } }).ok, false);
  assert.equal(parseWorksPlan(null).ok, false);
});

test("résumé du widget : ton, libellé, vignette et photos à classer", () => {
  const stored = analysis();
  stored.rooms[1].kitchen = { condition: "full_replacement_likely", notes: "Meubles très datés" };
  const plan = seedWorksPlan(stored, PHOTOS);
  const summary = worksRoomsSummary({ plan, stored: false, aiStatus: "ok" });
  assert.equal(summary.rooms[0].label, "Séjour");
  assert.equal(summary.rooms[0].tone, "average");
  assert.equal(summary.rooms[0].icon, "sofa");
  assert.equal(summary.rooms[0].thumb, PHOTOS[0]);
  assert.equal(summary.rooms[1].tone, "poor");
  assert.equal(summary.unassignedCount, 1);
  assert.equal(summary.stored, false);
});

/* -------------------------------- Routes -------------------------------- */

async function setup(t, { email = "a@example.com", withAnalysis = true } = {}) {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const user = await createUser(ctx.repositories, email);
  const service = createListingsService({ repositories: ctx.repositories });
  const { id } = service.save(user, listingPayload({ photos: PHOTOS }));
  const listing = ctx.repositories.listings.findById(user.id, id);
  if (withAnalysis) {
    const { ready, ...result } = analysis();
    ctx.repositories.enrichments.saveListingResult(listing.id, PHOTO_ANALYSIS_PROVIDER, {
      status: "ok",
      data: photoAnalysisCachePayload(listing, PHOTOS, result),
    });
  }
  const agent = await loginAgent(ctx.app, email);
  const page = await agent.get(`/listings/${id}`).expect(200);
  return { ...ctx, user, listing, agent, page, csrf: extractCsrf(page.text) };
}

test("fiche : section Travaux, bouton visible pour un utilisateur standard, modale et script chargés", async (t) => {
  const { page } = await setup(t);
  assert.match(page.text, /Analyse technique du bien par l'IA/);
  assert.match(page.text, /id="listing-works-title"[\s\S]*État général/);
  assert.match(page.text, /data-works-open/);
  assert.match(page.text, /Dossier technique/);
  assert.match(page.text, /id="works-modal"/);
  assert.match(page.text, /works-planner\.js/);
  assert.doesNotMatch(page.text, /works-room-chip/);
  assert.doesNotMatch(page.text, /works-steps/);
  assert.doesNotMatch(page.text, /listing-works-rooms/);
});

test("GET plan : proposition IA non enregistrée, avec options", async (t) => {
  const { agent, listing, repositories } = await setup(t);
  const res = await agent.get(`/listings/${listing.id}/works/plan`).expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.stored, false);
  assert.equal(res.body.aiStatus, "ok");
  assert.equal(res.body.plan.rooms.length, 2);
  assert.deepEqual(res.body.photos, PHOTOS);
  assert.ok(res.body.options.roomTypes.some((o) => o.value === "toilet" && o.icon === "toilet"));
  assert.ok(res.body.options.costs.issueIntensity.paint);
  assert.equal(res.body.overview.analysisReady, true);
  assert.ok(res.body.overview.propertyLabel);
  assert.equal(repositories.worksPlans.find(listing.id), null, "rien n'est stocké avant une correction");
});

test("PUT plan : enregistré puis relu, réconcilié avec la galerie", async (t) => {
  const { agent, listing, csrf, repositories } = await setup(t);
  const { body } = await agent.get(`/listings/${listing.id}/works/plan`).expect(200);
  const plan = body.plan;
  plan.rooms[0].floor.condition = "damaged";
  plan.rooms[0].floor.source = "user";
  plan.rooms.push({ ...emptyRoom("u_wc", "toilet", "WC"), photos: [PHOTOS[4]] });
  plan.groups.unassigned = [];
  plan.captions[PHOTOS[4]] = { text: "WC suspendu", source: "user" };

  const saved = await agent
    .put(`/listings/${listing.id}/works/plan`)
    .set("X-CSRF-Token", csrf)
    .send({ plan })
    .expect(200);
  assert.equal(saved.body.stored, true);
  assert.equal(saved.body.plan.rooms.length, 3);
  assert.equal(repositories.worksPlans.find(listing.id).data.rooms[2].label, "WC");

  const again = await agent.get(`/listings/${listing.id}/works/plan`).expect(200);
  assert.equal(again.body.stored, true);
  assert.equal(again.body.plan.rooms[0].floor.condition, "damaged");
  assert.equal(again.body.plan.captions[PHOTOS[4]].text, "WC suspendu");

});

test("PUT plan : données invalides → 400 JSON, rien n'est stocké", async (t) => {
  const { agent, listing, csrf, repositories } = await setup(t);
  const res = await agent
    .put(`/listings/${listing.id}/works/plan`)
    .set("X-CSRF-Token", csrf)
    .send({ plan: { rooms: [{ id: "x", type: "piscine" }], groups: {}, captions: {} } })
    .expect(400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error.message, /invalides/);
  assert.equal(repositories.worksPlans.find(listing.id), null);
});

test("PUT plan : jeton CSRF requis", async (t) => {
  const { agent, listing } = await setup(t);
  const { body } = await agent.get(`/listings/${listing.id}/works/plan`).expect(200);
  await agent.put(`/listings/${listing.id}/works/plan`).send({ plan: body.plan }).expect(403);
});

test("DELETE plan : retour à la proposition de l'IA", async (t) => {
  const { agent, listing, csrf, repositories } = await setup(t);
  const { body } = await agent.get(`/listings/${listing.id}/works/plan`).expect(200);
  body.plan.rooms = [];
  await agent.put(`/listings/${listing.id}/works/plan`).set("X-CSRF-Token", csrf).send({ plan: body.plan }).expect(200);
  const reset = await agent.delete(`/listings/${listing.id}/works/plan`).set("X-CSRF-Token", csrf).expect(200);
  assert.equal(reset.body.stored, false);
  assert.equal(reset.body.plan.rooms.length, 2);
  assert.equal(repositories.worksPlans.find(listing.id), null);
});

test("plan d'une annonce d'un autre compte : 404", async (t) => {
  const { app, listing, repositories } = await setup(t);
  await createUser(repositories, "b@example.com");
  const other = await loginAgent(app, "b@example.com");
  const res = await other.get(`/listings/${listing.id}/works/plan`).expect(404);
  assert.equal(res.body.ok, false);
  const page = await other.get("/listings").expect(200);
  await other
    .put(`/listings/${listing.id}/works/plan`)
    .set("X-CSRF-Token", extractCsrf(page.text))
    .send({ plan: { rooms: [], groups: {}, captions: {} } })
    .expect(404);
});

test("analyse en attente : plan vide utilisable via l'API", async (t) => {
  const { agent, listing, page } = await setup(t, { withAnalysis: false });
  const res = await agent.get(`/listings/${listing.id}/works/plan`).expect(200);
  assert.equal(res.body.aiStatus, "pending");
  assert.deepEqual(res.body.plan.groups.unassigned, PHOTOS);
  assert.doesNotMatch(page.text, /listing-works-rooms/);
});
