import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp, createUser, loginAgent, extractCsrf } from "./helpers.js";

const SELOGER_URL = "https://www.seloger.com/annonce/26Q9YCW4ZDUN";

const SELOGER_HTML = `
<!doctype html><html><head>
<script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Residence",
  name: "Maison 5 pièces 120 m²",
  description: "Belle maison familiale.",
  image: ["https://img.example.com/1.jpg"],
  offers: { "@type": "Offer", price: "385000" },
  floorSize: { "@type": "QuantitativeValue", value: "120" },
  address: {
    "@type": "PostalAddress",
    addressLocality: "Rambouillet",
    postalCode: "78120",
  },
})}
</script>
</head><body><h1>Maison 5 pièces</h1></body></html>`;

function withApp(name, fn) {
  test(name, async (t) => {
    const ctx = createTestApp();
    t.after(() => ctx.close());
    await fn(ctx, t);
  });
}

async function setupAgent(ctx) {
  await createUser(ctx.repositories, "a@example.com");
  const agent = await loginAgent(ctx.app, "a@example.com");
  const page = await agent.get("/listings").expect(200);
  return { agent, csrf: extractCsrf(page.text) };
}

function withFetch(fakeFetch, run) {
  const original = global.fetch;
  global.fetch = fakeFetch;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      global.fetch = original;
    });
}

withApp("preview puis import crée l'annonce par URL", async (ctx) => {
  const { agent, csrf } = await setupAgent(ctx);

  await withFetch(
    async () =>
      new Response(SELOGER_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    async () => {
      const preview = await agent
        .post("/listings/preview")
        .set("X-CSRF-Token", csrf)
        .send({ url: SELOGER_URL })
        .expect(200);

      assert.equal(preview.body.ok, true);
      assert.ok(preview.body.token);
      assert.equal(preview.body.preview.price, 385000);
      assert.equal(preview.body.preview.city, "Rambouillet");

      const imported = await agent
        .post("/listings/import")
        .set("X-CSRF-Token", csrf)
        .send({ token: preview.body.token, project_ids: [] })
        .expect(200);

      assert.equal(imported.body.ok, true);
      assert.equal(imported.body.created, true);
      assert.match(imported.body.web_url, /^\/listings\/\d+$/);

      const user = ctx.repositories.users.findByEmail("a@example.com");
      const listing = ctx.repositories.listings.findById(user.id, imported.body.id);
      assert.ok(listing);
      assert.equal(listing.price, 385000);
      assert.equal(listing.source, "seloger");
    }
  );
});

withApp("preview signale un hôte non supporté", async (ctx) => {
  const { agent, csrf } = await setupAgent(ctx);
  const res = await agent
    .post("/listings/preview")
    .set("X-CSRF-Token", csrf)
    .send({ url: "https://example.com/annonce/1" })
    .expect(200);

  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, "unsupported_host");
});

withApp("import avec un jeton inconnu est refusé", async (ctx) => {
  const { agent, csrf } = await setupAgent(ctx);
  const res = await agent
    .post("/listings/import")
    .set("X-CSRF-Token", csrf)
    .send({ token: "inexistant", project_ids: [] })
    .expect(410);

  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, "expired");
});

withApp("preview exige le jeton CSRF", async (ctx) => {
  const { agent } = await setupAgent(ctx);
  await agent.post("/listings/preview").send({ url: SELOGER_URL }).expect(403);
});
