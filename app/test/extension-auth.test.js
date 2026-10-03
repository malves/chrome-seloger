import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  browserLabel,
  buildRedirect,
  challengeFor,
  parseRedirectUri,
  verifyChallenge,
} from "../src/services/extension-auth.service.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const REDIRECT_URI = `https://${EXTENSION_ID}.chromiumapp.org/`;

test("seules les redirections d'extension Chrome sont acceptées", () => {
  assert.equal(parseRedirectUri(REDIRECT_URI).extensionId, EXTENSION_ID);
  assert.ok(parseRedirectUri(`${REDIRECT_URI}retour?a=1`));

  for (const invalid of [
    "",
    "pas-une-url",
    "https://evil.example.com/callback",
    `http://${EXTENSION_ID}.chromiumapp.org/`,
    "https://chromiumapp.org/",
    // Un identifiant d'extension ne contient que des lettres a à p.
    "https://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.chromiumapp.org/",
    `https://${EXTENSION_ID}.chromiumapp.org.evil.com/`,
  ]) {
    assert.equal(parseRedirectUri(invalid), null, `doit refuser « ${invalid} »`);
  }
});

test("la liste blanche d'identifiants est appliquée quand elle existe", () => {
  assert.ok(parseRedirectUri(REDIRECT_URI, [EXTENSION_ID]));
  assert.equal(parseRedirectUri(REDIRECT_URI, ["ponmlkjihgfedcbaponmlkjihgfedcba"]), null);
  // Liste vide : aucune restriction, pour le développement local.
  assert.ok(parseRedirectUri(REDIRECT_URI, []));
});

test("le vérificateur PKCE doit correspondre au défi", () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  assert.ok(verifyChallenge(verifier, challengeFor(verifier)));

  assert.equal(verifyChallenge(verifier, challengeFor("autre-verificateur")), false);
  assert.equal(verifyChallenge("trop-court", challengeFor("trop-court")), false);
  assert.equal(verifyChallenge(verifier, ""), false);
  assert.equal(verifyChallenge(undefined, challengeFor(verifier)), false);
});

test("la redirection conserve les paramètres existants et ignore les vides", () => {
  const url = new URL(
    buildRedirect(`${REDIRECT_URI}?origine=popup`, {
      code: "abc",
      state: "",
      error: null,
    })
  );

  assert.equal(url.searchParams.get("origine"), "popup");
  assert.equal(url.searchParams.get("code"), "abc");
  assert.equal(url.searchParams.has("state"), false);
  assert.equal(url.searchParams.has("error"), false);
});

test("le libellé de session nomme le navigateur et le système", () => {
  assert.equal(
    browserLabel(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36"
    ),
    "Chrome sur Windows"
  );
  assert.equal(
    browserLabel(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/127.0 Safari/537.36 Edg/127.0"
    ),
    "Edge sur macOS"
  );
  assert.equal(browserLabel(""), "Navigateur");
});
