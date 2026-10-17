/**
 * Barème du chiffrage des travaux (TTC, indicatif). Les montants sont
 * calculés dans works-estimate.js à partir de la surface du bien, et dans
 * works-global.js pour les chantiers du logement entier.
 */

import {
  ENERGY_SURFACE_REF_M2,
  INTERIOR_POST_SHARES,
  ISSUE_INTENSITY,
  ROOM_RENOVATION_EUR_M2,
  estimateWorksCosts,
  roundCost,
  roomSurfaceShares,
  validateEstimateBarème,
} from "./works-estimate.js";
import { ISSUE_PRIORITY, ROOM_ISSUES } from "./works-issues.js";

export {
  ROOM_RENOVATION_EUR_M2,
  INTERIOR_POST_SHARES,
  ISSUE_INTENSITY,
  ENERGY_SURFACE_REF_M2,
  estimateWorksCosts,
  roundCost,
  roomSurfaceShares,
  validateEstimateBarème,
};

/** Postes affichés dans la barre empilée du récapitulatif. */
export const COST_POSTS = [
  { key: "floor", label: "Sols" },
  { key: "walls", label: "Murs et peintures" },
  { key: "ceiling", label: "Plafonds" },
  { key: "humidity", label: "Humidité et ventilation" },
  { key: "kitchen", label: "Cuisine" },
  { key: "bathroom", label: "Salle d'eau" },
  { key: "electricity", label: "Électricité" },
  { key: "plumbing", label: "Plomberie et eau chaude" },
  { key: "joinery", label: "Fenêtres et volets" },
  { key: "doors", label: "Portes" },
  { key: "heating", label: "Chauffage" },
  { key: "energy", label: "Énergie (DPE)" },
  { key: "site", label: "Frais de chantier" },
];

/** Postes concentrés dans certaines pièces (cuisine, salles d'eau). */
function concentratedPosts() {
  return [
    ...new Set(
      ROOM_ISSUES.filter((i) => i.roomTypes)
        .map((i) => ISSUE_INTENSITY[i.key]?.post)
        .filter(Boolean)
    ),
  ];
}

/** Coefficient de répartition de la surface entre les pièces du plan. */
export const ROOM_TYPE_FACTORS = {
  living_room: 1.4,
  living_dining_room: 1.6,
  dining_room: 1.1,
  kitchen: 1.2,
  open_kitchen: 1.2,
  bathroom: 1.3,
  shower_room: 1.2,
  master_bedroom: 1.1,
  bedroom: 1,
  child_bedroom: 1,
  toilet: 0.5,
  entrance: 0.6,
  hallway: 0.6,
  dressing: 0.5,
  laundry: 0.6,
  cellar: 0.6,
  garage: 0.8,
  balcony: 0.5,
  terrace: 0.8,
  garden: 1,
  common_area: 0,
  building_exterior: 1,
  unknown: 1,
};

/**
 * Travaux énergétiques pour une zone DPE jugée faible. `building: true` :
 * en appartement, relève de la copropriété (affiché hors total).
 * Montants de référence pour ~70 m², mis à l'échelle dans works-estimate.
 */
export const ENERGY_COSTS = {
  roof: { label: "Isolation de la toiture et des combles", min: 3000, max: 12000, building: true },
  walls: { label: "Isolation des murs", min: 8000, max: 25000, building: true },
  windows: { label: "Remplacement des fenêtres", min: 4000, max: 12000 },
  floor: { label: "Isolation du plancher bas", min: 2000, max: 6000, building: true },
  heating: { label: "Modernisation du chauffage", min: 4000, max: 15000 },
  hotWater: { label: "Remplacement de la production d'eau chaude", min: 1500, max: 4000 },
  ventilation: { label: "Ventilation (VMC)", min: 800, max: 3500 },
};

/** Barème transmis à la modale « Pièces et état ». */
export function costsOptions() {
  return {
    posts: COST_POSTS,
    issueIntensity: ISSUE_INTENSITY,
    interiorPostShares: INTERIOR_POST_SHARES,
    renovationRates: ROOM_RENOVATION_EUR_M2,
    roomTypeFactors: ROOM_TYPE_FACTORS,
    concentratedPosts: concentratedPosts(),
    issuePriority: ISSUE_PRIORITY,
    energy: ENERGY_COSTS,
    energySurfaceRefM2: ENERGY_SURFACE_REF_M2,
  };
}
