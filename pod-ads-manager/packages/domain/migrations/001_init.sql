-- 001_init: core tables for proposals, approvals, outbox, ledger, audit.
-- Every business table carries tenant_id and every query filters on it.
-- Money is BIGINT minor units; never floating point.

CREATE TABLE IF NOT EXISTS business_configs (
  tenant_id     TEXT NOT NULL,
  ad_account_id TEXT NOT NULL,
  version       TEXT NOT NULL,
  seq           BIGSERIAL,
  data          JSONB NOT NULL,
  PRIMARY KEY (tenant_id, ad_account_id, version)
);

CREATE TABLE IF NOT EXISTS proposals (
  tenant_id     TEXT NOT NULL,
  proposal_id   TEXT NOT NULL,
  revision      INTEGER NOT NULL CHECK (revision >= 1),
  ad_account_id TEXT NOT NULL,
  status        TEXT NOT NULL,
  payload_hash  CHAR(64) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  data          JSONB NOT NULL,
  PRIMARY KEY (tenant_id, proposal_id, revision)
);
CREATE INDEX IF NOT EXISTS proposals_status_idx ON proposals (tenant_id, status);

CREATE TABLE IF NOT EXISTS policy_results (
  tenant_id   TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  data        JSONB NOT NULL,
  PRIMARY KEY (tenant_id, proposal_id, revision)
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  seq         BIGSERIAL,
  data        JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_proposal_idx ON approvals (tenant_id, proposal_id, revision);

CREATE TABLE IF NOT EXISTS jobs (
  job_id       TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  proposal_id  TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('execute','reconcile')),
  status       TEXT NOT NULL CHECK (status IN ('pending','leased','done','dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL,
  lease_owner  TEXT,
  lease_until  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL,
  last_error   TEXT
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (status, available_at);

CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  ad_account_id  TEXT NOT NULL,
  proposal_id    TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  daily_minor    BIGINT NOT NULL CHECK (daily_minor >= 0),
  lifetime_minor BIGINT NOT NULL CHECK (lifetime_minor >= 0),
  currency       CHAR(3) NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active','released')),
  created_at     TIMESTAMPTZ NOT NULL,
  released_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS reservations_scope_idx ON reservations (tenant_id, ad_account_id, status);

CREATE TABLE IF NOT EXISTS locks (
  scope      TEXT PRIMARY KEY,
  holder     TEXT NOT NULL,
  token      BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_attempts (
  attempt_id      TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  proposal_id     TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  action_id       TEXT NOT NULL,
  idempotency_key CHAR(64) NOT NULL,
  status          TEXT NOT NULL,
  seq             BIGSERIAL,
  data            JSONB NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, proposal_id, revision, action_id)
);

CREATE TABLE IF NOT EXISTS local_refs (
  tenant_id   TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  local_ref   TEXT NOT NULL,
  remote_id   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, proposal_id, revision, local_ref)
);

CREATE TABLE IF NOT EXISTS receipts (
  tenant_id   TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  data        JSONB NOT NULL,
  PRIMARY KEY (tenant_id, proposal_id, revision)
);

-- Audit: append-only, hash-chained per tenant. audit_heads serialises appends.
CREATE TABLE IF NOT EXISTS audit_heads (
  tenant_id  TEXT PRIMARY KEY,
  sequence   BIGINT NOT NULL,
  event_hash CHAR(64) NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  tenant_id      TEXT NOT NULL,
  sequence       BIGINT NOT NULL,
  correlation_id TEXT NOT NULL,
  event_hash     CHAR(64) NOT NULL,
  data           JSONB NOT NULL,
  PRIMARY KEY (tenant_id, sequence)
);
CREATE INDEX IF NOT EXISTS audit_corr_idx ON audit_events (tenant_id, correlation_id);
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE TABLE IF NOT EXISTS freeze_state (
  tenant_id TEXT PRIMARY KEY,
  data      JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  tenant_id   TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  seq         BIGSERIAL,
  data        JSONB NOT NULL,
  PRIMARY KEY (tenant_id, incident_id)
);

CREATE TABLE IF NOT EXISTS snapshots (
  tenant_id   TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  data        JSONB NOT NULL,
  PRIMARY KEY (tenant_id, snapshot_id)
);
CREATE TABLE IF NOT EXISTS creative_reviews (
  tenant_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  data      JSONB NOT NULL,
  PRIMARY KEY (tenant_id, review_id)
);
CREATE TABLE IF NOT EXISTS creative_assets (
  tenant_id TEXT NOT NULL,
  asset_id  TEXT NOT NULL,
  data      JSONB NOT NULL,
  PRIMARY KEY (tenant_id, asset_id)
);

CREATE TABLE IF NOT EXISTS entity_changes (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  ad_account_id TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  proposal_id   TEXT NOT NULL,
  changed_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS entity_changes_idx ON entity_changes (tenant_id, ad_account_id, entity_id);

CREATE TABLE IF NOT EXISTS verified_entities (
  tenant_id     TEXT NOT NULL,
  ad_account_id TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  proposal_id   TEXT NOT NULL,
  verified_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, ad_account_id, entity_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  principal  JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
