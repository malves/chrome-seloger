/**
 * Correction inline des caractéristiques depuis la fiche annonce.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createTestApp,
  createUser,
  extractCsrf,
  listingPayload,
  loginAgent,
} from "./helpers.js";
import createListingsService from "../src/services/listings.service.js";
import createVisitSheetService from "../src/services/visit-sheet.service.js";
import { euro as fmtEuro, surface as fmtSurface } from "../src/lib/format.js";

const DESCRIPTION =
  "Bel appartement. Charges de copropriété : 1 800 €/an. Taxe foncière : 1 200 €.";

async function setup(t, overrides = {}) {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const email = "field-edit@example.com";
  const user = await createUser(ctx.repositories, email);
  const service = createListingsService({ repositories: ctx.repositories });
  const { id } = service.save(
    user,
    listingPayload({
      title: "Appartement",
      property_type: "apartment",
      surface: 120,
      rooms: 4,
      price: 300000,
      description: DESCRIPTION,
      ...overrides,
    })
  );
  const listing = ctx.repositories.listings.findById(user.id, id);
  const agent = await loginAgent(ctx.app, email);
  const page = await agent.get(`/listings/${id}`).expect(200);
  return { ...ctx, user, listing, agent, page, csrf: extractCsrf(page.text), id };
}

const patchField = (agent, id, fieldKey, csrf, value) =>
  agent
    .patch(`/listings/${id}/fields/${fieldKey}`)
    .set("X-CSRF-Token", csrf)
    .set("Accept", "application/json")
    .send({ value });

test("PATCH surface : valeur valide → provenance utilisateur sur la fiche", async (t) => {
  const { agent, id, csrf } = await setup(t);
  const res = await patchField(agent, id, "surface", csrf, 95).expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.resolved.value, 95);

  const page = await agent.get(`/listings/${id}`).expect(200);
  assert.match(page.text, /visit-source--user/);
  assert.ok(page.text.includes(fmtSurface(95)));
  assert.match(page.text, /data-listing-field-label/);
});

test("PATCH surface : abc → 422, annonce inchangée", async (t) => {
  const { agent, id, csrf, listing, repositories } = await setup(t);
  await patchField(agent, id, "surface", csrf, "abc").expect(422);

  const row = repositories.visitOverrides.find(listing.id);
  assert.equal(row, null);
});

test("PATCH : annonce d'un autre compte → 404", async (t) => {
  const { app, listing, repositories, id } = await setup(t);
  await createUser(repositories, "autre@example.com");
  const other = await loginAgent(app, "autre@example.com");
  const page = await other.get("/listings").expect(200);
  await patchField(other, id, "surface", extractCsrf(page.text), 95).expect(404);
});

test("PATCH : CSRF requis", async (t) => {
  const { agent, id } = await setup(t);
  await agent.patch(`/listings/${id}/fields/surface`).send({ value: 95 }).expect(403);
});

test("correction listing appliquée sans consentement visite", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const user = await createUser(ctx.repositories, "merge@example.com");
  const listings = createListingsService({ repositories: ctx.repositories });
  const visitSheet = createVisitSheetService({ repositories: ctx.repositories });
  const { id } = listings.save(user, listingPayload({ surface: 120 }));
  const listing = ctx.repositories.listings.findById(user.id, id);

  visitSheet.patchListingField(listing, "surface", 99, {
    descriptionFacts: {},
  });
  const overrides = visitSheet.appliedOverrides(listing);
  assert.equal(overrides.surface.value, 99);
  assert.equal(overrides.surface.origin, "listing");
});

test("saveSheet visite conserve une correction listing sur un autre champ", async (t) => {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const user = await createUser(ctx.repositories, "merge2@example.com");
  const listings = createListingsService({ repositories: ctx.repositories });
  const visitSheet = createVisitSheetService({ repositories: ctx.repositories });
  const { id } = listings.save(
    user,
    listingPayload({ surface: 120, rooms: 4, description: DESCRIPTION })
  );
  const listing = ctx.repositories.listings.findById(user.id, id);

  visitSheet.patchListingField(listing, "charges_copro", 1500, {
    descriptionFacts: {},
  });

  visitSheet.saveSheet(listing, {
    visit: {
      applyToSheet: false,
      answers: { rooms: { response: "yes", value: 4 } },
    },
  });

  const sheet = visitSheet.getSheet(listing);
  assert.equal(sheet.fields.charges_copro.value, 1500);
  assert.equal(sheet.fields.charges_copro.origin, "listing");
});

test("PATCH charges_copro : xyz → 422", async (t) => {
  const { agent, id, csrf } = await setup(t);
  await patchField(agent, id, "charges_copro", csrf, "xyz").expect(422);
});

test("PATCH price : champ non modifiable depuis la fiche → 422", async (t) => {
  const { agent, id, csrf } = await setup(t);
  await patchField(agent, id, "price", csrf, 250000).expect(422);
});

test("fiche : toutes les caractéristiques ont une source, le prix sans édition", async (t) => {
  const { page } = await setup(t);
  assert.match(page.text, /visit-source--computed/);
  assert.match(page.text, /id="listing-spec-price"/);
  assert.doesNotMatch(page.text, /data-field-key="price"/);

  const start = page.text.indexOf('id="listing-specs"');
  const section = page.text.slice(start, page.text.indexOf("</section>", start));
  const rows = section.split('<div class="kv__row"').slice(1);
  assert.ok(rows.length > 5);
  for (const row of rows) {
    assert.match(row, /class="visit-source visit-source--/);
  }
});

test("PATCH surface (htmx) : le prix au m² est rafraîchi en OOB", async (t) => {
  const { agent, id, csrf } = await setup(t);
  const res = await agent
    .patch(`/listings/${id}/fields/surface`)
    .set("X-CSRF-Token", csrf)
    .set("HX-Request", "true")
    .send({ value: 150 })
    .expect(200);
  assert.match(res.text, /id="listing-spec-surface"/);
  assert.match(res.text, /id="listing-spec-price_per_m2" hx-swap-oob="true"/);
  assert.ok(res.text.includes(`${fmtEuro(2000)} / m²`));
});
