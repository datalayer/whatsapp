/** A complete development environment. Test values: nothing here is a credential. */
export const ENVIRONMENT = {
  DATALAYER_WHATSAPP_ROLE: "all",
  DATALAYER_WHATSAPP_VERIFY_SECRET: "test-only-verify-secret-of-32-chars",
  // 32 bytes of zeros, base64: a test key, never a real one.
  DATALAYER_WHATSAPP_SECRET_KEY: Buffer.alloc(32).toString("base64"),
  DATALAYER_WHATSAPP_APP_URL: "https://whatsapp.example.test",
  DATALAYER_API_URL: "https://datalayer.example.test",
  DATALAYER_WEB_URL: "https://web.example.test",
  NODE_ENV: "development",
} as const;
