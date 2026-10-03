/**
 * Carnet d'adresses du compte : source de vérité unique des adresses de
 * référence, gérée depuis les Paramètres. Les projets y pointent via une table
 * de liaison ; modifier une adresse ici se répercute partout, la supprimer la
 * retire de tous les projets (cascade en base).
 *
 * Le géocodage (clé ORS partagée) est « best-effort » : s'il échoue, l'adresse
 * est enregistrée sans coordonnées et le trajet la géocodera au moment du calcul.
 */

import { MAX_ADDRESS_LENGTH, MAX_LABEL_LENGTH } from "./projects.service.js";

function cleanAddress(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, MAX_ADDRESS_LENGTH);
}

function cleanLabel(value) {
  const label = String(value || "").trim().replace(/\s+/g, " ").slice(0, MAX_LABEL_LENGTH);
  return label || null;
}

export default function createAddressbookService({ repositories, travel }) {
  function list(userId) {
    return repositories.addresses.listByUser(userId);
  }

  async function create(userId, { label, address }) {
    const cleaned = cleanAddress(address);
    if (!cleaned) return { address: null, error: "Saisissez une adresse." };

    if (repositories.addresses.findByAddress(userId, cleaned)) {
      return { address: null, error: "Cette adresse est déjà dans votre carnet." };
    }

    const geo = await travel.geocodeAddress(cleaned);
    const created = repositories.addresses.insert({
      userId,
      label: cleanLabel(label),
      address: cleaned,
      lat: geo ? geo.lat : null,
      lng: geo ? geo.lon : null,
    });
    return { address: created, error: null, geocoded: Boolean(geo) };
  }

  async function update(userId, id, { label, address }) {
    const current = repositories.addresses.findById(userId, id);
    if (!current) return { address: null, error: "Adresse introuvable." };

    const cleaned = cleanAddress(address);
    if (!cleaned) return { address: null, error: "Saisissez une adresse." };

    // Déduplication : interdit de confondre deux adresses du carnet.
    const duplicate = repositories.addresses.findByAddress(userId, cleaned);
    if (duplicate && duplicate.id !== current.id) {
      return { address: null, error: "Cette adresse est déjà dans votre carnet." };
    }

    // On ne regéocode que si le texte de l'adresse a changé.
    const addressChanged =
      cleanAddress(current.address).toLowerCase() !== cleaned.toLowerCase();
    let lat = current.lat;
    let lng = current.lng;
    if (addressChanged) {
      const geo = await travel.geocodeAddress(cleaned);
      lat = geo ? geo.lat : null;
      lng = geo ? geo.lon : null;
    }

    const updated = repositories.addresses.update({
      id: current.id,
      userId,
      label: cleanLabel(label),
      address: cleaned,
      lat,
      lng,
    });
    return { address: updated, error: null };
  }

  function remove(userId, id) {
    const removed = repositories.addresses.remove(userId, id);
    if (!removed) return { removed: false, error: "Adresse introuvable." };
    return { removed: true, error: null };
  }

  return { list, create, update, remove };
}
