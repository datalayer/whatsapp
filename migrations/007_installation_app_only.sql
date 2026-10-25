BEGIN;

-- One way to connect a number: the application's own Meta app. Datalayer has
-- no Meta app any more, so a number connected through its Embedded Signup
-- (`way = 'embedded_signup'`) can be neither verified nor answered. A
-- removed one is purged here with every row of its number, as the hourly
-- purge would; one still connected refuses the migration (fail fast): its
-- owner disconnects it in Datalayer, the daily reconciliation removes it,
-- and the migration is run again. Then the `way` column is dropped, and
-- every installation names its app.
DO $$
DECLARE
  former record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'whatsapp_installation' AND column_name = 'way'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM whatsapp_installation
       WHERE way = 'embedded_signup' AND state <> 'removed'
    ) THEN
      RAISE EXCEPTION 'A number connected through Datalayer''s former Embedded Signup is still connected: disconnect it in Datalayer, let the reconciliation remove it, then migrate again.';
    END IF;
    FOR former IN
      SELECT waba_id, phone_number_id FROM whatsapp_installation
       WHERE way = 'embedded_signup'
    LOOP
      DELETE FROM whatsapp_hold WHERE phone_number_id = former.phone_number_id;
      DELETE FROM whatsapp_chat WHERE phone_number_id = former.phone_number_id;
      DELETE FROM whatsapp_approval_card WHERE phone_number_id = former.phone_number_id;
      DELETE FROM whatsapp_message_status WHERE phone_number_id = former.phone_number_id;
      DELETE FROM whatsapp_message_count WHERE phone_number_id = former.phone_number_id;
      DELETE FROM whatsapp_jobs
       WHERE payload->>'phoneNumberId' = former.phone_number_id AND state <> 'processing';
      DELETE FROM whatsapp_usage
       WHERE usage_key = 'number:' || former.waba_id || ':' || former.phone_number_id
          OR starts_with(usage_key, 'user:' || former.waba_id || ':' || former.phone_number_id || ':');
      DELETE FROM whatsapp_installation
       WHERE waba_id = former.waba_id AND phone_number_id = former.phone_number_id;
      DELETE FROM whatsapp_template WHERE waba_id = former.waba_id AND NOT EXISTS (
        SELECT 1 FROM whatsapp_installation WHERE waba_id = former.waba_id);
    END LOOP;
    ALTER TABLE whatsapp_installation DROP COLUMN way;
  END IF;
END
$$;

ALTER TABLE whatsapp_installation ALTER COLUMN app_id SET NOT NULL;
-- Re-applied every time, as every migration: dropped and made again.
ALTER TABLE whatsapp_installation
  DROP CONSTRAINT IF EXISTS whatsapp_installation_app_columns;
ALTER TABLE whatsapp_installation
  ADD CONSTRAINT whatsapp_installation_app_columns CHECK (
    (state = 'removed' AND app_secret IS NULL AND webhook_key IS NULL)
    OR (state <> 'removed' AND app_secret IS NOT NULL AND webhook_key IS NOT NULL)
  );

COMMIT;
