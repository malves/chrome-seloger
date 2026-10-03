# Carnet de recherche immobilière

Serveur et site web qui conservent les annonces envoyées par l'extension
Chrome du dossier [`../chrome-extension`](../chrome-extension), les listent, les
enrichissent avec de l'open data communale et calculent un plan de financement.

Un seul process Node, une base SQLite dans un fichier, aucun service externe
obligatoire, aucune étape de build.

## Démarrage

```bash
npm install
cp .env.example .env
npm run seed    # compte de démonstration + 5 annonces fictives
npm run dev     # http://localhost:3000
```

Le seed affiche les identifiants du compte de démonstration
(`demo@example.com` / `motdepasse123`) ; l'extension s'y rattache ensuite avec
son bouton « S'authentifier ».
`SEED_ENRICH=0 npm run seed` évite les appels à `geo.api.gouv.fr`.

| Script | Rôle |
|---|---|
| `npm run dev` | Serveur avec redémarrage automatique (`node --watch`) |
| `npm start` | Serveur en production |
| `npm test` | Tests unitaires et d'intégration (`node:test` + `supertest`) |
| `npm run seed` | Recrée le compte de démonstration et ses annonces |

## Configuration

Toutes les variables sont décrites dans [`.env.example`](.env.example).

| Variable | Rôle |
|---|---|
| `BASE_URL` | URL publique, utilisée dans les `web_url` renvoyés à l'extension |
| `DATABASE_PATH` | Fichier SQLite (`./data/app.db` en développement, `/data/app.db` en Docker) |
| `SESSION_SECRET` | Obligatoire en production |
| `EXTENSION_ORIGINS` | Origines autorisées sur `/api/v1/*`, ex. `chrome-extension://abcdef…`. Restreint aussi les extensions autorisées à recevoir un code d'autorisation |
| `ORS_API_KEY` | Clé OpenRouteService partagée : géocodage des adresses de projet et calcul des temps de trajet (`POST /api/v1/travel-time`). Vide = itinéraires indisponibles |
| `NOTARY_RATE_OLD`, `NOTARY_RATE_NEW`, `GUARANTEE_RATE` | Taux forfaitaires du financement, valeurs indicatives |
| `DEFAULT_INTEREST_RATE`, `DEFAULT_INSURANCE_RATE`, `DEFAULT_YEARS`, `DEBT_RATIO` | Valeurs initiales des paramètres de financement |

## Organisation

```
src/
  server.js            écoute HTTP
  app.js               assemblage Express (utilisé aussi par les tests)
  config.js            variables d'environnement et taux par défaut
  db.js                connexion SQLite + exécution des migrations
  session-store.js     store express-session adossé à la table sessions
  routes/              web.auth, web.extension, web.listings, web.projects, web.settings, api.v1
  middlewares/         session, extension, csrf, cors extension, erreurs
  repositories/        seul endroit où du SQL est écrit
  services/            listings, projects, financing, settings, password, extension-auth, enrichment/
  schemas/             schéma zod du payload de l'extension
  views/               EJS (layout, pages, partials)
  lib/                 format, json, time, logger, http-error
  scripts/seed.js
migrations/            001_init.sql, 002_projects.sql, 003_extension_sessions.sql, …
public/                css, js (htmx servi en local), favicon
test/
data/                  base SQLite (ignorée par git)
```

Tout accès à la base passe par `repositories/` : aucune requête SQL dans les
routes, pour permettre un passage ultérieur à MySQL ou PostgreSQL sans
réécrire les routes. Les migrations sont des fichiers SQL numérotés appliqués
au démarrage et suivis dans `schema_migrations`.

## Connexion de l'extension

Il n'y a aucun jeton à créer ni à recopier. L'extension suit un parcours
d'autorisation calqué sur OAuth 2.0 avec PKCE (RFC 7636) :

1. l'extension ouvre
   `GET /extension/connect?redirect_uri&state&code_challenge&code_challenge_method=S256` ;
   la page exige une session du site et affiche un écran de consentement ;
2. « Autoriser l'extension » redirige vers
   `https://<id-extension>.chromiumapp.org/?code&state`, que Chrome remet à
   l'extension et à elle seule ;
3. `POST /api/v1/extension/session` échange ce code — à usage unique, valable
   cinq minutes — contre une clé de session.

`redirect_uri` n'est accepté que sur `chromiumapp.org`, et pour les
identifiants d'extension déclarés dans `EXTENSION_ORIGINS`. La clé de session
n'est jamais affichée : elle reste dans le stockage local de l'extension et
voyage dans l'en-tête `Authorization`. Chaque navigateur connecté apparaît dans
Paramètres, où il peut être déconnecté.

