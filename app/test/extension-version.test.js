import test from "node:test";
import assert from "node:assert/strict";
import {
  compareSemver,
  parseSemver,
  readExtensionVersion,
} from "../src/lib/extension-version.js";
import { isExtensionOutdated } from "../src/services/extension-version.service.js";

test("parseSemver accepte x.y.z", () => {
  assert.deepEqual(parseSemver("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseSemver("1.2"), null);
});

test("compareSemver ordonne les versions", () => {
  assert.ok(compareSemver("0.2.0", "0.3.0") < 0);
  assert.ok(compareSemver("1.0.0", "0.9.9") > 0);
  assert.equal(compareSemver("2.4.1", "2.4.1"), 0);
});

test("isExtensionOutdated sans minimum", () => {
  assert.equal(isExtensionOutdated("0.1.0", ""), false);
  assert.equal(isExtensionOutdated(null, ""), false);
});

test("isExtensionOutdated avec minimum", () => {
  assert.equal(isExtensionOutdated("0.2.0", "0.3.0"), true);
  assert.equal(isExtensionOutdated("0.3.1", "0.3.0"), false);
  assert.equal(isExtensionOutdated("", "0.3.0"), true);
  assert.equal(isExtensionOutdated("bad", "0.3.0"), true);
});

test("readExtensionVersion lit l'en-tête HTTP", () => {
  const req = { get: (name) => (name === "x-carnet-extension-version" ? " 0.2.0 " : "") };
  assert.equal(readExtensionVersion(req), "0.2.0");
});
