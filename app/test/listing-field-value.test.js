import test from "node:test";
import assert from "node:assert/strict";
import {
  parseListingFieldValue,
  fieldInputKind,
} from "../src/lib/listing-field-value.js";

test("surface : nombre valide", () => {
  assert.deepEqual(parseListingFieldValue("surface", "95,5"), { ok: true, value: 95.5 });
});

test("surface : abc refusé", () => {
  const r = parseListingFieldValue("surface", "abc");
  assert.equal(r.ok, false);
  assert.match(r.message, /nombre/i);
});

test("charges_copro : xyz refusé", () => {
  const r = parseListingFieldValue("charges_copro", "xyz");
  assert.equal(r.ok, false);
});

test("charges_copro : montant entier accepté", () => {
  assert.deepEqual(parseListingFieldValue("charges_copro", "1800"), {
    ok: true,
    value: 1800,
  });
});

test("dpe : H refusé", () => {
  const r = parseListingFieldValue("dpe", "H");
  assert.equal(r.ok, false);
  assert.match(r.message, /A à G/i);
});

test("dpe : c minuscule normalisé", () => {
  assert.deepEqual(parseListingFieldValue("dpe", "c"), { ok: true, value: "C" });
});

test("fieldInputKind : surface en décimal", () => {
  assert.deepEqual(fieldInputKind("surface"), {
    kind: "decimal",
    unit: "m²",
    decimals: 2,
  });
});

test("fieldInputKind : pièces en entier", () => {
  assert.deepEqual(fieldInputKind("rooms"), { kind: "int", unit: null, decimals: 0 });
});
