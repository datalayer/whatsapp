import { mkdir, readFile, writeFile } from "node:fs/promises";

import { forbiddenInBundle } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { build, type BuildOptions, type Metafile } from "esbuild";

import { forbiddenInSources } from "./forbidden-sources.js";

/**
 * The service as it runs: one esbuild bundle of its sources and the
 * agent-runtimes `lib/portable` modules they reach, its `dependencies` left
 * external; then the gate over what was bundled (`forbiddenInBundle`) and
 * over the sources. `node --import tsx scripts/bundle.ts` writes `dist/` (CI
 * and the image's build stage only); `--check` bundles in memory and writes
 * nothing (`npm run check:imports`).
 */
const root = new URL("../", import.meta.url);
const pkg = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
) as { dependencies?: Record<string, string> };
export const DEPENDENCIES = Object.keys(pkg.dependencies ?? {});

export const BUNDLE: BuildOptions = {
  absWorkingDir: new URL(".", root).pathname,
  bundle: true,
  entryPoints: {
    index: "src/index.ts",
    migrate: "scripts/migrate.ts",
  },
  external: DEPENDENCIES,
  format: "esm",
  logLevel: "warning",
  metafile: true,
  outdir: "dist",
  platform: "node",
  sourcemap: true,
  target: "node22",
};

/**
 * Bundle, and the gate's violations, in words. `options` overrides the
 * bundle's (a test bundles another entry); `sources` is the folder whose
 * imports are checked.
 */
export async function bundle(
  write: boolean,
  options: Partial<BuildOptions> = {},
  sources = new URL("src", root).pathname,
): Promise<{
  metafile: Metafile;
  violations: string[];
}> {
  const { metafile } = await build({ ...BUNDLE, ...options, write });
  if (!metafile) throw new Error("esbuild answered no metafile.");
  const violations = [
    ...forbiddenInBundle(metafile, DEPENDENCIES),
    ...(await forbiddenInSources(sources)),
  ];
  return { metafile, violations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = !process.argv.includes("--check");
  const { metafile, violations } = await bundle(write);
  if (write) {
    await mkdir(new URL("dist/", root), { recursive: true });
    await writeFile(
      new URL("dist/meta.json", root),
      JSON.stringify(metafile, null, 2),
    );
  }
  if (violations.length) {
    console.error(
      `The bundle reaches what it may not:\n${violations.join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    const inputs = Object.keys(metafile.inputs);
    console.info(
      `Bundle gate passed: ${inputs.length} modules, ${inputs.filter((one) => one.includes("/lib/portable/")).length} from agent-runtimes' lib/portable, externals ${DEPENDENCIES.join(", ")}.`,
    );
  }
}
