import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeUrl,
  dedupKey,
  sourceIdFromUrl,
} from "../src/services/listings.service.js";

test("le fragment et les paramètres de suivi disparaissent", () => {
  assert.equal(
    canonicalizeUrl(
      "https://www.seloger.com/annonces/1.htm?utm_source=newsletter&utm_medium=mail&gclid=xyz#photos"
    ),
    "https://www.seloger.com/annonces/1.htm"
  );
});

test("les paramètres utiles sont conservés et triés", () => {
  assert.equal(
    canonicalizeUrl("https://example.com/a?b=2&a=1&utm_campaign=x"),
    "https://example.com/a?a=1&b=2"
  );
});

test("hôte en minuscules et barre oblique finale retirée", () => {
  assert.equal(
    canonicalizeUrl("https://WWW.Example.COM/annonce/12/"),
    "https://www.example.com/annonce/12"
  );
});

test("une URL illisible est retournée telle quelle", () => {
  assert.equal(canonicalizeUrl("pas-une-url"), "pas-une-url");
});

test("la clé de déduplication utilise l'identifiant source quand il existe", () => {
  assert.equal(dedupKey("seloger", "12345", "https://a/b"), "seloger:12345");
});

test("sans identifiant source, la clé dérive de l'URL canonique", () => {
  const key = dedupKey("pap", null, "https://www.pap.fr/annonce/1");
  assert.match(key, /^pap:[0-9a-f]{40}$/);
  assert.equal(key, dedupKey("pap", null, "https://www.pap.fr/annonce/1"));
  assert.notEqual(key, dedupKey("pap", null, "https://www.pap.fr/annonce/2"));
});

test("l'identifiant SeLoger moderne est lu dans le chemin /annonce/", () => {
  assert.equal(
    sourceIdFromUrl(
      "seloger",
      "https://www.seloger.com/annonce/26Q9YCW4ZDUN?search=foo"
    ),
    "26Q9YCW4ZDUN"
  );
});

test("l'identifiant est le dernier segment des URL SeLoger complètes", () => {
  assert.equal(
    sourceIdFromUrl(
      "seloger",
      "https://www.seloger.com/annonce/achat/ile-de-france/hauts-de-seine-92/garches-92380/26S3BE9IWZDS"
    ),
    "26S3BE9IWZDS"
  );
});

test("le code postal de la commune ne sert jamais d'identifiant", () => {
  const a = sourceIdFromUrl(
    "seloger",
    "https://www.seloger.com/annonce/achat/ile-de-france/hauts-de-seine-92/garches-92380/AAAAAAAAAAAA"
  );
  const b = sourceIdFromUrl(
    "seloger",
    "https://www.seloger.com/annonce/achat/ile-de-france/hauts-de-seine-92/garches-92380/BBBBBBBBBBBB"
  );
  // Même commune, deux annonces : les clés doivent rester distinctes.
  assert.notEqual(a, b);
  assert.notEqual(a, "92380");
});

test("l'ancien format .htm conserve son identifiant numérique", () => {
  assert.equal(
    sourceIdFromUrl(
      "seloger",
      "https://www.seloger.com/annonces/achat/appartement/nanterre-92/vieux-pont/275190123.htm?search=foo"
    ),
    "275190123"
  );
});

test("deux URL SeLoger différentes donnent la même clé de déduplication", () => {
  const id = sourceIdFromUrl(
    "seloger",
    "https://www.seloger.com/annonce/26Q9YCW4ZDUN"
  );
  const withSerp = canonicalizeUrl(
    "https://www.seloger.com/annonce/26Q9YCW4ZDUN?search=distributionTypes%3DBuy"
  );
  assert.equal(dedupKey("seloger", id, withSerp), "seloger:26Q9YCW4ZDUN");
});
