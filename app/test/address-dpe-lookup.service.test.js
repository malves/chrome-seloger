import test from "node:test";
import assert from "node:assert/strict";
import createAddressDpeLookupService from "../src/services/address-dpe-lookup.service.js";

function dpe(overrides = {}) {
  const { raw, ...columns } = overrides;
  return {
    numero_dpe: "DPE-" + Math.random().toString(36).slice(2),
    adresse_ban: null,
    adresse_brut: null,
    code_postal_ban: "92800",
    nom_commune_ban: "Puteaux",
    type_batiment: "appartement",
    surface_habitable_logement: null,
    etiquette_dpe: null,
    etiquette_ges: null,
    date_etablissement_dpe: "2024-01-01",
    ...columns,
    raw: raw || {},
  };
}

/** Repo factice : mêmes filtres que les requêtes SQL. */
function stubRepositories(records) {
  return {
    dpe: {
      addressLookupRows({ codePostal, digits }) {
        return records.filter((r) => {
          if (r.code_postal_ban !== codePostal) return false;
          if (!digits) return true;
          const starts = (v) => new RegExp(`^${digits}(?!\\d)`).test(v || "");
          return starts(r.adresse_ban) || starts(r.adresse_brut) || !/^\d/.test(r.adresse_ban || "");
        });
      },
      findManyByNumero(numeros) {
        return records.filter((r) => numeros.includes(r.numero_dpe));
      },
      findAddressCandidates(numeros, { typeBatiments, surfaceMin, surfaceMax }) {
        return records.filter((r) => {
          if (!numeros.includes(r.numero_dpe) || !typeBatiments.includes(r.type_batiment)) return false;
          if (surfaceMin == null || r.type_batiment === "immeuble") return true;
          const s = r.surface_habitable_logement;
          return s >= surfaceMin && s <= surfaceMax;
        });
      },
    },
  };
}

const LISTING = {
  id: 43,
  property_type: "apartment",
  postal_code: "92800",
  surface: 61,
  dpe: "E",
};

const GERHARD = {
  adresse_ban: "Rue Gérhard 92800 Puteaux",
  adresse_brut: "118 Rue Guerard",
};

function lookup(records, street, listing = LISTING) {
  const service = createAddressDpeLookupService({ repositories: stubRepositories(records) });
  return service.lookup(listing, { street, postalCode: "92800", city: "Puteaux" });
}

test("adresse identique à la BAN + logement conforme à l'annonce → association silencieuse", () => {
  const target = dpe({ ...GERHARD, numero_dpe: "2692E1509467E", surface_habitable_logement: 61.1, etiquette_dpe: "E" });
  const result = lookup([target], "118 rue gerhard");
  assert.equal(result.status, "match");
  assert.equal(result.numeroDpe, "2692E1509467E");
  assert.equal(result.street, "118 Rue Gérhard");
});

test("voie BAN sans numéro : les DPE sans numéro de la rue ne rendent pas l'adresse ambiguë", () => {
  const records = [
    dpe({ ...GERHARD, numero_dpe: "CIBLE", surface_habitable_logement: 61.1, etiquette_dpe: "E" }),
    dpe({ adresse_ban: "Rue Gérhard 92800 Puteaux", adresse_brut: "Rue Gérhard", surface_habitable_logement: 33.6, etiquette_dpe: "E" }),
    dpe({ adresse_ban: "Rue Gérhard 92800 Puteaux", adresse_brut: "Rue Gérhard", surface_habitable_logement: 20.1, etiquette_dpe: "E" }),
    dpe({ adresse_ban: "Rue Gérhard 92800 Puteaux", adresse_brut: "120 rue Gerhard", surface_habitable_logement: 59.7, etiquette_dpe: "C" }),
  ];
  const result = lookup(records, "118 Rue Gérhard");
  assert.equal(result.status, "match");
  assert.equal(result.numeroDpe, "CIBLE");

  // Un DPE sans numéro qui ressemble davantage à l'annonce : on demande.
  const doubtful = [
    dpe({ ...GERHARD, surface_habitable_logement: 33, etiquette_dpe: "F" }),
    dpe({ adresse_ban: "Rue Gérhard 92800 Puteaux", adresse_brut: "Rue Gérhard", surface_habitable_logement: 61, etiquette_dpe: "E" }),
  ];
  const asked = lookup(doubtful, "118 Rue Gérhard");
  assert.equal(asked.status, "choose");
  assert.equal(asked.candidates.find((c) => c.numberUnknown).street, "118 Rue Gérhard");
});

