import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseJobsInput, parseLayout, parsePollInterval } from "../src/inputs.js";

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

describe("parseLayout", () => {
  it("defaults to detailed on empty input", () => {
    assert.equal(parseLayout(""), "detailed");
    assert.equal(parseLayout("   "), "detailed");
  });

  it("accepts detailed and compact, case-insensitively", () => {
    assert.equal(parseLayout("detailed"), "detailed");
    assert.equal(parseLayout("compact"), "compact");
    assert.equal(parseLayout("COMPACT"), "compact");
  });

  it("rejects unknown layouts", () => {
    assert.throws(() => parseLayout("table"), /Expected 'detailed' or 'compact'/);
  });
});

describe("parsePollInterval", () => {
  it("defaults to 5s on empty input", () => {
    assert.equal(parsePollInterval(""), 5_000);
    assert.equal(parsePollInterval("  "), 5_000);
  });

  it("converts seconds to milliseconds", () => {
    assert.equal(parsePollInterval("1"), 1_000);
    assert.equal(parsePollInterval("10"), 10_000);
    assert.equal(parsePollInterval("2.5"), 2_500);
  });

  it("rejects intervals below 1 second", () => {
    assert.throws(() => parsePollInterval("0"), /at least 1 second/);
    assert.throws(() => parsePollInterval("0.5"), /at least 1 second/);
    assert.throws(() => parsePollInterval("-3"), /at least 1 second/);
  });

  it("rejects non-numeric input", () => {
    assert.throws(() => parsePollInterval("fast"), /Expected a number of seconds/);
  });
});