## API consommée par l'extension

Authentification par clé de session (`Authorization: Bearer ext_…`), jamais par
cookie. Les erreurs ont toujours la forme
`{ "error": { "code", "message", "details" } }`. Corps limité à 1 Mo,
120 requêtes par minute et par session.

| Endpoint | Rôle |
|---|---|
| `POST /api/v1/extension/session` | `{ code, code_verifier }` → `201 { key, user }` |
| `GET /api/v1/me` | Vérifie la session |
| `DELETE /api/v1/extension/session` | Déconnecte l'extension (`204`) |
| `GET /api/v1/projects` | `{ projects: [{ id, name, slug, is_default, listing_count, addresses: [{ id, label, address, lat, lng }] }] }` |
| `POST /api/v1/projects` | `{ name }` → `201 { project }` |
| `POST /api/v1/listings` | Enregistre une annonce → `201` (création) ou `200` (mise à jour) |
| `GET /api/v1/listings/lookup?url=…` | `{ saved, id?, status?, projects?, web_url? }` |
| `PUT /api/v1/listings/:id/projects` | `{ projects: [...] }` remplace le classement → `{ projects }` |
| `POST /api/v1/travel-time` | `{ origin, project_id? }` → `{ origin, results: [...], project }` |

### Temps de trajet

`origin` est soit `{ lat, lon }`, soit une adresse (`{ address }` ou une simple
chaîne) : le serveur géocode ce qui manque. Les **destinations ne sont pas
passées par l'extension** : ce sont les adresses de référence du projet
(`project_id`, à défaut le projet par défaut du compte). La réponse renvoie
`results`, un tableau avec une entrée par adresse du projet :
`{ id, label, address, duration_seconds, distance_meters, lat, lon }`, ou
`{ id, label, address, error }` si une destination n'a pas pu être calculée —
une erreur sur une adresse ne bloque pas les autres.

Le calcul s'appuie sur **OpenRouteService avec une clé partagée**
(`ORS_API_KEY`), stockée côté serveur uniquement : l'extension ne la connaît
jamais. Sans clé configurée, l'endpoint répond `503 { code: "travel_unavailable" }`.
Un garde-fou limite ce calcul à 20 appels par minute et par session pour
préserver le quota de la clé.

### Exemple

```bash
# $KEY vient du parcours d'autorisation ci-dessus.
curl -s -X POST http://localhost:3000/api/v1/listings \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"schema_version":1,"source":"seloger","url":"https://www.seloger.com/annonces/1.htm","price":385000,"projects":["maison-de-campagne"]}'
```

### Payload

Seuls `schema_version`, `source` et `url` sont obligatoires : l'extension
envoie ce qu'elle parvient à extraire. Un champ facultatif invalide est ignoré
plutôt que de faire échouer toute l'annonce ; les photos non `https` sont
écartées et la liste est tronquée à 60 entrées ; la description est coupée à
20 000 caractères et toujours affichée échappée.

Déduplication : l'URL est canonisée (fragment et paramètres de suivi retirés,
paramètres restants triés), puis
`dedup_key = source:source_id` ou `source:sha1(url canonique)`. Lors d'une mise
à jour, `status`, `notes` et `is_favorite` ne sont jamais écrasés, et un champ
absent du nouveau payload conserve sa valeur précédente. Un prix différent
ajoute une ligne dans `price_history` et met `price_changed` à `true`.

## Projets de recherche

Un projet regroupe les annonces d'une même recherche : « Résidence
principale », « Maison de campagne », « Investissement locatif ». Une annonce
peut appartenir à plusieurs projets, et elle en a **toujours au moins un** :
sans projet précisé, elle rejoint le projet par défaut du compte.

Sur le site, les projets se gèrent sur `/projects` et la liste se filtre avec
`/listings?project=<slug>`. Sur une fiche, le bloc « Projets » coche et décoche
les appartenances ; tout décocher ramène l'annonce dans le projet par défaut.
Supprimer un projet ne supprime aucune annonce.

### Paramètres de projet