test("faute d'orthographe dans la voie → confirmation, voie BAN proposée", () => {
  const target = dpe({ ...GERHARD, surface_habitable_logement: 61.1, etiquette_dpe: "E" });
  const result = lookup([target], "118 rue Guerard");
  assert.equal(result.status, "choose");
  assert.equal(result.reason, "address");
  assert.equal(result.candidates[0].street, "118 Rue Gérhard");
  assert.equal(result.candidates[0].numeroDpe, target.numero_dpe);
});

test("espace manquant ou type de voie oublié → confirmation", () => {
  const records = [
    dpe({ adresse_ban: "5 Rue de la Paix 92800 Puteaux", surface_habitable_logement: 61, etiquette_dpe: "E" }),
  ];
  assert.equal(lookup(records, "5 rue dela Paix").status, "choose");
  assert.equal(lookup(records, "5 de la Paix").status, "choose");
  assert.equal(lookup(records, "5 Rue de la Paix").status, "match");
});

test("immeuble : le logement conforme à l'annonce se détache → association silencieuse", () => {
  const records = [
    dpe({ adresse_ban: "10 Rue Forte 92800 Puteaux", numero_dpe: "BON", surface_habitable_logement: 61, etiquette_dpe: "E" }),
    dpe({ adresse_ban: "10 Rue Forte 92800 Puteaux", surface_habitable_logement: 32, etiquette_dpe: "F" }),
    dpe({ adresse_ban: "10 Rue Forte 92800 Puteaux", surface_habitable_logement: 85, etiquette_dpe: "C" }),
  ];
  const result = lookup(records, "10 rue Forte");
  assert.equal(result.status, "match");
  assert.equal(result.numeroDpe, "BON");
});

test("immeuble : deux logements plausibles → choix du logement", () => {
  const records = [
    dpe({ adresse_ban: "10 Rue Forte 92800 Puteaux", surface_habitable_logement: 61, etiquette_dpe: "E", raw: { complement_adresse_logement: "2e étage" } }),
    dpe({ adresse_ban: "10 Rue Forte 92800 Puteaux", surface_habitable_logement: 61, etiquette_dpe: "E", raw: { complement_adresse_logement: "4e étage" } }),
  ];
  const result = lookup(records, "10 rue Forte");
  assert.equal(result.status, "choose");
  assert.equal(result.reason, "dwelling");
  assert.equal(result.candidates.length, 2);
});

test("un seul DPE à l'adresse mais surface éloignée → confirmation", () => {
  const records = [dpe({ adresse_ban: "10 Rue Forte 92800 Puteaux", surface_habitable_logement: 120, etiquette_dpe: "E" })];
  const result = lookup(records, "10 rue Forte");
  assert.equal(result.status, "choose");
  assert.equal(result.reason, "dwelling");
});

test("même logement re-diagnostiqué : seul le DPE le plus récent est retenu", () => {
  const records = [
    dpe({ adresse_ban: "10 Rue Forte 92800 Puteaux", numero_dpe: "ANCIEN", surface_habitable_logement: 61, etiquette_dpe: "E", date_etablissement_dpe: "2021-03-01" }),
    dpe({ adresse_ban: "10 Rue Forte 92800 Puteaux", numero_dpe: "RECENT", surface_habitable_logement: 61, etiquette_dpe: "E", date_etablissement_dpe: "2025-03-01" }),
  ];
  const result = lookup(records, "10 rue Forte");
  assert.equal(result.status, "match");
  assert.equal(result.numeroDpe, "RECENT");
});

