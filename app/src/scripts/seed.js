/**
 * Jeu de données de démonstration.
 *
 * Crée un compte et cinq annonces fictives pour travailler l'interface sans
 * l'extension. Rejouable : le compte de démonstration est recréé à chaque fois,
 * ce qui déconnecte au passage les extensions qui y étaient rattachées.
 *
 *   npm run seed
 *   SEED_ENRICH=0 npm run seed   # sans appel à geo.api.gouv.fr
 */

import { openDatabase } from "../db.js";
import createRepositories from "../repositories/index.js";
import createListingsService from "../services/listings.service.js";
import createProjectsService from "../services/projects.service.js";
import createEnrichmentService from "../services/enrichment/index.js";
import createLogger from "../lib/logger.js";
import { hashPassword } from "../services/password.service.js";
import { defaultUserSettings } from "../services/settings.service.js";

const DEMO_EMAIL = "demo@example.com";
const DEMO_PASSWORD = "motdepasse123";

const photo = (seed, index) =>
  `https://picsum.photos/seed/${seed}-${index}/1200/800`;

const LISTINGS = [
  {
    payload: {
      schema_version: 1,
      source: "seloger",
      source_id: "218734561",
      url: "https://www.seloger.com/annonces/achat/maison/rambouillet-78/218734561.htm",
      transaction_type: "sale",
      property_type: "house",
      title: "Maison 5 pièces 120 m² avec jardin",
      description:
        "Maison familiale de 1985 entièrement rénovée en 2021, implantée sur un terrain clos et arboré de 650 m².\n\nAu rez-de-chaussée : entrée, double séjour de 38 m² exposé sud, cuisine aménagée et équipée, WC. À l'étage : trois chambres, salle de bains avec douche et baignoire.\n\nGarage, cave, abri de jardin. Chauffage par pompe à chaleur installée en 2021. Taxe foncière 1 420 €. Écoles et gare à dix minutes à pied.",
      price: 385000,
      surface: 120,
      land_surface: 650,
      rooms: 5,
      bedrooms: 3,
      year_built: 1985,
      dpe: "D",
      ges: "C",
      location: {
        city: "Rambouillet",
        postal_code: "78120",
        lat: 48.6436,
        lng: 1.829,
      },
      photos: [1, 2, 3, 4, 5].map((i) => photo("rambouillet", i)),
      agency: {
        name: "Agence du Château",
        phone: "0134830102",
        fees_included: true,
        fees_percent: 4.5,
      },
      features: ["garage", "jardin", "cave", "pompe à chaleur"],
      extension_data: {
        travel_times: [
          { label: "Bureau", mode: "car", minutes: 42 },
          { label: "Gare Montparnasse", mode: "transit", minutes: 58 },
        ],
        political_leaning: {
          label: "Plutôt à droite",
          gauche: 18,
          centre: 27,
          droite: 55,
        },
        property_tax_index: 3,
      },
    },
    status: "visit_planned",
    favorite: true,
    projects: ["residence-principale"],
    notes:
      "Visite prévue samedi 10 h. Vérifier l'isolation des combles et l'état de la toiture côté nord.",
    // Deuxième envoi : le prix a baissé, l'historique doit l'enregistrer.
    priceUpdate: 369000,
  },
  {
    payload: {
      schema_version: 1,
      source: "leboncoin",
      source_id: "2498711003",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2498711003",
      transaction_type: "sale",
      property_type: "apartment",
      title: "Appartement 3 pièces 68 m² avec balcon",
      description:
        "Au troisième étage avec ascenseur, appartement traversant de 68 m² : séjour de 24 m² ouvrant sur un balcon de 7 m² sans vis-à-vis, deux chambres, cuisine séparée, salle de bains.\n\nCave et place de parking en sous-sol. Copropriété de 42 lots, charges 180 € par mois. Ravalement voté et provisionné.",
      price: 289000,
      surface: 68,
      rooms: 3,
      bedrooms: 2,
      floor: 3,
      year_built: 1996,
      dpe: "C",
      ges: "B",
      location: {
        city: "Versailles",
        postal_code: "78000",
        lat: 48.8014,
        lng: 2.1301,
      },
      photos: [1, 2, 3].map((i) => photo("versailles", i)),
      agency: { name: "Particulier", fees_included: true },
      features: ["balcon", "ascenseur", "parking", "cave"],
      extension_data: {
        travel_times: [{ label: "Bureau", mode: "car", minutes: 28 }],
        political_leaning: {
          label: "Plutôt au centre",
          gauche: 22,
          centre: 47,
          droite: 31,
        },
        property_tax_index: 4,
      },
    },
    status: "contacted",
    projects: ["residence-principale"],
    notes: "Message envoyé au propriétaire, en attente de réponse.",
  },
  {
    payload: {
      schema_version: 1,
      source: "bienici",
      source_id: "bi-884512",
      url: "https://www.bienici.com/annonce/vente/maison/884512",
      transaction_type: "sale",
      property_type: "house",
      title: "Maison neuve 4 pièces 95 m², livraison 2027",
      description:
        "Maison individuelle de plain-pied livrée en 2027, normes RE2020, sur un terrain de 420 m². Trois chambres, séjour de 32 m² avec cuisine ouverte, cellier, garage attenant.\n\nFrais de notaire réduits. Garantie décennale et dommages-ouvrage incluses.",
      price: 342000,
      surface: 95,
      land_surface: 420,
      rooms: 4,
      bedrooms: 3,
      dpe: "A",
      ges: "A",
      is_new_build: true,
      location: {
        city: "Chartres",
        postal_code: "28000",
        lat: 48.4469,
        lng: 1.4886,
      },
      photos: [1, 2].map((i) => photo("chartres", i)),
      agency: {
        name: "Maisons de l'Eure",
        phone: "0237210405",
        fees_included: false,
        fees_percent: 3.5,
      },
      features: ["garage", "plain-pied", "RE2020"],
      extension_data: {
        travel_times: [{ label: "Bureau", mode: "car", minutes: 67 }],
        political_leaning: {
          label: "Partagée",
          gauche: 34,
          centre: 33,
          droite: 33,
        },
        property_tax_index: 2,
      },
    },
    status: "new",
    // Dans deux projets à la fois : le neuf à Chartres convient aux deux.
    projects: ["residence-principale", "maison-de-campagne"],
  },
  {
    payload: {
      schema_version: 1,
      source: "seloger",
      source_id: "219004412",
      url: "https://www.seloger.com/annonces/locations/appartement/paris-11eme-75/219004412.htm",
      transaction_type: "rent",
      property_type: "apartment",
      title: "Appartement 2 pièces 41 m² meublé",
      description:
        "Deux pièces meublé au deuxième étage d'un immeuble en pierre de taille. Séjour avec canapé-lit, chambre sur cour calme, cuisine équipée. Charges comprises : eau, chauffage collectif.",
      price: 1450,
      surface: 41,
      rooms: 2,
      bedrooms: 1,
      floor: 2,
      dpe: "E",
      ges: "D",
      location: {
        city: "Paris",
        postal_code: "75011",
        lat: 48.8575,
        lng: 2.3799,
      },
      photos: [1, 2].map((i) => photo("paris11", i)),
      features: ["meublé", "calme"],
      extension_data: {
        travel_times: [{ label: "Bureau", mode: "transit", minutes: 19 }],
        political_leaning: {
          label: "Plutôt à gauche",
          gauche: 54,
          centre: 22,
          droite: 24,
        },
        property_tax_index: 5,
      },
    },
    status: "rejected",
    projects: ["residence-principale"],
    notes: "Trop petit pour deux, et le loyer dépasse le budget.",
  },
  {
    // Cas limite : payload minimal, tel qu'une extraction ratée le produirait.
    payload: {
      schema_version: 1,
      source: "pap",
      url: "https://www.pap.fr/annonce/vente-maison-dreux-28100-r000000000",
    },
    status: "new",
  },
];

