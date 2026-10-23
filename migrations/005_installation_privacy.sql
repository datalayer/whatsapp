BEGIN;

-- The business's privacy page, asked on the Ship card before a number is
-- connected (an https address), kept beside its support contact. No number
-- was connected before this migration, so the column is required.
ALTER TABLE whatsapp_installation ADD COLUMN IF NOT EXISTS privacy text NOT NULL;

COMMIT;
