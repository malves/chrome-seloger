/**
 * Chantiers « Logement entier » : création de cloison.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { costsOptions, estimateWorksCosts } from "../src/lib/works/works-costs.js";
import {
  MAX_GLOBAL_QUANTITY,
  globalVariant,
  globalWork,
  globalWorkLines,
  normalizeGlobalItems,
} from "../src/lib/works/works-global.js";

const costs = costsOptions();
const rooms = [{ id: "l", type: "living_room", label: "", condition: "average", issues: [] }];
const item = (over = {}) => ({ key: "partitions", enabled: true, variant: undefined, quantity: null, source: "user", reason: "", ...over });
const partitionLine = (items) => globalWorkLines({ items, rooms, surface: 70, propertyType: "apartment" }).lines.find((l) => l.key === "partitions");

test("cloison : 1 pièce par défaut, au barème de la pièce complète", () => {
  const line = partitionLine([item()]);
  const complete = globalVariant(globalWork("partitions"), "complete");
  assert.equal(line.variant, "complete");
  assert.equal(line.quantity, 1);
  assert.equal(line.estimated, false);
  assert.equal(line.detail, "1 pièce");
  assert.equal(line.min, complete.min);
  assert.equal(line.max, complete.max);
});

test("cloison simple : le nombre de pièces multiplie le barème", () => {
  const line = partitionLine([item({ variant: "simple", quantity: 3 })]);
  assert.equal(line.min, 4500);
  assert.equal(line.max, 9000);
  assert.equal(line.detail, "3 pièces");
});

test("cloison : décochée, aucune ligne", () => {
  assert.equal(partitionLine([item({ enabled: false })]), undefined);
});

test("cloison : normalisation de la variante et de la quantité", () => {
  const [norm] = normalizeGlobalItems([item({ variant: "inconnue", quantity: 500 })]);
  assert.equal(norm.key, "partitions");
  assert.equal(norm.variant, "complete");
  assert.equal(norm.quantity, MAX_GLOBAL_QUANTITY);
});

test("cloison : comptée dans le total et majorée par la provision pour imprévus", () => {
  const estimate = (globalItems) =>
    estimateWorksCosts({ surface: 70, propertyType: "apartment", rooms, globalItems, dpeZones: {}, costs });
  const contingency = { key: "contingency", enabled: true, variant: "standard", quantity: null, source: "user", reason: "" };
  const without = estimate([contingency]);
  const withPartitions = estimate([item({ quantity: 2 }), contingency]);
  assert.ok(withPartitions.items.some((i) => i.id === "global:partitions"));
  assert.ok(withPartitions.max > without.max);
  const cont = (est) => est.items.find((i) => i.key === "contingency")?.max || 0;
  assert.ok(cont(withPartitions) > cont(without));
});
