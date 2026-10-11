import assert from "node:assert/strict";
import { test } from "node:test";
import {
  googleMapsListingUrl,
  googleMapsSearchUrl,
  googleMapsStreetViewPanoUrl,
  googleMapsStreetViewUrl,
  resolveGoogleMapsListingUrl,
} from "../src/lib/google-maps-url.js";

test("googleMapsStreetViewUrl ouvre le panorama au point", () => {
  const url = googleMapsStreetViewUrl(48.857832, 2.295226);
  assert.match(url, /^https:\/\/www\.google\.com\/maps\/@\?api=1&map_action=pano&viewpoint=/);
  assert.match(url, /48\.857832%2C2\.295226/);
});

test("googleMapsStreetViewPanoUrl inclut le pano ID", () => {
  const url = googleMapsStreetViewPanoUrl("tu510ie_z4ptBZYo2BGEJg", 48.857832, 2.295226);
  assert.match(url, /map_action=pano/);
  assert.match(url, /pano=tu510ie_z4ptBZYo2BGEJg/);
  assert.match(url, /viewpoint=48\.857832%2C2\.295226/);
});

test("googleMapsListingUrl préfère la recherche texte (évite pano sans couverture)", () => {
  const url = googleMapsListingUrl({
    lat: 45.75,
    lng: 4.85,
    query: "1 rue Example, Lyon",
  });
  assert.equal(url, googleMapsSearchUrl("1 rue Example, Lyon"));
  assert.doesNotMatch(url, /map_action=pano/);
});

test("googleMapsListingUrl recherche par coordonnées sans adresse", () => {
  const url = googleMapsListingUrl({ lat: 45.75, lng: 4.85, query: "" });
  assert.equal(url, googleMapsSearchUrl("45.75,4.85"));
});

test("googleMapsListingUrl retombe sur la recherche sans coordonnées", () => {
  const url = googleMapsListingUrl({ lat: null, lng: null, query: "Lyon" });
  assert.equal(url, googleMapsSearchUrl("Lyon"));
});

test("resolveGoogleMapsListingUrl : Street View si metadata OK", async () => {
  const url = await resolveGoogleMapsListingUrl(
    { lat: 48.85, lng: 2.21, query: "5 Rue de Test 75011 Paris" },
    {
      apiKey: "test-key",
      metadataFetcher: async () => ({
        status: "OK",
        pano_id: "abc123",
        location: { lat: 48.8501, lng: 2.2102 },
      }),
    }
  );
  assert.match(url, /pano=abc123/);
});

test("resolveGoogleMapsListingUrl : recherche si aucune imagery", async () => {
  const url = await resolveGoogleMapsListingUrl(
    { lat: 48.85, lng: 2.21, query: "Lyon" },
    {
      apiKey: "test-key",
      metadataFetcher: async () => ({ status: "ZERO_RESULTS" }),
    }
  );
  assert.equal(url, googleMapsSearchUrl("Lyon"));
});

test("resolveGoogleMapsListingUrl : recherche sans clé API", async () => {
  const url = await resolveGoogleMapsListingUrl({
    lat: 48.85,
    lng: 2.21,
    query: "Lyon",
  });
  assert.equal(url, googleMapsSearchUrl("Lyon"));
});
