/**
 * Journal métier : une ligne par action (page, projet, annonce…),
 * avec `userId` lorsque la requête est authentifiée.
 */

export function logActivity(logger, req, message, fields = {}) {
  const userId = fields.userId ?? req?.user?.id ?? null;
  const payload = {};
  if (userId != null) payload.userId = userId;

  for (const [key, value] of Object.entries(fields)) {
    if (key === "userId" || value == null || value === "") continue;
    payload[key] = value;
  }

  logger.info(payload, message);
}
