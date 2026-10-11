#!/usr/bin/env bash
#
# Empaquette l'extension pour le Chrome Web Store (zip sans fichiers de dev).
#
# Usage :
#   ./package.sh              → version lue dans manifest.json
#   ./package.sh 0.3.0        → fixe la version dans manifest.json
#
# Sortie : dist/carnet-de-visites-<version>.zip
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v zip >/dev/null 2>&1; then
  echo "Erreur : la commande « zip » est requise." >&2
  exit 1
fi

REQUESTED_VERSION="${1:-}"

resolve_version() {
  PACKAGE_EXTENSION_VERSION="$REQUESTED_VERSION" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const requested = (process.env.PACKAGE_EXTENSION_VERSION || "").trim();
const manifestPath = path.join(process.cwd(), "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const semver = /^\d+\.\d+\.\d+$/;

if (requested) {
  if (!semver.test(requested)) {
    console.error(
      `Erreur : version invalide « ${requested} » (attendu : major.minor.patch, ex. 0.3.0).`
    );
    process.exit(1);
  }
  manifest.version = requested;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(requested);
} else {
  const current = String(manifest.version || "").trim();
  if (!semver.test(current)) {
    console.error(
      `Erreur : manifest.json.version invalide « ${current} » — passez une version en argument.`
    );
    process.exit(1);
  }
  process.stdout.write(current);
}
NODE
}

VERSION="$(resolve_version)"
OUT_DIR="${ROOT}/dist"
ZIP_PATH="${OUT_DIR}/carnet-de-visites-${VERSION}.zip"

STAGE="$(mktemp -d)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

copy_tree() {
  local src="$1"
  local dest="$2"
  mkdir -p "$dest"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude='config.local.js' --exclude='config.local.example.js' "$src/" "$dest/"
  else
    cp -a "$src/." "$dest/"
    rm -f "${dest}/config.local.js" "${dest}/config.local.example.js"
  fi
}

copy_tree "${ROOT}/src" "${STAGE}/src"
copy_tree "${ROOT}/icons" "${STAGE}/icons"
copy_tree "${ROOT}/styles" "${STAGE}/styles"
cp "${ROOT}/manifest.json" "${STAGE}/manifest.json"

cat >"${STAGE}/src/config.local.js" <<EOF
/** Généré par package.sh : aucune surcharge, l'URL de production s'applique. */
EOF

if grep -E '"http://localhost|'\''http://localhost' "${STAGE}/src/config.js" >/dev/null 2>&1; then
  echo "Erreur : config.js pointe encore vers localhost." >&2
  exit 1
fi

if ! grep -q 'carnetdevisites.fr' "${STAGE}/src/config.js"; then
  echo "Avertissement : config.js ne contient pas carnetdevisites.fr — vérifiez CARNET_BASE_URL." >&2
fi

mkdir -p "$OUT_DIR"
rm -f "$ZIP_PATH"
(
  cd "$STAGE"
  zip -r -q "$ZIP_PATH" manifest.json icons src styles
)

echo "Version : ${VERSION}"
echo "Archive créée : ${ZIP_PATH}"
echo "Soumettez ce fichier sur https://chrome.google.com/webstore/devconsole"
