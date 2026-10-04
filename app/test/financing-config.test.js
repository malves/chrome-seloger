import test from "node:test";
import assert from "node:assert/strict";
import config from "../src/config.js";
import { openDatabase } from "../src/db.js";
import createRepositories from "../src/repositories/index.js";
import {
  loadFinancingRates,
  readAdminFinancingForm,
  saveFinancingRates,
} from "../src/services/financing-config.service.js";

test("les taux admin remplacent les valeurs runtime et persistent", () => {
  const db = openDatabase(":memory:");
  const repositories = createRepositories(db);
  try {
    loadFinancingRates(repositories);
    const current = {
      notaryRateOld: config.financing.notaryRateOld,
      notaryRateNew: config.financing.notaryRateNew,
      guaranteeRate: config.financing.guaranteeRate,
      interestRate: config.financing.interestRate,
      insuranceRate: config.financing.insuranceRate,
      years: config.financing.years,
      debtRatio: config.financing.debtRatio,
    };

    const rates = readAdminFinancingForm(
      {
        notary_rate_old: "7,5",
        notary_rate_new: "2",
        guarantee_rate: "1,2",
        interest_rate: "3,1",
        insurance_rate: "0,25",
        years: "20",
        debt_ratio: "33",
      },
      current
    );

    saveFinancingRates(repositories, rates);
    assert.equal(config.financing.notaryRateOld, 0.075);
    assert.equal(config.financing.years, 20);
    assert.equal(config.financing.debtRatio, 0.33);

    config.financing.notaryRateOld = 0.99;
    loadFinancingRates(repositories);
    assert.equal(config.financing.notaryRateOld, 0.075);
  } finally {
    db.close();
  }
});
