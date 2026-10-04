# Carnet de Visites

Extension Chrome et site web [carnetdevisites.fr](https://carnetdevisites.fr) pour centraliser vos visites et annonces immobilières.

| Dossier | Rôle |
|---|---|
| [`chrome-extension/`](chrome-extension) | Extension Chrome (MV3) : temps de trajet, bord politique de la commune, indice de taxe foncière et prix médians au m² sur les pages d'annonces, et sauvegarde du bien dans le carnet. |
| [`app/`](app) | Serveur + site **Carnet de Visites** : enregistre les annonces envoyées par l'extension, les liste, les enrichit et calcule un tableau de financement. |

## Extension

Pas d'étape de build. Dans Chrome : `chrome://extensions` → mode développeur → « Charger l'extension non empaquetée » → sélectionner le dossier `chrome-extension/`.

**API en local** : copier `chrome-extension/src/config.local.example.js` vers `config.local.js` (déjà gitignored) pour pointer vers `http://localhost:3000`. Sans ce fichier, l'extension utilise `https://carnetdevisites.fr`.

Dans la popup, « S'authentifier » ouvre la page de consentement du site : une fois l'autorisation accordée, l'extension est connectée — aucun code à recopier. Sur une annonce, elle propose alors « Sauvegarder l'annonce » et le choix du projet de destination, le dernier projet utilisé restant présélectionné.

Le temps de trajet voiture est calculé par le serveur, avec une clé OpenRouteService **partagée** et stockée côté serveur (`ORS_API_KEY`) : rien à saisir dans l'extension, il suffit d'être authentifié et d'avoir défini les adresses de référence du projet sur le site.

Les scripts de `chrome-extension/scripts/` régénèrent les données communales embarquées (`chrome-extension/src/data/*.js`) à partir des fichiers open data :

```bash
cd chrome-extension
node scripts/build-data.js
node scripts/build-prices.js
```

### Avant publication sur le Chrome Web Store

1. Générer le zip : `cd chrome-extension && ./package.sh [x.y.z]` → `dist/carnet-de-visites-<version>.zip` (fixe `manifest.json`, embarque `build.version.js`, exclut `config.local.js`). L'extension envoie cette version dans l'en-tête `X-Carnet-Extension-Version` sur `/api/v1/*` (visible dans les logs serveur). Optionnel : `EXTENSION_MIN_VERSION` côté serveur pour refuser les anciennes extensions (426 `extension_outdated`).
2. `app/.env` (serveur prod) : `BASE_URL=https://carnetdevisites.fr` (cookies, liens OAuth extension).
3. `chrome-extension/manifest.json` : vérifier `host_permissions`, incrémenter `version`, regénérer le zip si besoin.
4. Côté serveur, renseigner `EXTENSION_ORIGINS=chrome-extension://<id-de-l-extension>` : seules les extensions listées peuvent alors recevoir une autorisation.
5. Vérifier le parcours complet sur une version empaquetée : l'identifiant de l'extension change entre une installation non empaquetée et la version du store, et `redirect_uri` en dépend.
6. Côté serveur, renseigner `ORS_API_KEY` : sans elle, le calcul d'itinéraire est désactivé (réponse « indisponible »). Une clé gratuite OpenRouteService a un quota limité ; prévoir une clé adaptée au nombre d'utilisateurs.

L'extension ne demande que trois permissions — `storage`, `activeTab` et `identity` — et n'accède aux pages que des trois sites d'annonces déclarés.

## Serveur et site

```bash
cd app
npm install
cp .env.example .env
npm run seed    # compte de démonstration + annonces fictives
npm run dev     # http://localhost:3000
```

Voir [`app/README.md`](app/README.md) pour la configuration, l'API consommée par l'extension et le déploiement Docker.
