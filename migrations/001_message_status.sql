BEGIN;

-- What the service keeps. The shared tables (whatsapp_event_claims,
-- whatsapp_jobs, whatsapp_usage, whatsapp_payload_access,
-- whatsapp_job_replays) are the host kit's: applyHostSchema(db, "whatsapp")
-- from @datalayer/agent-runtimes/lib/portable/hosts runs before these files
-- (scripts/migrate.ts). Each file is idempotent and re-applied every time.

-- The furthest status Meta reported for a message the number sent, by the
-- SHA-256 of its wamid (Meta's message ids have been seen to embed a phone
-- number): sent < delivered < read < played; failed ends it, with Meta's error
-- code. Statuses arrive out of order and more than once: a lower rank never
-- replaces a higher one. No person is named here: neither the phone number
-- nor the business-scoped user id.
CREATE TABLE IF NOT EXISTS whatsapp_message_status (
  wamid_hash text PRIMARY KEY CHECK (wamid_hash ~ '^[0-9a-f]{64}$'),
  phone_number_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'played', 'failed')),
  status_rank smallint NOT NULL,
  error_code integer,
  status_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_message_status_updated_at
  ON whatsapp_message_status (updated_at);

COMMIT;
