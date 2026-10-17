import test from "node:test";
import assert from "node:assert/strict";
import config from "../src/config.js";
import { createTestApp, createUser, listingPayload, loginAgent } from "./helpers.js";
import createListingsService from "../src/services/listings.service.js";
import {
  PROBABLE_LOCATION_PROVIDER,
  probableLocationCachePayload,
} from "../src/lib/probable-location-cache.js";

async function setup(t, { email = "a@example.com" } = {}) {
  const ctx = createTestApp();
  t.after(() => ctx.close());
  const user = await createUser(ctx.repositories, email);
  const service = createListingsService({ repositories: ctx.repositories });
  const { id } = service.save(
    user,
    listingPayload({ city: "Levallois-Perret", postal_code: "92300" })
  );
  const listing = ctx.repositories.listings.findById(user.id, id);
  const agent = await loginAgent(ctx.app, email);
  return { ...ctx, user, listing, agent };
}

test("diagnostic zone probable : interdit aux non-admins, HTML admin avec contraintes", async (t) => {
  const { agent, listing } = await setup(t);
  await agent.get(`/listings/${listing.id}/location/debug`).expect(403);

  const adminEmail = config.adminEmails[0];
  const ctx = await setup(t, { email: adminEmail });
  ctx.repositories.enrichments.saveListingResult(ctx.listing.id, PROBABLE_LOCATION_PROVIDER, {
    status: "ok",
    data: probableLocationCachePayload(ctx.listing, {
      status: "estimated",
      confidence: 0.72,
      center: { latitude: 48.89, longitude: 2.28 },
      estimated_radius_m: 450,
      constraints_used: 1,
      constraints_rejected: 0,
      constraints: [
        {
          place: "métro Anatole France",
          place_type: "transit",
          relation: "near",
          rejected: false,
        },
      ],
      heatmap: [{ lat: 48.89, lng: 2.28, score: 0.9 }],
      top_candidates: [{ latitude: 48.89, longitude: 2.28, score: 0.9 }],
      warnings: [],
    }),
  });

  const page = await ctx.agent.get(`/listings/${ctx.listing.id}`).expect(200);
  assert.match(page.text, /data-location-probable-debug-open/);

  const debug = await ctx.agent.get(`/listings/${ctx.listing.id}/location/debug`).expect(200);
  assert.match(debug.text, /Lieux cités/);
  assert.match(debug.text, /métro Anatole France/);
  assert.match(debug.text, /zone indicative/);
});