/** La rue Gérhard réelle : la BAN n'a jamais de numéro, la saisie brute si. */
function gerhardStreet() {
  const ban = "Rue Gérhard 92800 Puteaux";
  return [
    dpe({ adresse_ban: ban, adresse_brut: "127 RUE GERHARD", surface_habitable_logement: 62, etiquette_dpe: "D" }),
    dpe({ adresse_ban: ban, adresse_brut: "120 rue Gerhard", surface_habitable_logement: 59.7, etiquette_dpe: "C" }),
    dpe({ adresse_ban: ban, adresse_brut: "122 rue Gerhard", surface_habitable_logement: 60.5, etiquette_dpe: "F" }),
    dpe({ adresse_ban: ban, adresse_brut: "124 rue Gerhard", surface_habitable_logement: 61.5, etiquette_dpe: "D" }),
    dpe({ adresse_ban: ban, adresse_brut: "130 rue Gerhard", surface_habitable_logement: 60, etiquette_dpe: "G" }),
    dpe({ adresse_ban: ban, adresse_brut: "12 rue Gerhard", surface_habitable_logement: 25, etiquette_dpe: "E" }),
    dpe({ adresse_ban: ban, adresse_brut: "118 Rue Guerard", numero_dpe: "CIBLE", surface_habitable_logement: 61.1, etiquette_dpe: "E" }),
  ];
}

test("voie saisie sans numéro → logements de la rue classés selon l'annonce, le bon en tête", () => {
  const result = lookup(gerhardStreet(), "Rue Gérhard");
  assert.equal(result.status, "choose");
  assert.equal(result.reason, "number");
  assert.equal(result.candidates[0].numeroDpe, "CIBLE");
  assert.equal(result.candidates[0].street, "118 Rue Gérhard");
  assert.ok(result.candidates.every((c) => c.surface > 55), "hors fenêtre de surface : écarté");
});

test("BAN mal géocodée : la saisie brute fait foi, sans rendre la voie ambiguë", () => {
  const records = [
    ...gerhardStreet(),
    dpe({ adresse_ban: "39 Rue Voltaire 92800 Puteaux", adresse_brut: "131 Rue Gerhard", numero_dpe: "GEOCODE", surface_habitable_logement: 61, etiquette_dpe: "D" }),
  ];
  const result = lookup(records, "Rue Gérhard");
  assert.equal(result.reason, "number");
  assert.equal(result.candidates[0].numeroDpe, "CIBLE");
  const geocoded = lookup(records, "131 rue Gerhard");
  const own = geocoded.candidates.find((c) => c.numeroDpe === "GEOCODE");
  assert.equal(own.street, "131 Rue Gerhard");
  assert.equal(own.otherNumber, false);
});

test("numéro saisi avec un DPE cohérent → associé, même si un autre numéro correspond aussi", () => {
  const records = [
    dpe({ ...GERHARD, surface_habitable_logement: 61.1, etiquette_dpe: "E" }),
    dpe({ adresse_ban: GERHARD.adresse_ban, adresse_brut: "120 rue Gerhard", numero_dpe: "AU-120", surface_habitable_logement: 61, etiquette_dpe: "E" }),
  ];
  const result = lookup(records, "120 rue Gérhard");
  assert.equal(result.status, "match");
  assert.equal(result.numeroDpe, "AU-120");
});

test("numéro saisi sans DPE cohérent → le logement conforme d'un autre numéro est proposé", () => {
  const records = [
    dpe({ adresse_ban: GERHARD.adresse_ban, adresse_brut: "120 rue Gerhard", numero_dpe: "AU-120", surface_habitable_logement: 33, etiquette_dpe: "F" }),
    dpe({ ...GERHARD, numero_dpe: "CIBLE", surface_habitable_logement: 61.1, etiquette_dpe: "E" }),
  ];
  const result = lookup(records, "120 rue Gérhard");
  assert.equal(result.status, "choose");
  assert.equal(result.candidates[0].numeroDpe, "CIBLE");
  assert.equal(result.candidates[0].otherNumber, true);
  assert.equal(result.candidates[0].street, "118 Rue Gérhard");
  assert.ok(result.candidates.some((c) => c.numeroDpe === "AU-120" && !c.otherNumber));
});

test("autre numéro sans rapport avec l'annonce, ou voie inconnue → aucun DPE", () => {
  const records = [dpe({ adresse_ban: "10 Rue Forte 92800 Puteaux", surface_habitable_logement: 120 })];
  assert.equal(lookup(records, "12 rue Forte").status, "none");
  assert.equal(lookup(records, "10 avenue Foch").status, "none");
  assert.equal(lookup(records, "").status, "none");
});