async function main() {
  const logger = createLogger();
  const db = openDatabase();
  const repositories = createRepositories(db);
  const listingsService = createListingsService({ repositories });
  const projectsService = createProjectsService({ repositories });
  const enrichment = createEnrichmentService({ repositories, logger });

  const existing = repositories.users.findByEmail(DEMO_EMAIL);
  if (existing) {
    // Garde-fou : ce script DÉTRUIT le compte de démonstration et toutes ses
    // données (projets, annonces, carnet d'adresses). S'il existe déjà, on
    // refuse d'écraser sans confirmation explicite, pour ne jamais effacer
    // par mégarde des données réelles accumulées sur ce compte.
    if (process.env.SEED_FORCE !== "1") {
      const projectCount = repositories.projects.countByUser(existing.id);
      const listingCount = db
        .prepare("SELECT COUNT(*) AS n FROM listings WHERE user_id = ?")
        .get(existing.id).n;
      console.error(
        [
          "",
          `⚠️  Le compte « ${DEMO_EMAIL} » existe déjà (#${existing.id}) avec`,
          `   ${projectCount} projet(s) et ${listingCount} annonce(s).`,
          "",
          "   Lancer le seed SUPPRIMERAIT définitivement ces données.",
          "   Si c'est bien voulu, relancez avec :",
          "",
          "       SEED_FORCE=1 npm run seed",
          "",
        ].join("\n")
      );
      db.close();
      process.exit(1);
    }
    repositories.users.remove(existing.id);
    console.log(`Compte de démonstration précédent supprimé (#${existing.id}).`);
  }

  const user = repositories.users.create({
    email: DEMO_EMAIL,
    passwordHash: await hashPassword(DEMO_PASSWORD),
    settings: {
      ...defaultUserSettings(),
      financing: {
        ...defaultUserSettings().financing,
        downPayment: 60000,
        years: 22,
        interestRate: 0.034,
        insuranceRate: 0.0028,
      },
    },
  });

  // Le premier projet créé devient le projet par défaut du compte.
  projectsService.create(user.id, "Résidence principale");
  projectsService.create(user.id, "Maison de campagne");

  const ids = [];
  for (const entry of LISTINGS) {
    const payload = { ...entry.payload, projects: entry.projects };
    const { id } = listingsService.save(user, payload);
    ids.push(id);

    if (entry.priceUpdate) {
      listingsService.save(user, { ...payload, price: entry.priceUpdate });
    }
    if (entry.status) repositories.listings.setStatus(user.id, id, entry.status);
    if (entry.favorite) repositories.listings.setFavorite(user.id, id, true);
    if (entry.notes) repositories.listings.setNotes(user.id, id, entry.notes);
  }

  if (process.env.SEED_ENRICH !== "0") {
    console.log("Enrichissement des annonces (geo.api.gouv.fr)…");
    for (const id of ids) {
      await enrichment.runForListing(user.id, id);
    }
  }

  const projectSummary = projectsService
    .list(user.id)
    .map((project) => `${project.name} (${project.listing_count})`)
    .join(", ");

  db.close();

  console.log(
    [
      "",
      "Jeu de démonstration prêt.",
      `  Compte      : ${DEMO_EMAIL}`,
      `  Mot de passe: ${DEMO_PASSWORD}`,
      `  Annonces    : ${ids.length}`,
      `  Projets     : ${projectSummary}`,
      "",
      "Connectez l'extension avec son bouton « S'authentifier ».",
      "",
    ].join("\n")
  );
}

main().catch((err) => {
  console.error("Échec du seed :", err);
  process.exit(1);
});
