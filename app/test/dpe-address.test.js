import test from "node:test";
import assert from "node:assert/strict";
import {
  dpeAddressKey,
  dpeMapsQuery,
  dpeStreetLine,
  extractCivicNumberFromBrut,
} from "../src/lib/dpe-address.js";

test("extractCivicNumberFromBrut : numéro seul ou avec bis", () => {
  assert.equal(extractCivicNumberFromBrut("118"), "118");
  assert.equal(extractCivicNumberFromBrut("  12 bis  "), "12 bis");
  assert.equal(extractCivicNumberFromBrut("118 Rue Guerard"), "118");
  assert.equal(extractCivicNumberFromBrut(""), null);
  assert.equal(extractCivicNumberFromBrut(null), null);
});

test("dpeStreetLine : numéro BAN manquant, repris depuis adresse_brut (open data)", () => {
  const record = {
    numero_dpe: "2692E1509467E",
    adresse_ban: "Rue Gérhard 92800 Puteaux",
    adresse_brut: "118 Rue Guerard",
    code_postal_ban: "92800",
    nom_commune_ban: "Puteaux",
    raw: { nom_rue_ban: "Rue Gérhard" },
  };
  assert.equal(dpeStreetLine(record), "118 Rue Gérhard");
});

test("dpeStreetLine : numéro BAN manquant, repris depuis numero_voie_brut", () => {
  const record = {
    numero_dpe: "2692E1509467E",
    adresse_ban: "Rue Gérhard 92800 Puteaux",
    adresse_brut: "118 Rue Guerard",
    code_postal_ban: "92800",
    nom_commune_ban: "Puteaux",
    raw: {
      nom_rue_ban: "Rue Gérhard",
      numero_voie_ban: "",
      numero_voie_brut: "118",
    },
  };
  assert.equal(dpeStreetLine(record), "118 Rue Gérhard");
  assert.equal(
    dpeMapsQuery(record),
    "118 Rue Gérhard, 92800, Puteaux"
  );
  assert.equal(
    dpeAddressKey(record),
    "118 Rue Gérhard 92800 Puteaux"
  );
});

test("dpeStreetLine : numero_voie_ban renseigné", () => {
  const record = {
    adresse_ban: "Rue A 75011 Paris",
    code_postal_ban: "75011",
    nom_commune_ban: "Paris",
    raw: { numero_voie_ban: "5", nom_rue_ban: "Rue A" },
  };
  assert.equal(dpeStreetLine(record), "5 Rue A");
});

test("dpeStreetLine : pas de voie BAN → adresse brute", () => {
  const record = {
    adresse_ban: null,
    adresse_brut: "10 Rue Saisie 75011 Paris",
    raw: {},
  };
  assert.equal(dpeStreetLine(record), "10 Rue Saisie 75011 Paris");
});
