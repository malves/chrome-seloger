import test from "node:test";
import assert from "node:assert/strict";
import { dvfPublicationNotice } from "../src/lib/dvf-publication.js";

test("dvfPublicationNotice décrit le calendrier semestriel sans dates dynamiques", () => {
  const text = dvfPublicationNotice();
  assert.match(text, /deux fois par an/);
  assert.match(text, /fin avril/);
  assert.match(text, /fin octobre/);
  assert.doesNotMatch(text, /Dernière livraison/);
  assert.doesNotMatch(text, /Prochaine publication/);
});
