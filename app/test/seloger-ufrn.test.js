import test from "node:test";
import assert from "node:assert/strict";
import {
  energyDetailsFromSeLogerSections,
  ufrnClassifiedSectionsFromHtml,
} from "../src/lib/seloger-ufrn.js";

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
    // Structure réelle observée sur une fiche SeLoger (oct. 2026).
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

test("energyDetailsFromSeLogerSections : une colonne par type connu", () => {
  assert.deepEqual(energyDetailsFromSeLogerSections(SECTIONS_FIXTURE), {
    property_condition: "Rénovation nécessaire",
    heating_system: "Chauffage central: Radiateur",
    energy_source: "Gaz",
  });
  assert.deepEqual(energyDetailsFromSeLogerSections({}), {});
});

test("ufrnClassifiedSectionsFromHtml lit le script embarqué", () => {
  const inner =
    '{\\"app_cldp\\":{\\"data\\":{\\"classified\\":{\\"sections\\":{\\"features\\":{\\"preview\\":[]}}}}}}';
  const html = `<script>window["__UFRN_LIFECYCLE_SERVERREQUEST__"]=JSON.parse("${inner}");</script>`;
  const sections = ufrnClassifiedSectionsFromHtml(html);
  assert.ok(sections?.features);
});
