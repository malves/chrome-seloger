/**
 * Authentification du site par session.
 *
 * `loadUser` est monté globalement et remplit `req.user` / `res.locals.user`.
 * `requireUser` protège les pages privées.
 */

export function loadUser(repositories) {
  return (req, res, next) => {
    const userId = req.session?.userId;
    if (!userId) {
      req.user = null;
      res.locals.user = null;
      return next();
    }

    const user = repositories.users.findById(userId);
    if (!user) {
      // Compte supprimé entre deux requêtes : on referme la session et la
      // requête continue en visiteur anonyme.
      req.user = null;
      res.locals.user = null;
      req.session.destroy(() => next());
      return undefined;
    }

    req.user = user;
    res.locals.user = user;
    return next();
  };
}

export function requireUser(req, res, next) {
  if (req.user) return next();
  const target = req.originalUrl && req.method === "GET" ? req.originalUrl : "/";
  res.redirect(`/login?next=${encodeURIComponent(target)}`);
}
