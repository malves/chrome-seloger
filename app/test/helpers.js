/**
 * Utilitaires de test : application sur base en mémoire, comptes, extension
 * connectée.
 *
 * L'enrichissement réel est branché (il ne lit que la base) sauf `schedule`,
 * neutralisé pour qu'aucun appel réseau ne part pendant les tests.
 */

import request from "supertest";
import { openDatabase } from "../src/db.js";
import createApp from "../src/app.js";
import createRepositories from "../src/repositories/index.js";
import createEnrichmentService from "../src/services/enrichment/index.js";
import createLogger from "../src/lib/logger.js";
import { hashPassword } from "../src/services/password.service.js";
import { defaultUserSettings } from "../src/services/settings.service.js";

export const PASSWORD = "motdepasse123";

export function createTestApp() {
  const db = openDatabase(":memory:");
  const repositories = createRepositories(db);
  const logger = createLogger({ level: "silent" });
  const real = createEnrichmentService({ repositories, logger });
  const enrichment = { ...real, schedule() {} };
  const app = createApp({ db, repositories, logger, enrichment });

  return {
    app,
    db,
    repositories,
    enrichment: real,
    close: () => db.close(),
  };
}

export async function createUser(repositories, email) {
  return repositories.users.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    settings: defaultUserSettings(),
  });
}

/**
 * Crée un compte avec une extension déjà connectée, sans rejouer le flux
 * d'autorisation : la clé de session suffit à appeler l'API.
 */
export async function createConnectedUser(repositories, email) {
  const user = await createUser(repositories, email);
  const { key } = repositories.extension.createSession({
    userId: user.id,
    label: "Chrome sur Linux",
  });
  return { user, key };
}

export function listingPayload(overrides = {}) {
  return {
    schema_version: 1,
    source: "seloger",
    source_id: "123456",
    url: "https://www.seloger.com/annonces/achat/maison/ville-78/123456.htm",
    transaction_type: "sale",
    property_type: "house",
    title: "Maison 5 pièces 120 m²",
    description: "Belle maison familiale.",
    price: 385000,
    surface: 120,
    rooms: 5,
    bedrooms: 3,
    location: { city: "Rambouillet", postal_code: "78120" },
    photos: ["https://photos.example.com/1.jpg"],
    ...overrides,
  };
}

/** Récupère le jeton CSRF d'une page du site. */
export function extractCsrf(html) {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!match) throw new Error("Jeton CSRF absent de la page.");
  return match[1];
}

/** Agent supertest authentifié sur le site (cookie de session). */
export async function loginAgent(app, email, password = PASSWORD) {
  const agent = request.agent(app);
  const page = await agent.get("/login").expect(200);
  await agent
    .post("/login")
    .type("form")
    .send({
      _csrf: extractCsrf(page.text),
      email,
      password,
      next: "/listings",
    })
    .expect(302);
  return agent;
}
