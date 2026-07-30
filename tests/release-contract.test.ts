import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const packageRunners = new Set(["bunx", "npx"]);
const spawnTimeout = 300_000;

type PackageJson = {
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
};

type ContractManifest = {
  metadata?: { release?: { artifactScan?: { script?: string } } };
};

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(repoRoot, name), "utf-8")) as T;
}

function scripts(pkg: PackageJson): Record<string, string> {
  return pkg.scripts ?? {};
}

/** Names of the scripts `bun run <name>` reaches from `entry`, including `entry`. */
function scriptGraph(all: Record<string, string>, entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || seen.has(name) || !(name in all)) continue;
    seen.add(name);
    const tokens = all[name]!.split(/\s+/).filter(Boolean);
    for (const [index, token] of tokens.entries()) {
      if (token !== "run") continue;
      const previous = tokens[index - 1];
      const next = tokens[index + 1];
      if ((previous === "bun" || previous === "npm") && next !== undefined) pending.push(next);
    }
  }
  return seen;
}

/** `bunx`/`npx` package specs in a script body, e.g. `@hasna/contracts@0.8.5`. */
function packageRunnerSpecs(body: string): string[] {
  const specs: string[] = [];
  for (const segment of body.split(/&&|\|\||;/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    for (const [index, token] of tokens.entries()) {
      if (!packageRunners.has(token)) continue;
      const spec = tokens.slice(index + 1).find((candidate) => !candidate.startsWith("-"));
      if (spec !== undefined) specs.push(spec);
      break;
    }
  }
  return specs;
}

function isVersionPinned(spec: string): boolean {
  return spec.indexOf("@", spec.startsWith("@") ? 1 : 0) !== -1;
}

/** The pinned contract-kit spec plus its argv, taken from the named script. */
function kitInvocation(body: string): { spec: string; args: string[] } {
  const tokens = body.trim().split(/\s+/).filter(Boolean);
  const runnerAt = tokens.findIndex((token) => packageRunners.has(token));
  expect(runnerAt).toBeGreaterThanOrEqual(0);
  const specAt = tokens.findIndex((token, index) => index > runnerAt && !token.startsWith("-"));
  expect(specAt).toBeGreaterThan(runnerAt);
  return { spec: tokens[specAt]!, args: tokens.slice(specAt + 1) };
}

async function run(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

test(
  "the committed manifest passes contract repo-conformance",
  async () => {
    const pkg = await readJson<PackageJson>("package.json");
    const check = scripts(pkg)["contract:check"];
    expect(check).toBeDefined();

    const result = await run(["bun", "run", "contract:check"]);
    expect(`${result.stdout}${result.stderr}`).toContain("pass manifest_valid");
    expect(result.exitCode).toBe(0);
  },
  spawnTimeout,
);

test(
  "contract:check names a subcommand the pinned contract kit actually exposes",
  async () => {
    const pkg = await readJson<PackageJson>("package.json");
    const { spec, args } = kitInvocation(scripts(pkg)["contract:check"]!);
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    expect(subcommand).toBeDefined();

    const help = await run(["bunx", spec, "--help"]);
    expect(help.exitCode).toBe(0);
    const commands = `${help.stdout}${help.stderr}`
      .split("\n")
      .map((line) => /^\s{2,}([a-z][a-z0-9-]*)\s/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(commands).toContain(subcommand!);
  },
  spawnTimeout,
);

test("artifact-scan passes a scan target to the contract kit", async () => {
  const pkg = await readJson<PackageJson>("package.json");
  const manifest = await readJson<ContractManifest>("hasna.contract.json");

  const scanScript = manifest.metadata?.release?.artifactScan?.script;
  expect(scanScript).toBeDefined();

  const { args } = kitInvocation(scripts(pkg)[scanScript!]!);
  const positional = args.filter((arg) => !arg.startsWith("-"));
  // subcommand plus the required <target> argument
  expect(positional.length).toBeGreaterThanOrEqual(2);
});

test("every package-runner invocation in the scripts is version-pinned", async () => {
  const pkg = await readJson<PackageJson>("package.json");
  const unpinned = Object.entries(scripts(pkg)).flatMap(([name, body]) =>
    packageRunnerSpecs(body)
      .filter((spec) => !isVersionPinned(spec))
      .map((spec) => `${name}: ${spec}`),
  );
  expect(unpinned).toEqual([]);
});

test("prepack reaches the declared artifact scan and prepublishOnly still builds", async () => {
  const pkg = await readJson<PackageJson>("package.json");
  const manifest = await readJson<ContractManifest>("hasna.contract.json");
  const all = scripts(pkg);

  const scanScript = manifest.metadata?.release?.artifactScan?.script;
  expect(scanScript).toBeDefined();
  expect([...scriptGraph(all, "prepack")]).toContain(scanScript!);
  expect([...scriptGraph(all, "prepublishOnly")]).toContain("build");
});

test(
  "packing succeeds and the tarball carries every declared bin",
  async () => {
    const pkg = await readJson<PackageJson>("package.json");
    const bins = Object.values(pkg.bin ?? {});
    expect(bins.length).toBeGreaterThan(0);

    const result = await run(["bun", "pm", "pack", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    for (const bin of bins) {
      expect(result.stdout).toContain(bin);
    }
  },
  spawnTimeout,
);
