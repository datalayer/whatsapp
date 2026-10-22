BEGIN;

-- What waits for a chat's 24-hour window to reopen: a delivery, an approval
-- or a link reminder, by its reference only (never its content), held until
-- the person writes again; at most one per reference.
CREATE TABLE IF NOT EXISTS whatsapp_hold (
  id bigserial PRIMARY KEY,
  phone_number_id text NOT NULL,
  user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('delivery', 'approval', 'link')),
  ref text NOT NULL,
  held_at timestamptz NOT NULL,
  UNIQUE (phone_number_id, user_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS whatsapp_hold_user_id ON whatsapp_hold (user_id);
CREATE INDEX IF NOT EXISTS whatsapp_hold_held_at ON whatsapp_hold (held_at);

-- The notice templates of each business account, as Meta last said them:
-- a status other than APPROVED, or a category other than UTILITY, pauses
-- every notice of that account.
CREATE TABLE IF NOT EXISTS whatsapp_template (
  waba_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  category text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (waba_id, name)
);

-- Messages the number sent, by month (UTC) and category: what Meta's meter
-- counts against the free tier of service messages. No person is named.
CREATE TABLE IF NOT EXISTS whatsapp_message_count (
  phone_number_id text NOT NULL,
  month text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  category text NOT NULL CHECK (category IN ('service', 'utility')),
  sent integer NOT NULL DEFAULT 0,
  PRIMARY KEY (phone_number_id, month, category)
);

COMMIT;
