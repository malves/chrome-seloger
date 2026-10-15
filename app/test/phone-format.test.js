import test from "node:test";
import assert from "node:assert/strict";
import { formatPhone, isPhoneComplete, phoneDigits } from "../src/lib/phone-format.js";
import { readProfileForm } from "../src/services/settings.service.js";

test("formatPhone espace un mobile français", () => {
  assert.equal(formatPhone("0610936557"), "06 10 93 65 57");
  assert.equal(formatPhone("06 10 93 65 57"), "06 10 93 65 57");
});

test("formatPhone gère +33", () => {
  assert.equal(formatPhone("+33610936557"), "+33 6 10 93 65 57");
});

test("isPhoneComplete accepte vide ou numéro complet", () => {
  assert.equal(isPhoneComplete(""), true);
  assert.equal(isPhoneComplete("06 12"), false);
  assert.equal(isPhoneComplete("06 12 34 56 78"), true);
});

test("readProfileForm enregistre un profil optionnel", () => {
  const ok = readProfileForm({
    first_name: " Marie ",
    last_name: "Dupont",
    phone: "0612345678",
  });
  assert.equal(ok.error, null);
  assert.deepEqual(ok.profile, {
    firstName: "Marie",
    lastName: "Dupont",
    phone: "06 12 34 56 78",
  });
});

test("readProfileForm refuse un téléphone incomplet", () => {
  const bad = readProfileForm({ phone: "06 12" });
  assert.match(bad.error, /incomplet/);
  assert.equal(phoneDigits(bad.profile.phone).length, 4);
});
