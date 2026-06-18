import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Job, Run } from "../src/github.js";
import { renderCard } from "../src/render.js";
import type { WatchedJob } from "../src/render.js";

function fakeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    run_number: 42,
    run_attempt: 1,
    html_url: "https://github.com/o/r/actions/runs/1",
    head_branch: "main",
    head_sha: "abcdef1234567",
    path: ".github/workflows/ci.yml",
    status: "in_progress",
    conclusion: null,
    triggering_actor: { login: "octocat" },
    head_commit: { message: "fix the build", author: { name: "Octo Cat" } },
    ...overrides,
  };
}

function fakeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    name: "Tests",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/o/r/actions/runs/1/job/1",
    started_at: "2024-01-01T00:00:00Z",
    completed_at: "2024-01-01T00:01:30Z",
    labels: [],
    ...overrides,
  };
}

function watched(rows: Job[], label = "Tests", multi = false): WatchedJob {
  return { id: "tests", label, rows, multi };
}

function allText(blocks: Array<Record<string, unknown>>): string {
  return JSON.stringify(blocks);
}

describe("renderCard (Slack Block Kit)", () => {
  it("emits an attachment color and Block Kit blocks", () => {
    const card = renderCard([watched([fakeJob()])], fakeRun(), "o/r");
    assert.equal(card.color, "#57ab5a"); // all-success
    assert.ok(Array.isArray(card.blocks) && card.blocks.length > 0);
    assert.ok(card.fallback.includes("run #42"));
  });

  it("uses mrkdwn link syntax <url|text>, not Markdown [text](url)", () => {
    const card = renderCard([watched([fakeJob()])], fakeRun(), "o/r");
    const text = allText(card.blocks);
    assert.ok(text.includes("<https://github.com/o/r/actions/runs/1|"));
    assert.ok(!text.includes("](")); // no Markdown links leaked in
  });

  it("uses mrkdwn bold *label*, not Markdown **label**", () => {
    const card = renderCard([watched([fakeJob()], "Linters")], fakeRun(), "o/r");
    const text = allText(card.blocks);
    assert.ok(text.includes("*Linters*"));
    assert.ok(!text.includes("**Linters**"));
  });

  it("does not enable channel pings from commit/job text", () => {
    const run = fakeRun({
      head_commit: { message: "@here ping everyone", author: { name: "x" } },
    });
    // A job label crafted to look like a Slack broadcast.
    const card = renderCard([watched([fakeJob()], "<!channel>")], run, "o/r");
    const text = allText(card.blocks);
    // The dangerous `<!channel>` / `<!here>` sequences must be escaped so Slack
    // renders them as literal text rather than broadcasts.
    assert.ok(!text.includes("<!channel>"));
    assert.ok(text.includes("&lt;!channel&gt;"));
  });

  it("escapes &, <, > in repo/commit context", () => {
    const run = fakeRun({
      head_commit: { message: "a < b && c > d", author: { name: "x" } },
    });
    const card = renderCard([watched([fakeJob()])], run, "o/r");
    const text = allText(card.blocks);
    assert.ok(text.includes("&lt;"));
    assert.ok(text.includes("&gt;"));
    assert.ok(text.includes("&amp;"));
  });

  it("renders a failure color when a watched job fails", () => {
    const card = renderCard(
      [watched([fakeJob({ conclusion: "failure" })])],
      fakeRun(),
      "o/r",
    );
    assert.equal(card.color, "#e5534b");
  });

  it("uses GitHub's run number in the title by default", () => {
    const card = renderCard([watched([fakeJob()])], fakeRun(), "o/r");
    assert.ok(card.fallback.includes("run #42"));
    assert.ok(allText(card.blocks).includes("run #42"));
  });

  it("overrides the title with a caller-supplied build number", () => {
    const card = renderCard(
      [watched([fakeJob()])],
      fakeRun(),
      "o/r",
      false,
      "fields",
      "6128",
    );
    const text = allText(card.blocks);
    assert.ok(text.includes("build #6128"));
    assert.ok(!text.includes("run #42"));
  });

  it("auto layout: ≤5 jobs use one section, 2 fields per job", () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      watched([fakeJob()], `Job ${i}`),
    );
    const card = renderCard(jobs, fakeRun(), "o/r");
    const sections = card.blocks.filter((b) => b["type"] === "section");
    assert.equal(sections.length, 1);
    assert.equal((sections[0]!["fields"] as unknown[]).length, 10); // 5 × 2
  });

  it("auto layout: 6–10 jobs use one columns section, 1 field per job", () => {
    const jobs = Array.from({ length: 6 }, (_, i) =>
      watched([fakeJob()], `Job ${i}`),
    );
    const card = renderCard(jobs, fakeRun(), "o/r");
    const sections = card.blocks.filter((b) => b["type"] === "section");
    assert.equal(sections.length, 1); // no inter-section gap
    assert.equal((sections[0]!["fields"] as unknown[]).length, 6); // 6 × 1
  });

  it("auto layout: >10 jobs chunk into multiple columns sections", () => {
    const jobs = Array.from({ length: 11 }, (_, i) =>
      watched([fakeJob()], `Job ${i}`),
    );
    const card = renderCard(jobs, fakeRun(), "o/r");
    const sections = card.blocks.filter((b) => b["type"] === "section");
    assert.equal(sections.length, 2); // 10 + 1
    const total = sections.reduce(
      (n, s) => n + (s["fields"] as unknown[]).length,
      0,
    );
    assert.equal(total, 11);
  });

  it("shows a monitoring-stopped notice and error color", () => {
    const card = renderCard([watched([fakeJob()])], fakeRun(), "o/r", true);
    assert.equal(card.color, "#8957e5");
    assert.ok(allText(card.blocks).includes("Monitoring stopped"));
  });
});