Chaque projet a sa propre page de paramétrage (`/projects/:id`) où l'on règle
son nom et, surtout, ses **adresses de référence** (jusqu'à 8). Ces adresses
remplacent l'ancienne adresse de départ unique du plugin : le temps de trajet
d'une annonce est désormais calculé **vers chaque adresse du projet** auquel
elle appartient (domicile, bureau, école, gare…). À l'enregistrement, l'adresse
est géocodée côté serveur (si `ORS_API_KEY` est configurée) et ses coordonnées
mémorisées ; sinon elle est conservée et géocodée au prochain calcul. Les
adresses d'un projet sont exposées dans `GET /api/v1/projects` et pilotent
`POST /api/v1/travel-time` via `project_id`.

Depuis l'extension, le payload accepte indifféremment `projects`, `project` ou
`project_id`, avec un identifiant numérique, un slug ou un nom :

```json
{ "schema_version": 1, "source": "seloger", "url": "https://…",
  "projects": ["maison-de-campagne"] }
```

Une référence inconnue est ignorée — comme tout champ facultatif invalide — et
l'annonce rejoint le projet par défaut. La réponse renvoie toujours la liste
`projects` effectivement appliquée, pour que l'extension puisse l'afficher.
Sur une annonce déjà enregistrée, l'affectation est **additive** : une nouvelle
capture ne défait jamais un classement fait à la main. Pour remplacer
l'ensemble, utiliser `PUT /api/v1/listings/:id/projects`.

## Enrichissement

Chaque source de donnée externe est un provider : un fichier
`src/services/enrichment/*.provider.js` exportant par défaut

```js
export default {
  key: "commune",       // identifiant unique, et nom du partial d'affichage
  scope: "commune",     // "commune" (cache partagé par INSEE) | "listing"
  ttlDays: 180,
  label: "Commune",
  order: 0,             // ordre d'exécution
  resolvesInsee: true,  // facultatif : s'exécute avant que l'INSEE soit connu
  async fetch(ctx) {},  // ctx = { listing, inseeCode, repositories, fetchJson, config, logger }
};
```

Ajouter une source de donnée demande donc **un fichier provider et un partial**
`src/views/partials/enrichment/<key>.ejs` ; sans partial dédié, un rendu
clé/valeur générique prend le relais. Le registre découvre les fichiers tout
seul, il n'y a rien à déclarer.

Fonctionnement : la réponse HTTP part immédiatement, puis l'enrichissement
s'exécute en arrière-plan dans le même process. Un provider en erreur n'empêche
pas les autres ; la fiche affiche « Donnée indisponible » avec un bouton
« Réessayer ». Les appels externes sont coupés à 8 secondes avec un seul nouvel
essai. Les providers de portée `commune` lisent le cache partagé
`commune_data` et n'appellent l'extérieur qu'en cas d'absence ou d'expiration.

Deux providers sont livrés : `commune` (résolution du code INSEE et des données
administratives via `geo.api.gouv.fr`, prérequis des futurs providers
communaux) et `financing` (calcul local).

Pour les jeux de données volumineux prévus ensuite (délinquance SSMSI,
recensement INSEE, transactions DVF, Géorisques), le `fetch` d'un provider peut
lire dans une table locale alimentée par un script `scripts/import-*.js` plutôt
que d'appeler une API.

## Financement

Les formules sont dans `src/services/financing.service.js`, en fonctions pures
couvertes par des tests. Les taux de notaire, de garantie et le taux
d'endettement viennent de `config.js`. Les valeurs par défaut se règlent dans
Paramètres et se surchargent annonce par annonce depuis la fiche ; la surcharge
est stockée dans `listing_enrichments` (provider `financing`).

Les droits de mutation varient selon le département et ont évolué récemment :
la V1 applique un taux forfaitaire, affiché comme une estimation. Le bloc n'est
pas affiché pour les annonces en location.

## Sécurité

- `helmet` avec une CSP qui autorise les images `https:` (les photos viennent de
  domaines tiers) et aucun script externe : htmx est servi depuis `public/js`.
- Protection CSRF sur tous les formulaires du site, page de consentement de
  l'extension comprise ; `/api/v1/*` en est exempté car authentifié par un
  en-tête, sans cookie.
- Mots de passe hachés avec argon2id, 10 caractères minimum, 10 tentatives de
  connexion par 15 minutes et par IP.
- Clés de session et codes d'autorisation stockés en SHA-256 uniquement, et
  jamais affichés. Un code est à usage unique, expire en cinq minutes et ne
  vaut qu'accompagné du vérificateur PKCE détenu par l'extension.
- Requêtes SQL exclusivement préparées ; toute lecture filtre sur `user_id`,
  une annonce d'un autre compte renvoie 404.
- Les photos restent servies par les sites d'origine (URL uniquement, aucune
  copie), chargées avec `referrerpolicy="no-referrer"`.
- `X-Robots-Tag: noindex, nofollow` sur tout le site.
- La suppression du compte efface en cascade annonces, photos, notes,
  historiques de prix, enrichissements et connexions de l'extension.

## Déploiement

```bash
docker compose up -d --build
```

Le volume `./data:/data` porte la base. Le compose est prêt pour un reverse
proxy Traefik : décommenter les labels et le réseau externe `web`.
