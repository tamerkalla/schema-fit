import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Example {
  lang: "ts" | "bash";
  code: string;
  expected: string;
}

// Finds every (code block, claimed output) pair in a markdown document. The
// convention this project's docs follow: a fenced ```ts or ```bash block,
// then a line reading "Output:" or "Expected output:", then a fenced
// ```text block holding the exact text the code is claimed to print. Neither
// captured group may itself contain a "```" line, so blocks can't swallow
// one another.
function extractExamples(markdown: string): Example[] {
  const re =
    /```(ts|bash)\n((?:(?!```)[\s\S])*?)\n```\n\n(?:Output|Expected output):\n\n```text\n((?:(?!```)[\s\S])*?)\n```/g;
  const examples: Example[] = [];
  for (const m of markdown.matchAll(re)) {
    examples.push({ lang: m[1] as Example["lang"], code: m[2] as string, expected: m[3] as string });
  }
  return examples;
}

describe("README.md structure", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const hook =
    "Rewrite a JSON Schema so a specific LLM provider will accept it — without ever\nwidening what the schema allows.";

  test("opens with the fixed hook", () => {
    expect(readme.startsWith(`# schema-fit\n\n${hook}\n`)).toBe(true);
  });

  test("the badge row appears character-for-character, immediately after the hook", () => {
    const badges = [
      "[![build](https://github.com/tamerkalla/schema-fit/actions/workflows/release.yml/badge.svg)](https://github.com/tamerkalla/schema-fit/actions/workflows/release.yml)",
      "[![npm](https://img.shields.io/npm/v/schema-fit.svg)](https://www.npmjs.com/package/schema-fit)",
      "[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)",
      "[![provenance](https://img.shields.io/badge/provenance-attested-brightgreen.svg)](https://www.npmjs.com/package/schema-fit)",
    ].join("\n");
    const badgeIndex = readme.indexOf(badges);
    const hookIndex = readme.indexOf(hook);
    expect(badgeIndex).toBeGreaterThan(-1);
    expect(badgeIndex).toBeGreaterThan(hookIndex);
    expect(readme.slice(hookIndex + hook.length, badgeIndex)).toBe("\n\n");
  });

  test("links to schema-envoy's npm page, not its GitHub repo, in Related", () => {
    expect(readme).toMatch(/\[`schema-envoy`\]\(https:\/\/www\.npmjs\.com\/package\/schema-envoy\)/);
  });
});

describe("the README's Usage example is executed and matches its inline comments", () => {
  // The Usage section shows check()/fit() results as commented-out return
  // values rather than an "Output:" transcript, so it is checked
  // programmatically here instead of by the text-diff convention above.
  test("check reports the three documented violations, and fit's result matches", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const match = readme.match(/```ts\nimport \{ check, fit, profiles \} from 'schema-fit';\n([\s\S]*?)\n```/);
    expect(match).not.toBeNull();
    const declarations = match![1]!
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const script = join(ROOT, ".tmp-usage-example.mjs");
    const probe = [
      'import { check, fit, profiles } from "schema-fit";',
      declarations,
      "const before = check(schema, profiles.openaiStrict);",
      "console.log(JSON.stringify({",
      "  beforeOk: before.ok,",
      "  beforeViolations: before.violations.length,",
      "  required: fitted.required,",
      "  additionalProperties: fitted.additionalProperties,",
      "  lossless,",
      "}));",
    ].join("\n");
    writeFileSync(script, probe);
    try {
      const result = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: "utf8" });
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.beforeOk).toBe(false);
      expect(parsed.beforeViolations).toBe(3);
      expect(parsed.required).toEqual(["query", "limit"]);
      expect(parsed.additionalProperties).toBe(false);
      expect(parsed.lossless).toBe(false);
    } finally {
      rmSync(script, { force: true });
    }
  });
});

describe("every code example in VERIFY.md is executed and its output matches", () => {
  const verify = readFileSync(join(ROOT, "VERIFY.md"), "utf8");
  const examples = extractExamples(verify);

  test("does not require this repository to be checked out", () => {
    expect(verify.replace(/\s+/g, " ")).toMatch(/does not require this repository to be checked out/);
  });

  test("installs by the latest tag into a clean directory", () => {
    expect(verify).toMatch(/npm install schema-fit@latest/);
    expect(verify).toMatch(/mkdir -p/);
  });

  test("at least one example was found", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  let tarballPath: string;
  let packDir: string;

  beforeAll(() => {
    packDir = mkdtempSync(join(tmpdir(), "schema-fit-verify-pack-"));
    const pack = spawnSync("npm", ["pack", "--silent", "--pack-destination", packDir], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(pack.status).toBe(0);
    const tarballName = pack.stdout.trim().split("\n").pop()!.trim();
    tarballPath = join(packDir, tarballName);
    expect(existsSync(tarballPath)).toBe(true);
  }, 120_000);

  afterAll(() => {
    rmSync(packDir, { recursive: true, force: true });
  });

  for (const [i, example] of examples.entries()) {
    if (!example.code.includes("npm install schema-fit@latest")) continue;
    test(`example ${i + 1} (installed from the published tarball) reproduces the claimed output`, () => {
      const dir = mkdtempSync(join(tmpdir(), "schema-fit-verify-run-"));
      try {
        // The doc installs from the registry; the test instead reproduces the
        // installed layout by copying this repo's own dependency tree
        // (already resolved by npm ci — it holds ajv, which the script
        // needs) and swapping in the tarball this repository just built for
        // schema-fit itself. A fresh, lockfile-less `npm install` here would
        // need the network to resolve versions, and no test may reach it.
        const replacement = [
          `cp -r ${JSON.stringify(join(ROOT, "node_modules"))} node_modules`,
          "rm -rf node_modules/schema-fit",
          `tar -xzf ${JSON.stringify(tarballPath)} -C node_modules`,
          "mv node_modules/package node_modules/schema-fit",
        ].join("\n");
        const prepared = example.code.replace(
          /npm init -y >\/dev\/null 2>&1\nnpm install schema-fit@latest ajv@8 >\/dev\/null 2>&1/,
          replacement,
        );
        const script = join(dir, "run.sh");
        writeFileSync(script, prepared);
        const result = spawnSync("bash", [script], { cwd: dir, encoding: "utf8" });
        expect(result.stderr).toBe("");
        expect(result.stdout.trim()).toBe(example.expected.trim());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
