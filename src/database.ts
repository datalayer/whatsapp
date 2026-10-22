import pg from "pg";

/** The service's PostgreSQL pool: bounded, every statement timed out. */
export function createDatabase(connectionString: string): pg.Pool {
  return new pg.Pool({
    application_name: "datalayer-whatsapp",
    connectionString,
    max: 10,
    statement_timeout: 15_000,
  });
}
