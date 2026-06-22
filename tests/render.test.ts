import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Job, Run } from "../src/github.js";
import { renderCard } from "../src/render.js";
import type { WatchedJob } from "../src/render.js";

function fakeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    name: "CI",
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

  it("title carries repo, workflow name, and build/run number", () => {
    const card = renderCard([watched([fakeJob()])], fakeRun({ name: "Deploy" }), "octo/repo");
    const header = card.blocks.find((b) => b["type"] === "header")!;
    const title = (header["text"] as { text: string }).text;
    assert.ok(title.includes("repo")); // repoShort, for multi-repo channels
    assert.ok(title.includes("Deploy")); // real workflow name, not hardcoded CI
    assert.ok(title.includes("run #42"));
  });

  it("freezes runtime once all watched jobs are terminal", () => {
    // completed job: 00:00:00 → 00:01:30 = 1m 30s, regardless of `now`.
    const card = renderCard([watched([fakeJob()])], fakeRun(), "o/r");
    const title = (
      card.blocks.find((b) => b["type"] === "header")!["text"] as { text: string }
    ).text;
    assert.ok(title.includes("1m 30s"), title);
  });

  it("ticks live elapsed time while a watched job is in progress", () => {
    // Started just now, not yet complete → runtime = now − start, which keeps
    // advancing on each poll/update rather than freezing.
    const startedAt = new Date(Date.now() - 65_000).toISOString(); // 65s ago
    const job = fakeJob({
      status: "in_progress",
      conclusion: null,
      started_at: startedAt,
      completed_at: null,
    });
    const card = renderCard([watched([job])], fakeRun(), "o/r");
    const title = (
      card.blocks.find((b) => b["type"] === "header")!["text"] as { text: string }
    ).text;
    assert.ok(/· 1m/.test(title), title); // ~1m elapsed and counting
  });

  it("shows `running` before any watched job has started", () => {
    // Queued job: no started_at yet → no measurable runtime → `running`.
    const job = fakeJob({
      status: "queued",
      conclusion: null,
      started_at: null,
      completed_at: null,
    });
    const card = renderCard([watched([job])], fakeRun(), "o/r");
    const title = (
      card.blocks.find((b) => b["type"] === "header")!["text"] as { text: string }
    ).text;
    assert.ok(title.includes("running"), title);
  });

  it("footer pairs the card to the push: author · subject · run link, no logo", () => {
    const card = renderCard([watched([fakeJob()])], fakeRun(), "o/r");
    // The footer is the last context block.
    const contexts = card.blocks.filter((b) => b["type"] === "context");
    const footer = contexts[contexts.length - 1]!;
    const els = footer["elements"] as Array<{ type: string; text?: string }>;
    assert.ok(!els.some((e) => e.type === "image")); // logo dropped
    const text = els.map((e) => e.text ?? "").join(" ");
    assert.ok(text.includes("Octo Cat")); // author
    assert.ok(text.includes("fix the build")); // subject
    assert.ok(text.includes("<https://github.com/o/r/actions/runs/1|")); // run link
  });

  it("uses mrkdwn link syntax <url|text>, not Markdown [text](url)", () => {
    const card = renderCard([watched([fakeJob()])], fakeRun(), "o/r");
    const text = allText(card.blocks);
    assert.ok(text.includes("<https://github.com/o/r/actions/runs/1|"));
    assert.ok(!text.includes("](")); // no Markdown links leaked in
  });

  it("links the job name to its logs in mrkdwn <url|text> form", () => {
    const card = renderCard([watched([fakeJob()], "Linters")], fakeRun(), "o/r");
    const text = allText(card.blocks);
    // The job name is the logs link, not a separate `logs ↗︎`.
    assert.ok(text.includes("|Linters>"));
    assert.ok(!text.includes("logs"));
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
      "detailed",
      "6128",
    );
    const text = allText(card.blocks);
    assert.ok(text.includes("build #6128"));
    assert.ok(!text.includes("run #42"));
  });

  it("detailed (default): ≤5 jobs use one section, 2 fields per job", () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      watched([fakeJob()], `Job ${i}`),
    );
    const card = renderCard(jobs, fakeRun(), "o/r");
    const sections = card.blocks.filter((b) => b["type"] === "section");
    assert.equal(sections.length, 1);
    assert.equal((sections[0]!["fields"] as unknown[]).length, 10); // 5 × 2
  });

  it("detailed: >5 jobs chunk into further 5-job sections", () => {
    const jobs = Array.from({ length: 6 }, (_, i) =>
      watched([fakeJob()], `Job ${i}`),
    );
    const card = renderCard(jobs, fakeRun(), "o/r", false, "detailed");
    const sections = card.blocks.filter((b) => b["type"] === "section");
    assert.equal(sections.length, 2); // 5 + 1
    const total = sections.reduce(
      (n, s) => n + (s["fields"] as unknown[]).length,
      0,
    );
    assert.equal(total, 12); // 6 jobs × 2 fields
  });

  it("detailed: shows the running step beside an in-progress job", () => {
    const job = fakeJob({
      status: "in_progress",
      conclusion: null,
      completed_at: null,
      steps: [
        { name: "Set up job", status: "completed", conclusion: "success", number: 1 },
        { name: "Monitor rolling update", status: "in_progress", conclusion: null, number: 2 },
      ],
    });
    const card = renderCard([watched([job], "Deploy")], fakeRun(), "o/r");
    // Counter (proportional) sits outside the monospace pill: (2/2) `name`.
    assert.ok(allText(card.blocks).includes("(2/2) `Monitor rolling update`"));
  });

  it("detailed: shows the failed step beside a failed job", () => {
    const job = fakeJob({
      conclusion: "failure",
      steps: [
        { name: "Run npm ci", status: "completed", conclusion: "success", number: 1 },
        { name: "Run npx playwright test", status: "completed", conclusion: "failure", number: 2 },
      ],
    });
    const card = renderCard([watched([job], "Tests")], fakeRun(), "o/r");
    assert.ok(allText(card.blocks).includes("(2/2) `Run npx playwright test`"));
  });

  it("detailed: counter uses step.number, so teardown gaps stay monotonic", () => {
    // Real GitHub numbering: work steps 1–7, then teardown jumps to 13–15.
    // A running teardown must read (13/15), never past-the-end.
    const job = fakeJob({
      status: "in_progress",
      conclusion: null,
      completed_at: null,
      steps: [
        { name: "Run npm test", status: "completed", conclusion: "success", number: 7 },
        { name: "Post Run actions/checkout", status: "in_progress", conclusion: null, number: 13 },
        { name: "Complete job", status: "queued", conclusion: null, number: 15 },
      ],
    });
    const card = renderCard([watched([job], "Tests")], fakeRun(), "o/r");
    assert.ok(allText(card.blocks).includes("(13/15) `Post Run actions/checkout`"));
  });

  it("shows the conclusion word for a skipped job, not `done`", () => {
    const job = fakeJob({
      conclusion: "skipped",
      started_at: null,
      completed_at: null,
    });
    const card = renderCard([watched([job], "Build")], fakeRun(), "o/r");
    const text = allText(card.blocks);
    assert.ok(text.includes("skipped"));
    assert.ok(!text.includes("done"));
  });

  it("shows the conclusion word alongside the duration for a success", () => {
    const card = renderCard([watched([fakeJob()], "Tests")], fakeRun(), "o/r");
    const text = allText(card.blocks);
    // Decoded for every conclusion, not just the non-success ones.
    assert.ok(text.includes("success"));
    assert.ok(text.includes("1m 30s"));
  });

  it("decodes a cancelled job's conclusion", () => {
    const job = fakeJob({ conclusion: "cancelled" });
    const card = renderCard([watched([job], "Deploy")], fakeRun(), "o/r");
    assert.ok(allText(card.blocks).includes("cancelled"));
  });

  it("matrix collapse counts combinations as N jobs (GitHub's wording)", () => {
    const rows = [
      fakeJob({ name: "Tests (3.11)" }),
      fakeJob({ name: "Tests (3.12)" }),
      fakeJob({ name: "Tests (3.13)" }),
    ];
    const card = renderCard([watched(rows, "Tests", true)], fakeRun(), "o/r");
    const text = allText(card.blocks);
    assert.ok(text.includes("3 jobs"));
    assert.ok(!text.includes("combos"));
  });

  it("matrix runtime freezes at earliest-start → latest-finish when done", () => {
    // Combo A: 00:00:00 → 00:02:00 (2m). Combo B starts later, 00:00:30 →
    // 00:03:30 (3m). Wall-clock = 00:00:00 → 00:03:30 = 3m 30s.
    const rows = [
      fakeJob({
        name: "Tests (a)",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:02:00Z",
      }),
      fakeJob({
        name: "Tests (b)",
        started_at: "2024-01-01T00:00:30Z",
        completed_at: "2024-01-01T00:03:30Z",
      }),
    ];
    const card = renderCard([watched(rows, "Tests", true)], fakeRun(), "o/r");
    assert.ok(allText(card.blocks).includes("3m 30s"), allText(card.blocks));
  });

  it("matrix runtime ticks live while combos are still running", () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString(); // 65s ago
    const rows = [
      // Combo A finished; combo B still running. Both started ~65s ago, so
      // wall-clock (earliest start → now) is ~1m and counting.
      fakeJob({
        name: "Tests (a)",
        started_at: startedAt,
        completed_at: new Date(Date.now() - 5_000).toISOString(),
      }),
      fakeJob({
        name: "Tests (b)",
        status: "in_progress",
        conclusion: null,
        started_at: startedAt,
        completed_at: null,
      }),
    ];
    const card = renderCard([watched(rows, "Tests", true)], fakeRun(), "o/r");
    // ~1m elapsed since the earliest start and counting.
    assert.ok(/1m/.test(allText(card.blocks)), allText(card.blocks));
  });

  it("detailed: renders the step name in monospace (backticks)", () => {
    const job = fakeJob({
      status: "in_progress",
      conclusion: null,
      completed_at: null,
      steps: [
        { name: "Set up job", status: "completed", conclusion: "success", number: 1 },
        { name: "Run build", status: "in_progress", conclusion: null, number: 2 },
      ],
    });
    const card = renderCard([watched([job], "Build")], fakeRun(), "o/r");
    assert.ok(allText(card.blocks).includes("(2/2) `Run build`"));
  });

  it("detailed: truncates a long step name to the no-wrap budget, keeping max text", () => {
    const longName = "Run a really long auto-generated step name that overflows";
    const job = fakeJob({
      status: "in_progress",
      conclusion: null,
      completed_at: null,
      steps: [
        { name: "Set up job", status: "completed", conclusion: "success", number: 1 },
        { name: longName, status: "in_progress", conclusion: null, number: 2 },
      ],
    });
    const card = renderCard([watched([job], "Build")], fakeRun(), "o/r");
    // Name truncated to 29 chars (28 + "…") inside the pill; counter outside.
    // Assert the full expected string so we catch any change to what we keep.
    const expectedName = longName.slice(0, 28) + "…"; // 29 chars
    assert.equal(expectedName.length, 29);
    assert.ok(
      allText(card.blocks).includes(`(2/2) \`${expectedName}\``),
      allText(card.blocks),
    );
  });

  it("detailed: omits the counter while only the setup step exists", () => {
    // Spin-up: GitHub reports a single "Set up job" step before the real list
    // materializes. `(1/1)` would be misleading, so show the name bare.
    const job = fakeJob({
      status: "in_progress",
      conclusion: null,
      completed_at: null,
      steps: [
        { name: "Set up job", status: "in_progress", conclusion: null, number: 1 },
      ],
    });
    const card = renderCard([watched([job], "Tests")], fakeRun(), "o/r");
    const text = allText(card.blocks);
    assert.ok(text.includes("Set up job"));
    assert.ok(!text.includes("(1/1)"));
  });

  it("detailed: no step line for a successful job", () => {
    const job = fakeJob({
      steps: [
        { name: "Run npm test", status: "completed", conclusion: "success", number: 1 },
      ],
    });
    const card = renderCard([watched([job], "Tests")], fakeRun(), "o/r");
    // A completed-success job surfaces no step; col2 is the blank placeholder.
    assert.ok(!allText(card.blocks).includes("Run npm test"));
  });

  it("compact: 1 field per job, no step line", () => {
    const job = fakeJob({
      status: "in_progress",
      conclusion: null,
      completed_at: null,
      steps: [
        { name: "Monitor rolling update", status: "in_progress", conclusion: null, number: 1 },
      ],
    });
    const card = renderCard([watched([job], "Deploy")], fakeRun(), "o/r", false, "compact");
    const sections = card.blocks.filter((b) => b["type"] === "section");
    assert.equal((sections[0]!["fields"] as unknown[]).length, 1); // 1 × 1
    assert.ok(!allText(card.blocks).includes("Monitor rolling update"));
  });

  it("compact: fills column-major (A D / B E / C F), not row-major", () => {
    const labels = ["A", "B", "C", "D", "E", "F"];
    const jobs = labels.map((l) => watched([fakeJob()], l));
    const card = renderCard(jobs, fakeRun(), "o/r", false, "compact");
    const section = card.blocks.find((b) => b["type"] === "section")!;
    const order = (section["fields"] as Array<{ text: string }>).map((f) =>
      // pull the linked label out of `:emoji: <url|Label> · …`
      f.text.replace(/^.*\|([^>]+)>.*$/, "$1"),
    );
    // Slack lays these row-major, so to read A,B,C down the left column and
    // D,E,F down the right, the field array must be A,D,B,E,C,F.
    assert.deepEqual(order, ["A", "D", "B", "E", "C", "F"]);
  });

  it("compact: >10 jobs chunk into multiple sections", () => {
    const jobs = Array.from({ length: 11 }, (_, i) =>
      watched([fakeJob()], `Job ${i}`),
    );
    const card = renderCard(jobs, fakeRun(), "o/r", false, "compact");
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
