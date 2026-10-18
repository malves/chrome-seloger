import test from "node:test";
import assert from "node:assert/strict";
import { openRouteServiceAuthorizationHeader } from "../src/lib/open-route-service.js";

test("openRouteServiceAuthorizationHeader ajoute Bearer si absent", () => {
  assert.equal(openRouteServiceAuthorizationHeader("abc"), "Bearer abc");
});

test("openRouteServiceAuthorizationHeader conserve Bearer existant", () => {
  assert.equal(
    openRouteServiceAuthorizationHeader("Bearer token"),
    "Bearer token"
  );
  assert.equal(
    openRouteServiceAuthorizationHeader("bearer token"),
    "bearer token"
  );
});

test("openRouteServiceAuthorizationHeader : clé vide", () => {
  assert.equal(openRouteServiceAuthorizationHeader(""), "");
  assert.equal(openRouteServiceAuthorizationHeader(null), "");
});
