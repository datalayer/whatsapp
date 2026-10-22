import { z } from "zod";

/**
 * The service's settings, read once at start and refused by name when one is
 * missing or malformed: no default stands in for a credential (fail fast).
 * Each later piece of the service adds the settings it reads.
 */

const secret = z.string().min(1);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: z.coerce.number().int().positive().default(3000),
    /**
     * What this process does: `ingress` serves Meta's webhooks and persists
     * them, `worker` works the durable queue, `all` both (one process:
     * development, tests). Production runs each apart. WhatsApp has no
     * socket: there is no gateway role.
     */
    DATALAYER_WHATSAPP_ROLE: z.enum(["all", "ingress", "worker"]),
    /** The durable store; only development and tests may run without one. */
    DATABASE_URL: secret.optional(),
    /** The Meta app's secret: what `X-Hub-Signature-256` is computed with. */
    DATALAYER_WHATSAPP_APP_SECRET: secret,
    /** What Meta's endpoint verification must echo (`hub.verify_token`). */
    DATALAYER_WHATSAPP_VERIFY_TOKEN: z
      .string()
      .min(16, "at least 16 characters"),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && !value.DATABASE_URL)
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "production keeps its work in PostgreSQL",
      });
    if (value.DATALAYER_WHATSAPP_ROLE !== "all" && !value.DATABASE_URL)
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: `the ${value.DATALAYER_WHATSAPP_ROLE} role shares its durable queue in PostgreSQL`,
      });
  });

export type Config = z.infer<typeof schema>;

/** Every setting's name, as the service reads it. */
export const SETTINGS = Object.keys(schema.shape) as readonly string[];

/** The configuration, or an error naming each missing or malformed setting. */
export function readConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  const parsed = schema.safeParse(environment);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map(
    (issue) =>
      `${issue.path.join(".") || "configuration"}: ${environment[String(issue.path[0])] === undefined && issue.code !== "custom" ? "missing" : issue.message}`,
  );
  throw new Error(
    `Datalayer for WhatsApp cannot start:\n${problems.join("\n")}`,
  );
}
