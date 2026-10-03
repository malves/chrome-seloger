/**
 * Tableau de financement : calcul local, aucun appel externe.
 *
 * Les paramètres sont ceux du compte, surchargés par ceux déjà enregistrés
 * pour cette annonce depuis la fiche.
 */

import { accountFinancingSettings } from "../settings.service.js";
import {
  financingForListing,
  listingFinancingParams,
} from "../financing.service.js";
import ProviderSkipped from "./skipped.js";

export default {
  key: "financing",
  scope: "listing",
  order: 10,
  ttlDays: 0,
  label: "Financement",

  async fetch({ listing, repositories }) {
    if (listing.transaction_type === "rent") {
      throw new ProviderSkipped(
        "Bien en location : pas de tableau de financement."
      );
    }

    const user = repositories.users.findById(listing.user_id);
    const defaults = accountFinancingSettings(user);
    const stored = repositories.enrichments.findOne(listing.id, "financing");
    const params = listingFinancingParams(listing, defaults, stored?.data);

    return { params, result: financingForListing(listing, params) };
  },
};
