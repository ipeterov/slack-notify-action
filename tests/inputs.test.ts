import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseJobsInput } from "../src/inputs.js";

describe("parseJobsInput", () => {
  it("accepts a single scalar (mirrors `needs: linters`)", () => {
    assert.deepEqual(parseJobsInput("linters"), ["linters"]);
  });

  it("accepts a flow list (mirrors `needs: [a, b]`)", () => {
    assert.deepEqual(parseJobsInput("[linters, tests]"), ["linters", "tests"]);
  });

  it("accepts a block list (mirrors `needs:\\n  - a\\n  - b`)", () => {
    assert.deepEqual(
      parseJobsInput("- linters\n- tests\n- deploy"),
      ["linters", "tests", "deploy"],
    );
  });

  it("trims surrounding whitespace before parsing", () => {
    assert.deepEqual(parseJobsInput("\n\n- a\n- b\n\n"), ["a", "b"]);
  });

  it("rejects empty input", () => {
    assert.throws(() => parseJobsInput(""), /empty/);
    assert.throws(() => parseJobsInput("   \n  "), /empty/);
  });

  it("rejects an empty list", () => {
    assert.throws(() => parseJobsInput("[]"), /empty list/);
  });

  it("rejects non-string entries", () => {
    assert.throws(() => parseJobsInput("- 42\n- a"), /index 0 must be a string/);
  });

  it("rejects object-shaped input", () => {
    assert.throws(() => parseJobsInput("foo: bar"), /must be a string or list/);
  });
});
