BEGIN;

-- The Meta app a number is connected with (WA-48): the application's own,
-- created by its developer (Datalayer has no Meta app). An installation
-- keeps the app's id, the key of its own webhook address
-- (`/whatsapp/webhook/<key>`) and the app's secret, encrypted (AES-256-GCM,
-- bound to the installation) like the other secrets. A removed installation
-- keeps neither the secret nor the address. The columns are made required
-- and checked in 007, once the installations of Datalayer's former Embedded
-- Signup are gone.
ALTER TABLE whatsapp_installation ADD COLUMN IF NOT EXISTS app_id text;
ALTER TABLE whatsapp_installation ADD COLUMN IF NOT EXISTS app_secret jsonb;
ALTER TABLE whatsapp_installation ADD COLUMN IF NOT EXISTS webhook_key text UNIQUE;
-- The former check named the way a number was connected; 007 checks the app.
ALTER TABLE whatsapp_installation
  DROP CONSTRAINT IF EXISTS whatsapp_installation_way_columns;

COMMIT;
