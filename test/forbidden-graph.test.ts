import { describe, expect, it } from "vitest";

import { bundle, DEPENDENCIES } from "../scripts/bundle.js";
import { forbiddenInSources } from "../scripts/forbidden-sources.js";

/**
 * What the service runs is one esbuild bundle: its sources and
 * agent-runtimes' `lib/portable/hosts`, nothing of Jupyter, React or another
 * package; its dependencies external. Bundled here in memory (`write:
 * false`): analysis, nothing written.
 */
describe("the bundle graph", () => {
  it("bundles the sources and agent-runtimes' lib/portable only, and passes the gate", async () => {
    const { metafile, violations } = await bundle(false);
    expect(violations).toEqual([]);
    const inputs = Object.keys(metafile.inputs);
    expect(inputs.some((one) => one.includes("/lib/portable/hosts/"))).toBe(
      true,
    );
    for (const input of inputs)
      expect(
        input.startsWith("src/") ||
          input.startsWith("scripts/") ||
          /agent-runtimes\/lib\/portable\//.test(input),
        input,
      ).toBe(true);
    expect(inputs.some((one) => one.endsWith("/lib/portable/index.js"))).toBe(
      false,
    );
  }, 60_000);

  it("passes on this service's sources", async () => {
    await expect(forbiddenInSources("src")).resolves.toEqual([]);
  });

  it("refuses a source that imports React, in the bundle and in the sources", async () => {
    const folder = "test/fixtures/forbidden";
    const { violations } = await bundle(
      false,
      {
        entryPoints: { forbidden: `${folder}/imports-react.mjs` },
        // React is not installed beside the service: kept external, it is
        // still named by the bundle's imports, where the gate reads it.
        external: [...DEPENDENCIES, "react"],
      },
      folder,
    );
    expect(violations).toEqual([
      "react: react is forbidden",
      `${folder}/imports-react.mjs: react`,
    ]);
  }, 60_000);
});
