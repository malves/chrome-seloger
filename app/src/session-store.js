/**
 * Store express-session adossé à la table `sessions` de SQLite.
 *
 * `expire` est un horodatage epoch en millisecondes, ce qui rend la purge des
 * sessions expirées triviale. Le minuteur de purge est `unref()` pour ne pas
 * maintenir le process en vie (tests, scripts).
 */

import session from "express-session";

const ONE_DAY_MS = 86_400_000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

export default class SqliteSessionStore extends session.Store {
  constructor({ db, cleanup = true }) {
    super();
    this.db = db;
    this.statements = {
      get: db.prepare("SELECT sess FROM sessions WHERE sid = ? AND expire > ?"),
      set: db.prepare(
        `INSERT INTO sessions (sid, expire, sess) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET expire = excluded.expire, sess = excluded.sess`
      ),
      touch: db.prepare("UPDATE sessions SET expire = ? WHERE sid = ?"),
      destroy: db.prepare("DELETE FROM sessions WHERE sid = ?"),
      clear: db.prepare("DELETE FROM sessions"),
      length: db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE expire > ?"),
      all: db.prepare("SELECT sid, sess FROM sessions WHERE expire > ?"),
      purge: db.prepare("DELETE FROM sessions WHERE expire <= ?"),
    };

    if (cleanup) {
      this.timer = setInterval(() => this.purge(), CLEANUP_INTERVAL_MS);
      this.timer.unref();
    }
  }

  #expiry(sess) {
    const maxAge = sess?.cookie?.maxAge;
    if (sess?.cookie?.expires) return new Date(sess.cookie.expires).getTime();
    return Date.now() + (Number.isFinite(maxAge) ? maxAge : ONE_DAY_MS);
  }

  purge() {
    try {
      this.statements.purge.run(Date.now());
    } catch {
      // La purge est opportuniste : une erreur ne doit pas casser le serveur.
    }
  }

  get(sid, cb) {
    try {
      const row = this.statements.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.statements.set.run(sid, this.#expiry(sess), JSON.stringify(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.statements.touch.run(this.#expiry(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.statements.destroy.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  clear(cb = () => {}) {
    try {
      this.statements.clear.run();
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  length(cb = () => {}) {
    try {
      cb(null, this.statements.length.get(Date.now()).n);
    } catch (err) {
      cb(err);
    }
  }

  all(cb = () => {}) {
    try {
      cb(
        null,
        this.statements.all.all(Date.now()).map((row) => JSON.parse(row.sess))
      );
    } catch (err) {
      cb(err);
    }
  }
}
