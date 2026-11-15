-- Refresh tokens for sign-in sessions. See docs/design.md, "Auth".
-- Only a SHA-256 of each token is stored, so a leaked table can't be used to sign in.
-- Every refresh replaces the token with a new one in the same family. If a token that was already
-- replaced comes back, someone kept a copy, so the whole family is revoked.
CREATE TABLE refresh_tokens (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users (id),
  family_id   UUID NOT NULL,
  token_hash  BYTEA NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  replaced_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
