import test from "node:test";
import assert from "node:assert/strict";
import {
  dpeChampForCritere,
  addressAiRechercheMeta,
} from "../src/lib/address-ai-criteria-debug.js";

test("dpeChampForCritere : filtre territorial selon le mode", () => {
  assert.match(
    dpeChampForCritere("Code postal", { mode: "precise" }),
    /code_postal_ban/
  );
  assert.match(
    dpeChampForCritere("Code postal", { mode: "departement" }),
    /non utilisé/
  );
  assert.match(
    dpeChampForCritere("Département", { mode: "departement" }),
    /code_departement_ban/
  );
});

test("addressAiRechercheMeta : champs DPE de la requête", () => {
  const meta = addressAiRechercheMeta({
    mode: "precise",
    criteria: { codePostal: "75011", departement: "75", surfaceM2: 50 },
    typeBatiments: ["appartement", "immeuble"],
    surfaceMin: 48.5,
    surfaceMax: 51.5,
    recordsCount: 120,
    candidatesCount: 4,
  });
  assert.equal(meta.champ_territoire, "code_postal_ban");
  assert.equal(meta.territoire, "75011");
  assert.equal(meta.champ_type, "type_batiment");
  assert.equal(meta.champ_surface, "surface_habitable_logement");
  assert.equal(meta.lignes_dpe, 120);
});
