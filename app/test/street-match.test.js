import test from "node:test";
import assert from "node:assert/strict";
import {
  compareStreetNames,
  normalizeStreetName,
  parseStreetLine,
} from "../src/lib/street-match.js";

test("normalizeStreetName : accents, tirets, abréviations", () => {
  assert.equal(normalizeStreetName("Bd Saint-Michel"), "boulevard saint michel");
  assert.equal(normalizeStreetName("Rue Gérhard"), "rue gerhard");
  assert.equal(normalizeStreetName("av. du Gal Leclerc"), "avenue du general leclerc");
  assert.equal(normalizeStreetName("Allée de l'Église"), "allee de l eglise");
});

test("parseStreetLine : numéro, suffixe et nom", () => {
  assert.deepEqual(parseStreetLine("118 Rue Guerard"), {
    number: "118",
    numberKey: "118",
    digits: "118",
    name: "Rue Guerard",
  });
  assert.equal(parseStreetLine("12 bis avenue Foch").numberKey, "12bis");
  assert.equal(parseStreetLine("12bis avenue Foch").number, "12 bis");
  assert.equal(parseStreetLine("4B rue des Lilas").numberKey, "4b");
  assert.equal(parseStreetLine("4 rue B").name, "rue B");
  assert.equal(parseStreetLine("Rue Gérhard").number, null);
  assert.equal(parseStreetLine("Rue Gérhard").name, "Rue Gérhard");
});

test("compareStreetNames : exact seulement si identiques une fois normalisés", () => {
  assert.deepEqual(compareStreetNames("rue gerhard", "Rue Gérhard"), { score: 1, exact: true });
  assert.equal(compareStreetNames("bd Saint Michel", "Boulevard Saint-Michel").exact, true);

  const typo = compareStreetNames("rue Gerard", "Rue Gérhard");
  assert.equal(typo.exact, false);
  assert.ok(typo.score >= 0.75, `faute de frappe : ${typo.score}`);

  const missingSpace = compareStreetNames("rue dela Paix", "Rue de la Paix");
  assert.equal(missingSpace.exact, false);
  assert.ok(missingSpace.score >= 0.95);

  const missingType = compareStreetNames("Gérhard", "Rue Gérhard");
  assert.equal(missingType.exact, false);
  assert.ok(missingType.score >= 0.9);

  assert.ok(compareStreetNames("rue de Rivoli", "avenue Foch").score < 0.5);
});
