BEGIN;

-- One connected business number: the business account (WABA) and the
-- number's id, bound at Datalayer as `<waba_id>:<phone_number_id>`. The host
-- key, the business token, the registration PIN and the delivery secret are
-- kept encrypted (AES-256-GCM, each bound to this installation), never in
-- clear. The number itself is not kept: its id is enough to send. A removed
-- installation keeps no business token or PIN, and its rows are purged 24
-- hours after its removal.
CREATE TABLE IF NOT EXISTS whatsapp_installation (
  waba_id text NOT NULL,
  phone_number_id text NOT NULL,
  host_uid text NOT NULL UNIQUE,
  host_key jsonb NOT NULL,
  business_token jsonb,
  pin jsonb,
  delivery_secret jsonb,
  organization_uid text NOT NULL,
  business_name text NOT NULL,
  support text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'paused', 'removed')),
  removed_at timestamptz,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (waba_id, phone_number_id),
  CHECK (state <> 'removed' OR (business_token IS NULL AND pin IS NULL AND removed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS whatsapp_installation_state
  ON whatsapp_installation (state);

-- A chat's turn and session: the session of the current generation (and the
-- deployment it runs), an answer not shown yet (a `turn.completed` delivery
-- finishes it), whether the disclosure line was said, the question the last
-- turn ended on (its options, to answer a pressed button), and the turn
-- running now — one per chat, claimed with a lease, with Stop asked or not.
ALTER TABLE whatsapp_chat ADD COLUMN IF NOT EXISTS session_uid text;
ALTER TABLE whatsapp_chat ADD COLUMN IF NOT EXISTS session_deployment text;
ALTER TABLE whatsapp_chat ADD COLUMN IF NOT EXISTS unshown_session_uid text;
ALTER TABLE whatsapp_chat ADD COLUMN IF NOT EXISTS disclosed boolean NOT NULL DEFAULT false;
ALTER TABLE whatsapp_chat ADD COLUMN IF NOT EXISTS asking jsonb;
ALTER TABLE whatsapp_chat ADD COLUMN IF NOT EXISTS turn_owner text;
ALTER TABLE whatsapp_chat ADD COLUMN IF NOT EXISTS turn_until timestamptz;
ALTER TABLE whatsapp_chat ADD COLUMN IF NOT EXISTS turn_session text;
ALTER TABLE whatsapp_chat ADD COLUMN IF NOT EXISTS turn_deployment text;
ALTER TABLE whatsapp_chat ADD COLUMN IF NOT EXISTS turn_stop boolean NOT NULL DEFAULT false;

-- An approval card shown in a person's chat: what was shown (the
-- presentation's digest), to whom, and how it ended. A press is checked
-- against it: a late press answers that it was decided already.
CREATE TABLE IF NOT EXISTS whatsapp_approval_card (
  phone_number_id text NOT NULL,
  user_id text NOT NULL,
  approval_id text NOT NULL,
  deployment_uid text NOT NULL,
  digest text NOT NULL,
  tool_name text NOT NULL,
  shown_at timestamptz NOT NULL,
  decided_status text,
  PRIMARY KEY (phone_number_id, user_id, approval_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_approval_card_user_id
  ON whatsapp_approval_card (user_id);
CREATE INDEX IF NOT EXISTS whatsapp_approval_card_shown_at
  ON whatsapp_approval_card (shown_at);

COMMIT;
