import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeClaims, subjectFromDescription } from "../src/lib/photo-analysis/claims.js";

const ANNONCE_36 =
  "Dans un petit immeuble un peu en retrait de l'avenue donc le calme absolu petit immeuble entièrement rénové sur cour plein sud. Appartement de 3 pièces à rafraîchir.";

const interior = { id: "img_001", exterior_kind: null };
const facade = { id: "img_002", exterior_kind: "building" };
const records = [interior, facade];

test("sujet : le nom le plus proche avant l'affirmation, dans la même phrase", () => {
  assert.equal(subjectFromDescription("entièrement rénové", ANNONCE_36), "building");
  assert.equal(
    subjectFromDescription("entièrement rénové", "Appartement entièrement rénové dans un immeuble ancien."),
    "dwelling"
  );
  assert.equal(subjectFromDescription("à rafraîchir", ANNONCE_36), "dwelling", "pas de fuite d'une phrase à l'autre");
  assert.equal(subjectFromDescription("immeuble entièrement rénové", ""), "building");
  assert.equal(subjectFromDescription("très lumineux", "Très lumineux."), null);
});

test("immeuble rénové contredit par des photos intérieures → non vérifiable", () => {
  const [claim] = scopeClaims(
    [{ claim: "entièrement rénové", subject: "dwelling", status: "contradicted", reason: "Usure visible.", image_ids: ["img_001"] }],
    { records, description: ANNONCE_36, propertyType: "apartment" }
  );
  assert.equal(claim.subject, "building");
  assert.equal(claim.status, "not_verifiable");
  assert.equal(claim.model_status, "contradicted");
  assert.deepEqual(claim.image_ids, []);
  assert.match(claim.reason, /immeuble/);
});

test("immeuble jugé sans photo citée → non vérifiable ; avec la façade → verdict conservé", () => {
  const ctx = { records, description: ANNONCE_36, propertyType: "apartment" };
  const [noPhoto] = scopeClaims([{ claim: "immeuble rénové", status: "contradicted", image_ids: [] }], ctx);
  assert.equal(noPhoto.status, "not_verifiable");

  const [withFacade] = scopeClaims(
    [{ claim: "immeuble rénové", status: "supported", image_ids: ["img_001", "img_002"] }],
    ctx
  );
  assert.equal(withFacade.status, "supported");
  assert.deepEqual(withFacade.image_ids, ["img_002"]);
});

test("affirmation sur le logement : photos intérieures valables, verdict inchangé", () => {
  const [claim] = scopeClaims(
    [{ claim: "entièrement rénové", status: "contradicted", image_ids: ["img_001"] }],
    { records, description: "Appartement entièrement rénové.", propertyType: "apartment" }
  );
  assert.equal(claim.subject, "dwelling");
  assert.equal(claim.status, "contradicted");
  assert.equal(claim.scope_adjusted, undefined);
});

test("maison : le bâtiment est le logement, l'intérieur peut juger « maison rénovée »", () => {
  const [claim] = scopeClaims(
    [{ claim: "entièrement rénové", subject: "building", status: "contradicted", image_ids: ["img_001"] }],
    { records, description: "Bâtiment entièrement rénové.", propertyType: "house" }
  );
  assert.equal(claim.subject, "dwelling");
  assert.equal(claim.status, "contradicted");
});
