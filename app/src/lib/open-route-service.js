/**
 * En-tête Authorization pour les appels POST OpenRouteService (directions,
 * isochrones). Les clés JWT récentes exigent le schéma Bearer ; sans lui,
 * l'API peut rester muette jusqu'au timeout client.
 */
export function openRouteServiceAuthorizationHeader(apiKey) {
  const trimmed = String(apiKey ?? "").trim();
  if (!trimmed) return "";
  if (/^Bearer\s/i.test(trimmed)) return trimmed;
  return `Bearer ${trimmed}`;
}
