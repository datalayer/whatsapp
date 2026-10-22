/** A complete development environment. Test values: nothing here is a credential. */
export const ENVIRONMENT = {
  DATALAYER_WHATSAPP_ROLE: "all",
  DATALAYER_WHATSAPP_APP_SECRET: "test-only-not-an-app-secret",
  DATALAYER_WHATSAPP_VERIFY_TOKEN: "test-only-verify-token",
  NODE_ENV: "development",
} as const;
