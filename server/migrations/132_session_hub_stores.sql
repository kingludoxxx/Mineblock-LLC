-- 132 W6 — the switcher list a hub SSO session arrived with.
--
-- The hub signs {code, name} for every store the operator may hop into INTO THE TICKET (store-hub
-- src/routes/tickets.js). The exchange validates it and parks it here, on the session it just opened, so
-- GET /api/v1/store-config can render the sidebar's store dropdown without this dashboard ever calling the
-- hub (R21: with the hub gone the store still logs in; it simply has no list and shows no dropdown).
--
-- WHY THE SESSION ROW AND NOT THE TOKEN: fifty stores is roughly 4 KB of claims, which is the whole browser
-- cookie budget, and the access cookie is re-minted every 15 minutes. The session row is already read on
-- every hub-SSO request (middleware/auth.js re-verifies it with no grace period), so this costs no new query.
--
-- NULL = "this session never came from a hub" (a local login) OR "the hub sent nothing usable". Readers treat
-- both as an empty list. Additive, idempotent, runs on an empty database (R6).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS hub_stores JSONB;

COMMENT ON COLUMN sessions.hub_stores IS
  'W6: [{code,name}] the hub signed into the SSO ticket this session was opened with; NULL for a local login.';
