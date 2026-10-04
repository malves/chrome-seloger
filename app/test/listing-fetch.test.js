import test from "node:test";
import assert from "node:assert/strict";
import createListingFetchService, {
  parseListingHtml,
  isListingDetailUrl,
  sourceForHostname,
} from "../src/services/listing-fetch.service.js";

const SELOGER_URL = "https://www.seloger.com/annonce/26Q9YCW4ZDUN";
const LBC_URL = "https://www.leboncoin.fr/ad/ventes_immobilieres/1234567890";

const SELOGER_HTML = `
<!doctype html><html><head>
<meta property="og:title" content="Vue OG" />
<meta property="og:image" content="https://img.example.com/og.jpg" />
<script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Residence",
  name: "Maison 5 pièces 120 m²",
  description: "Belle maison familiale.",
  image: ["https://img.example.com/1.jpg", "https://img.example.com/2.jpg"],
  offers: { "@type": "Offer", price: "385000", priceCurrency: "EUR" },
  floorSize: { "@type": "QuantitativeValue", value: "120" },
  address: {
    "@type": "PostalAddress",
    addressLocality: "Rambouillet",
    postalCode: "78120",
  },
})}
</script>
</head><body><h1>Maison 5 pièces</h1></body></html>`;

const LBC_HTML = `
<!doctype html><html><head>
<script id="__NEXT_DATA__" type="application/json">
${JSON.stringify({
  props: {
    pageProps: {
      ad: {
        list_id: 1234567890,
        subject: "Appartement T3 lumineux",
        body: "Beau T3.",
        price: [250000],
        category_id: 9,
        attributes: [
          { key: "square", value: "65" },
          { key: "rooms", value: "3" },
          { key: "nb_bedrooms", value: "2" },
          { key: "real_estate_type", value: "2" },
        ],
        images: { urls_large: ["https://img.lbc/1.jpg"] },
        location: {
          city_label: "Lyon 69003",
          zipcode: "69003",
          lat: 45.75,
          lng: 4.85,
        },
        owner: { type: "pro", name: "Agence X" },
      },
    },
  },
})}
</script>
</head><body></body></html>`;

/* ----------------------------- Détection ------------------------------- */

test("sourceForHostname reconnaît les trois sites", () => {
  assert.equal(sourceForHostname("www.seloger.com"), "seloger");
  assert.equal(sourceForHostname("m.bellesdemeures.com"), "bellesdemeures");
  assert.equal(sourceForHostname("www.leboncoin.fr"), "leboncoin");
  assert.equal(sourceForHostname("example.com"), null);
});

test("isListingDetailUrl distingue fiche et page de résultats", () => {
  assert.equal(isListingDetailUrl(SELOGER_URL), true);
  assert.equal(isListingDetailUrl(LBC_URL), true);
  assert.equal(isListingDetailUrl("https://www.seloger.com/"), false);
  assert.equal(
    isListingDetailUrl("https://www.seloger.com/list.htm?types=1"),
    false
  );
  assert.equal(isListingDetailUrl("http://www.seloger.com/annonce/1.htm"), false);
  assert.equal(isListingDetailUrl("https://autre-site.fr/annonce/1"), false);
});

/* ------------------------------ Parsing -------------------------------- */

test("parseListingHtml lit le JSON-LD d'une annonce SeLoger", () => {
  const payload = parseListingHtml(SELOGER_HTML, SELOGER_URL);
  assert.ok(payload);
  assert.equal(payload.source, "seloger");
  assert.equal(payload.url, SELOGER_URL);
  assert.equal(payload.title, "Maison 5 pièces 120 m²");
  assert.equal(payload.price, 385000);
  assert.equal(payload.surface, 120);
  assert.equal(payload.rooms, 5);
  assert.equal(payload.property_type, "house");
  assert.equal(payload.location.city, "Rambouillet");
  assert.equal(payload.location.postal_code, "78120");
  assert.ok(payload.photos.includes("https://img.example.com/1.jpg"));
  assert.equal(payload.source_id, "26Q9YCW4ZDUN");
});

test("parseListingHtml lit l'étage SeLoger dans le JSON embarqué UFRN", () => {
  const html = `${SELOGER_HTML}<script>window["__UFRN_LIFECYCLE_SERVERREQUEST__"]=JSON.parse("{\\"app_cldp\\":{\\"data\\":{\\"classified\\":{\\"sections\\":{\\"hardFacts\\":{\\"facts\\":[{\\"type\\":\\"numberOfFloors\\",\\"value\\":\\"Étage 7/7\\",\\"label\\":\\"7/7\\"}]}}}}}}");</script>`;
  const payload = parseListingHtml(html, SELOGER_URL);
  assert.equal(payload.floor, 7);
});

test("parseListingHtml lit __NEXT_DATA__ d'une annonce Leboncoin", () => {
  const payload = parseListingHtml(LBC_HTML, LBC_URL);
  assert.ok(payload);
  assert.equal(payload.source, "leboncoin");
  assert.equal(payload.title, "Appartement T3 lumineux");
  assert.equal(payload.price, 250000);
  assert.equal(payload.surface, 65);
  assert.equal(payload.rooms, 3);
  assert.equal(payload.bedrooms, 2);
  assert.equal(payload.property_type, "apartment");
  assert.equal(payload.transaction_type, "sale");
  assert.equal(payload.location.city, "Lyon");
  assert.equal(payload.source_id, "1234567890");
});

test("parseListingHtml retourne null sans titre, prix ni photo", () => {
  const html = "<html><head></head><body></body></html>";
  assert.equal(parseListingHtml(html, SELOGER_URL), null);
});

/* ------------------------- Service (fetch mocké) ----------------------- */

function withFetch(fakeFetch, run) {
  const original = global.fetch;
  global.fetch = fakeFetch;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      global.fetch = original;
    });
}

test("fetchAndParse réussit sur une fiche SeLoger", async () => {
  const service = createListingFetchService({ logger: null });
  await withFetch(
    async () =>
      new Response(SELOGER_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    async () => {
      const result = await service.fetchAndParse(SELOGER_URL);
      assert.equal(result.ok, true);
      assert.equal(result.payload.price, 385000);
    }
  );
});

test("fetchAndParse refuse un hôte non supporté sans appel réseau", async () => {
  const service = createListingFetchService({ logger: null });
  let called = false;
  await withFetch(
    async () => {
      called = true;
      return new Response("", { status: 200 });
    },
    async () => {
      const result = await service.fetchAndParse("https://example.com/x");
      assert.equal(result.ok, false);
      assert.equal(result.reason, "unsupported_host");
      assert.equal(called, false);
    }
  );
});

test("fetchAndParse signale un blocage anti-bot sur un 403", async () => {
  const service = createListingFetchService({ logger: null });
  await withFetch(
    async () => new Response("blocked", { status: 403 }),
    async () => {
      const result = await service.fetchAndParse(SELOGER_URL);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "blocked");
    }
  );
});

test("fetchAndParse rejette une URL hors fiche", async () => {
  const service = createListingFetchService({ logger: null });
  const result = await service.fetchAndParse("https://www.seloger.com/");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_listing");
});
