import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeUfrnPayloadFromScript,
  energyDetailsFromSeLogerSections,
  euroFormattedToInteger,
  resolveSeLogerSalePrice,
  salePriceFromSeLogerSections,
  ufrnClassifiedSectionsFromHtml,
  ufrnPayloadFromHtml,
} from "../src/lib/seloger-ufrn.js";
import { parseListingHtml } from "../src/services/listing-fetch.service.js";

const SECTIONS_FIXTURE = {
  features: {
    preview: [
      { icon: "floors", value: "3ème étage/1 étage" },
      { icon: "kitchen", value: "Cuisine séparée" },
      { icon: "elevator", value: "Ascenseur" },
      { icon: "cellar", value: "Cave (Total 5,3 m²)" },
      { icon: "parking", value: "Box de stationnement" },
      { icon: "toilet", value: "1 WC" },
      { icon: "balcony", value: "Balcon (Total 16,8 m²)" },
      { value: "Exposition: est" },
    ],
  },
  energy: {
    features: [
      { type: "yearOfConstruction", label: "Année de construction", value: "1970" },
      { type: "state", label: "État", value: "Rénovation nécessaire" },
      {
        type: "heatingSystem",
        label: "Type de chauffage",
        value: "Chauffage central: Radiateur",
      },
      { type: "energySource", label: "Sources d'énergie", value: "Gaz" },
      { type: "unknownFutureType", label: "Isolation", value: "Double vitrage" },
    ],
  },
};

function escapeForJsonParseString(jsonObject) {
  return JSON.stringify(JSON.stringify(jsonObject))
    .slice(1, -1)
    .replace(/\\"/g, '\\"');
}

function ufrnScriptHtml(sections, { useScriptId = false } = {}) {
  const payload = {
    app_cldp: { data: { classified: { sections } } },
  };
  const escaped = escapeForJsonParseString(payload);
  const body = `window["__UFRN_LIFECYCLE_SERVERREQUEST__"]=JSON.parse("${escaped}");`;
  if (useScriptId) {
    return `<script id="__UFRN_LIFECYCLE_SERVERREQUEST__">${body}</script>`;
  }
  return `<script>${body}</script>`;
}

const SALE_PRICE_SECTIONS = {
  price: {
    base: {
      type: "SALE",
      main: {
        label: { main: "Prix du bien" },
        value: {
          main: { value: "145 000 €" },
          alt: { value: "4 880,51 €/m²" },
        },
      },
      "9f3c2a1b-uuid-notaire": {
        label: { main: "Frais de notaire estimés (8%)" },
        value: { main: { value: "12 800 €" } },
      },
      "7e8d-project": {
        label: { main: "Montant estimé du projet" },
        value: { main: { value: "180 000 €" } },
      },
    },
  },
};

test("energyDetailsFromSeLogerSections : une colonne par type connu", () => {
  assert.deepEqual(energyDetailsFromSeLogerSections(SECTIONS_FIXTURE), {
    property_condition: "Rénovation nécessaire",
    heating_system: "Chauffage central: Radiateur",
    energy_source: "Gaz",
  });
  assert.deepEqual(energyDetailsFromSeLogerSections({}), {});
});

test("ufrnClassifiedSectionsFromHtml lit le script embarqué", () => {
  const html = ufrnScriptHtml(SECTIONS_FIXTURE);
  const sections = ufrnClassifiedSectionsFromHtml(html);
  assert.ok(sections?.features);
});

test("decodeUfrnPayloadFromScript gère JSON.parse échappé", () => {
  const html = ufrnScriptHtml(SALE_PRICE_SECTIONS, { useScriptId: true });
  const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  const payload = decodeUfrnPayloadFromScript(match[1]);
  assert.equal(
    payload?.app_cldp?.data?.classified?.sections?.price?.base?.type,
    "SALE"
  );
});

test("euroFormattedToInteger : montants formatés et JSON-LD numériques", () => {
  assert.equal(euroFormattedToInteger("145 000 €"), 145000);
  assert.equal(euroFormattedToInteger("385000"), 385000);
  assert.equal(euroFormattedToInteger("4 880,51 €/m²"), 4880);
});

test("resolveSeLogerSalePrice : JSON-LD prioritaire", () => {
  const resolved = resolveSeLogerSalePrice({
    jsonLdPrice: "385000",
    sections: SALE_PRICE_SECTIONS,
  });
  assert.deepEqual(resolved, {
    price: 385000,
    formatted: null,
    pricePerM2Formatted: null,
    source: "json_ld",
    status: "ok",
  });
});

test("resolveSeLogerSalePrice : offers.price vide → UFRN", () => {
  const resolved = resolveSeLogerSalePrice({
    jsonLdPrice: "",
    sections: SALE_PRICE_SECTIONS,
  });
  assert.equal(resolved.price, 145000);
  assert.equal(resolved.formatted, "145 000 €");
  assert.equal(resolved.pricePerM2Formatted, "4 880,51 €/m²");
  assert.equal(resolved.source, "ufrn");
  assert.equal(resolved.status, "ok");
});

test("salePriceFromSeLogerSections : clé UUID variable pour Prix du bien", () => {
  const sections = {
    price: {
      base: {
        type: "SALE",
        "26Z62KFYMKMM-node": {
          label: { main: "Prix du bien" },
          value: {
            main: { value: "145 000 €" },
            alt: { value: "4 880,51 €/m²" },
          },
        },
      },
    },
  };
  const row = salePriceFromSeLogerSections(sections);
  assert.equal(row?.price, 145000);
});

test("resolveSeLogerSalePrice : ignore frais de notaire et projet", () => {
  const sections = {
    price: {
      base: {
        type: "SALE",
        "only-notary": {
          label: { main: "Frais de notaire estimés (8%)" },
          value: { main: { value: "12 800 €" } },
        },
      },
    },
  };
  const resolved = resolveSeLogerSalePrice({ jsonLdPrice: "", sections });
  assert.equal(resolved.price, null);
  assert.equal(resolved.status, "price_not_found");
});

test("resolveSeLogerSalePrice : script UFRN absent", () => {
  const resolved = resolveSeLogerSalePrice({ jsonLdPrice: "", sections: null });
  assert.equal(resolved.price, null);
  assert.equal(resolved.status, "ufrn_script_missing");
});

test("parseListingHtml : JSON-LD vide et prix UFRN dans le script", () => {
  const url = "https://www.seloger.com/annonce/26Z62KFYMKMM";
  const html = `<!doctype html><html><head>
<meta property="og:title" content="Appartement Nanterre" />
<meta property="og:image" content="https://img.example.com/og.jpg" />
<script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "RealEstateListing",
  name: "Appartement Nanterre",
  offers: { "@type": "Offer", price: "", priceCurrency: "EUR" },
})}
</script>
</head><body>${ufrnScriptHtml(SALE_PRICE_SECTIONS)}</body></html>`;

  const payload = parseListingHtml(html, url);
  assert.ok(payload);
  assert.equal(payload.price, 145000);
  assert.equal(payload.raw?.price_capture?.source, "ufrn");
  assert.equal(payload.raw?.price_capture?.status, "ok");
  assert.equal(payload.raw?.price_capture?.formatted, "145 000 €");
});
