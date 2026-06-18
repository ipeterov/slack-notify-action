import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseWorkflow } from "../src/workflow.js";

describe("parseWorkflow", () => {
  it("uses `name:` when present, else the job id", () => {
    const meta = parseWorkflow(`
jobs:
  linters:
    name: Linters
    runs-on: ubuntu-latest
  tests:
    runs-on: ubuntu-latest
`);
    assert.equal(meta.get("linters")?.label, "Linters");
    assert.equal(meta.get("tests")?.label, "tests");
  });

  it("flags multi when strategy.matrix is set", () => {
    const meta = parseWorkflow(`
jobs:
  test:
    name: Test
    strategy:
      matrix:
        py: [3.12, 3.13]
`);
    assert.equal(meta.get("test")?.multi, true);
  });

  it("flags multi when `uses:` (reusable workflow) is set", () => {
    const meta = parseWorkflow(`
jobs:
  build:
    name: Build
    uses: ./.github/workflows/reusable-build.yml
`);
    assert.equal(meta.get("build")?.multi, true);
  });

  it("scalar jobs without matrix or uses are not multi", () => {
    const meta = parseWorkflow(`
jobs:
  linters:
    name: Linters
    runs-on: ubuntu-latest
`);
    assert.equal(meta.get("linters")?.multi, false);
    assert.equal(meta.get("linters")?.dynamicName, false);
  });

  it("flags dynamicName and extracts the static prefix", () => {
    const meta = parseWorkflow(`
jobs:
  build-android:
    name: 'Android (\${{ matrix.arch }})'
    strategy:
      matrix:
        arch: [aarch64, x86_64]
`);
    const m = meta.get("build-android");
    assert.equal(m?.dynamicName, true);
    assert.equal(m?.label, "Android");
  });

  it("strips trailing whitespace and opening punctuation from dynamic prefixes", () => {
    const meta = parseWorkflow(`
jobs:
  a:
    name: 'Foo \${{ x }}'
  b:
    name: 'Foo [\${{ x }}]'
  c:
    name: '\${{ x }} only'
`);
    assert.equal(meta.get("a")?.label, "Foo");
    assert.equal(meta.get("b")?.label, "Foo");
    // No static prefix → fall back to id.
    assert.equal(meta.get("c")?.label, "c");
  });

  it("returns an empty map for malformed input", () => {
    assert.equal(parseWorkflow("").size, 0);
    assert.equal(parseWorkflow("not: a workflow").size, 0);
    assert.equal(parseWorkflow("jobs: [a, b]").size, 0); // jobs must be a mapping
  });
});
