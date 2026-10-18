/**
 * Barème du chiffrage des travaux (TTC, indicatif). Les montants sont
 * calculés dans works-estimate.js à partir de la surface du bien, et dans
 * works-global.js pour les chantiers du logement entier.
 */

import {
  ENERGY_SURFACE_REF_M2,
  FIXTURE_FLAT_RATES,
  ISSUE_INTENSITY,
  ROOM_AREA_BOUNDS,
  estimateWorksCosts,
  fixtureSurfaceFactor,
  roomFloorArea,
  roundCost,
  roomSurfaceShares,
  validateEstimateBarème,
  wallArea,
} from "./works-estimate.js";
import { ISSUE_COVERS, ISSUE_PRIORITY } from "./works-issues.js";

export {
  ISSUE_INTENSITY,
  FIXTURE_FLAT_RATES,
  ROOM_AREA_BOUNDS,
  ENERGY_SURFACE_REF_M2,
  estimateWorksCosts,
  fixtureSurfaceFactor,
  roomFloorArea,
  roundCost,
  roomSurfaceShares,
  validateEstimateBarème,
  wallArea,
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
 * Montants de référence pour ~70 m², mis à l'échelle dans works-estimate :
 * proportionnellement à la surface, ou de façon sous-linéaire et bornée pour
 * un équipement (`equipment: true`).
 */
export const ENERGY_COSTS = {
  roof: { label: "Isolation de la toiture et des combles", min: 3000, max: 12000, building: true },
  walls: { label: "Isolation des murs", min: 8000, max: 25000, building: true },
  windows: { label: "Remplacement des fenêtres", min: 4000, max: 12000 },
  floor: { label: "Isolation du plancher bas", min: 2000, max: 6000, building: true },
  heating: { label: "Modernisation du chauffage", min: 4000, max: 15000, equipment: true },
  hotWater: { label: "Remplacement de la production d'eau chaude", min: 1500, max: 4000, equipment: true },
  ventilation: { label: "Ventilation (VMC)", min: 800, max: 3500, equipment: true },
};

/** Barème transmis à la modale « Pièces et état ». */
export function costsOptions() {
  return {
    posts: COST_POSTS,
    issueIntensity: ISSUE_INTENSITY,
    roomTypeFactors: ROOM_TYPE_FACTORS,
    fixtureRates: FIXTURE_FLAT_RATES,
    issuePriority: ISSUE_PRIORITY,
    issueCovers: ISSUE_COVERS,
    energy: ENERGY_COSTS,
    energySurfaceRefM2: ENERGY_SURFACE_REF_M2,
  };
}
