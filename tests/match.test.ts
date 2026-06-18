import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Job } from "../src/github.js";
import { matchJobs } from "../src/match.js";
import { parseWorkflow } from "../src/workflow.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures");

function fakeMeta(label: string, multi = false): {
  label: string;
  multi: boolean;
  dynamicName: boolean;
} {
  return { label, multi, dynamicName: false };
}

function fakeJob(name: string): Job {
  return {
    id: 1,
    name,
    status: "completed",
    conclusion: "success",
    html_url: null,
  };
}

describe("matchJobs (synthetic)", () => {
  it("matches exact name", () => {
    const out = matchJobs(fakeMeta("Linters"), [fakeJob("Linters")]);
    assert.equal(out.length, 1);
  });

  it("matches matrix combos via `(` suffix", () => {
    const out = matchJobs(fakeMeta("Tests", true), [
      fakeJob("Tests (3.12)"),
      fakeJob("Tests (3.13)"),
      fakeJob("Other"),
    ]);
    assert.deepEqual(
      out.map((j) => j.name),
      ["Tests (3.12)", "Tests (3.13)"],
    );
  });

  it("matches reusable-workflow children via ` / ` suffix", () => {
    const out = matchJobs(fakeMeta("Docs", true), [
      fakeJob("Docs / Check EPUB"),
      fakeJob("Docs / Doctest"),
      fakeJob("Other"),
    ]);
    assert.equal(out.length, 2);
  });

  it("does not match unrelated prefixes (e.g. 'Test' vs 'Tests')", () => {
    const out = matchJobs(fakeMeta("Test"), [fakeJob("Tests (3.12)")]);
    assert.equal(out.length, 0);
  });

  it("does not match substrings inside the name", () => {
    const out = matchJobs(fakeMeta("Build"), [fakeJob("Pre-Build (a)")]);
    assert.equal(out.length, 0);
  });
});

describe("matchJobs (cpython fixture)", () => {
  const workflowYaml = fs.readFileSync(
    path.join(FIXTURES, "cpython-build.yml"),
    "utf8",
  );
  const jobsData = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, "cpython-jobs.json"), "utf8"),
  ) as { jobs: Job[] };
  const meta = parseWorkflow(workflowYaml);

  const cases: Array<{ id: string; expectedCount: number; expectedNames: string[] }> = [
    {
      id: "build-android",
      expectedCount: 2,
      expectedNames: ["Android (aarch64)", "Android (x86_64)"],
    },
    {
      id: "build-asan",
      expectedCount: 1,
      expectedNames: ["Address sanitizer (ubuntu-24.04)"],
    },
    {
      id: "build-ubuntu-ssltests",
      expectedCount: 8,
      expectedNames: [],
    },
    {
      id: "test-hypothesis",
      expectedCount: 1,
      expectedNames: ["Hypothesis tests on Ubuntu"],
    },
    {
      id: "check-docs",
      expectedCount: 4,
      expectedNames: [],
    },
    {
      id: "build-context",
      expectedCount: 1,
      expectedNames: ["Change detection / Create context from changed files"],
    },
    // Dynamic-name jobs whose static prefix happens to also catch the
    // "(free-threading)" variant via the matrix-combo pattern.
    { id: "build-ubuntu", expectedCount: 4, expectedNames: [] },
    { id: "build-windows", expectedCount: 7, expectedNames: [] },
    { id: "build-macos", expectedCount: 3, expectedNames: [] },
  ];

  for (const c of cases) {
    it(`matches ${c.id} → ${c.expectedCount} job(s)`, () => {
      const m = meta.get(c.id);
      assert.ok(m, `id '${c.id}' missing from workflow`);
      const out = matchJobs(m, jobsData.jobs);
      assert.equal(
        out.length,
        c.expectedCount,
        `expected ${c.expectedCount}, got ${out.length}: ${out
          .map((j) => j.name)
          .join(", ")}`,
      );
      if (c.expectedNames.length > 0) {
        const got = new Set(out.map((j) => j.name));
        for (const expected of c.expectedNames) {
          assert.ok(got.has(expected), `missing expected match '${expected}'`);
        }
      }
    });
  }
});
