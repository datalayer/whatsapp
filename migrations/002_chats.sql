BEGIN;

-- A 1:1 chat between a person (their business-scoped user id, BSUID) and a
-- business number: when the person last wrote (the 24-hour customer service
-- window), the session's generation (`start over`, a switch of
-- application), the application they chose, and the window's notices. No
-- phone number, no message. Deleted 30 days after the person's last message,
-- and at once by `forget`.
CREATE TABLE IF NOT EXISTS whatsapp_chat (
  phone_number_id text NOT NULL,
  user_id text NOT NULL,
  waba_id text NOT NULL,
  last_inbound_at timestamptz NOT NULL,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  application_id text,
  notices_stopped boolean NOT NULL DEFAULT false,
  last_notice_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (phone_number_id, user_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_chat_user_id ON whatsapp_chat (user_id);
CREATE INDEX IF NOT EXISTS whatsapp_chat_last_inbound_at
  ON whatsapp_chat (last_inbound_at);

COMMIT;
