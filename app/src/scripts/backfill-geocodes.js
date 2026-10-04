/**
 * Remplit lat/lng des adresses du carnet encore sans coordonnées (BAN / ORS).
 * Usage : node src/scripts/backfill-geocodes.js
 */

import { openDatabase } from "../db.js";
import createRepositories from "../repositories/index.js";
import createTravelService from "../services/travel.service.js";
import { normalizeAddressKey } from "../lib/address-normalize.js";

const db = openDatabase();
const repositories = createRepositories(db);
const travel = createTravelService({ logger: console });

const rows = db
  .prepare("SELECT id, user_id, address, lat, lng FROM addresses WHERE lat IS NULL OR lng IS NULL")
  .all();

let updated = 0;
for (const row of rows) {
  let lat = row.lat;
  let lng = row.lng;

  const key = normalizeAddressKey(row.address);
  if (key) {
    const siblings = db
      .prepare(
        "SELECT lat, lng, address FROM addresses WHERE user_id = ? AND lat IS NOT NULL AND lng IS NOT NULL"
      )
      .all(row.user_id);
    const match = siblings.find((s) => normalizeAddressKey(s.address) === key);
    if (match) {
      lat = match.lat;
      lng = match.lng;
    }
  }

  if (lat == null || lng == null) {
    const geo = await travel.geocodeAddress(row.address);
    if (geo) {
      lat = geo.lat;
      lng = geo.lon;
    }
  }

  if (lat != null && lng != null) {
    const current = repositories.addresses.findById(row.user_id, row.id);
    repositories.addresses.update({
      id: row.id,
      userId: row.user_id,
      label: current.label,
      address: current.address,
      lat,
      lng,
    });
    updated += 1;
    console.log(`OK #${row.id}: ${row.address.slice(0, 60)}`);
  } else {
    console.warn(`SKIP #${row.id}: ${row.address.slice(0, 60)}`);
  }
}

console.log(`Terminé : ${updated}/${rows.length} adresse(s) localisée(s).`);
db.close();
