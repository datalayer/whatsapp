BEGIN;

-- How a number was connected (WA-48): through Datalayer's Embedded Signup,
-- or with the business's own Meta app. Every installation before this
-- migration came through Embedded Signup; from now on each insert names its
-- way (no default). An own app's installation keeps the app's id, the key
-- of its own webhook address (`/whatsapp/webhook/<key>`) and the app's
-- secret, encrypted (AES-256-GCM, bound to the installation) like the other
-- secrets. A removed installation keeps neither the secret nor the address.
ALTER TABLE whatsapp_installation
  ADD COLUMN IF NOT EXISTS way text NOT NULL DEFAULT 'embedded_signup'
    CHECK (way IN ('embedded_signup', 'own_app'));
ALTER TABLE whatsapp_installation ALTER COLUMN way DROP DEFAULT;
ALTER TABLE whatsapp_installation ADD COLUMN IF NOT EXISTS app_id text;
ALTER TABLE whatsapp_installation ADD COLUMN IF NOT EXISTS app_secret jsonb;
ALTER TABLE whatsapp_installation ADD COLUMN IF NOT EXISTS webhook_key text UNIQUE;
-- Re-applied every time, as every migration: dropped and made again.
ALTER TABLE whatsapp_installation
  DROP CONSTRAINT IF EXISTS whatsapp_installation_way_columns;
ALTER TABLE whatsapp_installation
  ADD CONSTRAINT whatsapp_installation_way_columns CHECK (
    CASE way
      WHEN 'embedded_signup' THEN
        app_id IS NULL AND app_secret IS NULL AND webhook_key IS NULL
      ELSE
        app_id IS NOT NULL AND (
          (state = 'removed' AND app_secret IS NULL AND webhook_key IS NULL)
          OR (state <> 'removed' AND app_secret IS NOT NULL AND webhook_key IS NOT NULL)
        )
    END
  );

COMMIT;
