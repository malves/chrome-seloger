-- Connexion de l'extension sans jeton à copier-coller.
--
-- `api_tokens` devient `extension_sessions` : la clé n'est plus un jeton que
-- l'utilisateur manipule mais un secret créé et conservé par l'extension, au
-- terme d'un échange d'autorisation. Seul son SHA-256 est stocké.

ALTER TABLE api_tokens RENAME TO extension_sessions;
ALTER TABLE extension_sessions RENAME COLUMN token_hash TO key_hash;

DROP INDEX IF EXISTS idx_api_tokens_user;
CREATE INDEX idx_extension_sessions_user
  ON extension_sessions(user_id, created_at DESC);

-- Codes d'autorisation à usage unique, émis par la page de consentement du
-- site et échangés par l'extension contre une session (durée de vie : minutes).
-- `code_challenge` porte le PKCE S256 : un code intercepté est inutilisable
-- sans le vérificateur gardé par l'extension.
CREATE TABLE extension_auth_codes (
  code_hash      TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge TEXT NOT NULL,
  label          TEXT,                        -- ex. "Chrome sur macOS"
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_extension_auth_codes_expiry ON extension_auth_codes(expires_at);
