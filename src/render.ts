import type { Job, Run, Step } from "./github.js";

const STATE_EMOJI: Record<string, string> = {
  "queued|": "🅿️",
  "pending|": "🅿️",
  "waiting|": "⏳",
  "in_progress|": "⚙️",
  "completed|success": "✅",
  "completed|failure": "❌",
  "completed|cancelled": "🚫",
  "completed|skipped": "⏭️",
  "completed|timed_out": "⏱️",
  "completed|action_required": "⚠️",
  "completed|neutral": "⚪",
  "completed|stale": "🪦",
};
const UNKNOWN_EMOJI = "❓";
// A watched job we don't yet see in the API. Almost always because it has
// `needs:` on a job that hasn't finished yet, so GitHub hasn't materialized
// the row. Semantically "waiting".
const MISSING_EMOJI = "⏳";

// Human-readable status word for a completed job's conclusion. Every conclusion
// gets a word — we decode the emoji into text for all of them, so a passing job
// reads `success` just as a skipped one reads `skipped`; the emoji shouldn't be
// the only thing distinguishing pass from fail. (Previously everything that
// lacked a duration fell back to `done`, which mislabelled skipped/cancelled.)
const CONCLUSION_TEXT: Record<string, string> = {
  success: "success",
  failure: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
  timed_out: "timed out",
  action_required: "action required",
  neutral: "neutral",
  stale: "stale",
};

// The conclusion word plus the duration when there is one — e.g.
// `success  ·  4m 48s`, or just `skipped` for a job with no runtime. Unknown
// conclusions fall back to the raw value so we never silently swallow a new
// GitHub state; a null conclusion (shouldn't happen for completed) reads `done`.
function completedStatus(conclusion: string | null, duration: string | null): string {
  const word =
    conclusion === null ? "done" : CONCLUSION_TEXT[conclusion] ?? conclusion;
  return duration ? `${word}  ·  ${duration}` : word;
}

const TERMINAL_CONCLUSIONS = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "neutral",
  "stale",
]);

// Attachment color bar. Slack wants a hex string, not Discord's integer.
const COLOR_RUNNING = "#c69026";
const COLOR_SUCCESS = "#57ab5a";
const COLOR_FAILURE = "#e5534b";
const COLOR_CANCELLED = "#9198a1";
const COLOR_ERROR = "#8957e5";


export type Block = Record<string, unknown>;

export interface Card {
  blocks: Block[];
  color: string;
  /** Plain-text notification fallback (not rendered in-channel). */
  fallback: string;
}

export interface WatchedJob {
  id: string;
  label: string;
  rows: Job[];
  multi: boolean;
}

export function pickEmoji(
  status: string | null | undefined,
  conclusion: string | null | undefined,
): string {
  if (!status) return MISSING_EMOJI;
  if (status === "completed") {
    return STATE_EMOJI[`completed|${conclusion ?? ""}`] ?? UNKNOWN_EMOJI;
  }
  return STATE_EMOJI[`${status}|`] ?? UNKNOWN_EMOJI;
}

export function isTerminal(job: Job): boolean {
  if (job.status !== "completed") return false;
  return job.conclusion !== null && TERMINAL_CONCLUSIONS.has(job.conclusion);
}

export function allRowsTerminal(w: WatchedJob): boolean {
  if (w.rows.length === 0) return false;
  return w.rows.every(isTerminal);
}

const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out"]);

export function failedWatched(watched: WatchedJob[]): WatchedJob[] {
  return watched.filter((w) =>
    w.rows.some(
      (r) =>
        r.status === "completed" &&
        r.conclusion !== null &&
        FAILURE_CONCLUSIONS.has(r.conclusion),
    ),
  );
}

function aggregateState(rows: Job[]): {
  status: string | null;
  conclusion: string | null;
} {
  if (rows.length === 0) return { status: null, conclusion: null };
  if (rows.some((r) => r.status === "completed" && r.conclusion === "failure")) {
    return { status: "completed", conclusion: "failure" };
  }
  if (rows.every((r) => r.status === "completed")) {
    if (rows.some((r) => r.conclusion === "cancelled")) {
      return { status: "completed", conclusion: "cancelled" };
    }
    return { status: "completed", conclusion: "success" };
  }
  return { status: "in_progress", conclusion: null };
}

function unixSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

function durationBetween(
  startIso: string | null,
  endIso: string | null,
): string | null {
  const s = unixSeconds(startIso);
  const e = unixSeconds(endIso);
  if (s === null || e === null || e < s) return null;
  return formatDuration(e - s);
}

// Live elapsed time from a start timestamp to now. Returns null if there's no
// parseable start. Advances each poll, so a running job's timer ticks.
function elapsedSince(startIso: string | null): string | null {
  const s = unixSeconds(startIso);
  if (s === null) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now < s) return null;
  return formatDuration(now - s);
}

/** Earliest non-null start timestamp across rows, as unix seconds. */
function earliestStart(rows: Job[]): number | null {
  let earliest: number | null = null;
  for (const r of rows) {
    const t = unixSeconds(r.started_at);
    if (t !== null && (earliest === null || t < earliest)) earliest = t;
  }
  return earliest;
}

/** Latest non-null completion timestamp across rows, as unix seconds. */
function latestCompletion(rows: Job[]): number | null {
  let latest: number | null = null;
  for (const r of rows) {
    const t = unixSeconds(r.completed_at);
    if (t !== null && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

// Wall-clock runtime across a set of job rows:
//   start = earliest row start (immune to our own scheduling delay)
//   end   = latest row completion once every row is terminal (frozen),
//           otherwise `now` — which advances each poll, so the value ticks live
//           while rows are still running, then freezes at the final value.
// Used both for the whole card (the title) and for a single collapsed matrix
// (so a matrix reads exactly like any other job: ticks, then freezes).
function rowsRuntime(rows: Job[]): string | null {
  const start = earliestStart(rows);
  if (start === null) return null;
  const allTerminal = rows.length > 0 && rows.every(isTerminal);
  const end = allTerminal
    ? latestCompletion(rows)
    : Math.floor(Date.now() / 1000);
  if (end === null || end < start) return null;
  return formatDuration(end - start);
}

// Wall-clock runtime of all *watched* jobs, for the card title. We can't use
// GitHub's run duration: our notify job is itself part of the run, so the run
// is never "finished" while we're polling. We measure across watched rows.
function workflowRuntime(watched: WatchedJob[]): string | null {
  return rowsRuntime(watched.flatMap((w) => w.rows));
}

// Slack mrkdwn link: <url|text>. Escapes the text so a stray `>`/`<`/`&` or
// a `|` in the label can't break out of the link syntax.
function link(url: string, text: string): string {
  return `<${url}|${escapeText(text)}>`;
}

// Slack mrkdwn requires &, <, > to be HTML-escaped in any text we emit. We
// also drop `|` from link text since it terminates the link's text segment.
function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Widest a col2 monospace step name can be before it wraps to a second line in
// the detailed layout's right `fields` cell. The counter sits *outside* the
// monospace pill as proportional text, so the budget is what's left behind the
// widest realistic counter (`(99/99) `, since jobs effectively never exceed 99
// steps). Found empirically (monospace → stable char count): 29 fits, 30 wraps.
// The ellipsis counts toward it, so a truncated name is 28 chars + "…".
const STEP_CHAR_BUDGET = 29;

// Truncate to `max` characters, with a single-char "…" as the last char when
// cut (so the result is never longer than `max`).
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

// Render a col2 cell: the proportional counter prefix (if any) followed by the
// monospace step name. The name is truncated to the no-wrap budget, has its
// backticks stripped (they'd terminate the code span), and is mrkdwn-escaped.
// Monospace makes the name's budget a real, stable width; keeping the counter
// out of the pill avoids the digits looking cramped in code styling.
function stepCell(s: { counter: string | null; name: string }): string {
  const name = truncate(s.name, STEP_CHAR_BUDGET).replace(/`/g, "");
  const mono = `\`${escapeText(name)}\``;
  return s.counter ? `${s.counter} ${mono}` : mono;
}

// The step worth surfacing for a single-row job, with a position counter:
//   - failed job   → the step that failed (what broke)
//   - running job  → the step currently executing (what's happening now)
// Returns null when there's no steps array, no matching step, or the job is in
// any other state (done/queued — a step line would just be noise there).
// The counter `(x/y)` uses GitHub's own `step.number` (x = the surfaced step's
// number, y = the highest step number on the job). GitHub's auto-injected
// teardown steps get high numbers, so the counter stays monotonic — a running
// teardown reads `(13/15)`, never "past the end" the way an array-position
// counter would after it already showed the last real step. The name is the
// step name verbatim, including GitHub's auto `Run <cmd>` label.
//
// While a job is still spinning up, GitHub reports just one step ("Set up job",
// which is where it expands the matrix and resolves the real step list). A
// `(1/1)` counter is misleading — it'll jump to `(2/37)` the moment the rest
// materialize — so counter is null when there's only one step.
function currentStep(job: Job): { counter: string | null; name: string } | null {
  const steps = job.steps;
  if (!steps || steps.length === 0) return null;

  let step: Step | undefined;
  if (job.status === "completed" && job.conclusion === "failure") {
    step = steps.find((s) => s.conclusion === "failure");
  } else if (job.status === "in_progress") {
    step = steps.find((s) => s.status === "in_progress");
  }
  if (!step) return null;

  const total = Math.max(...steps.map((s) => s.number));
  const counter = total <= 1 ? null : `(${step.number}/${total})`;
  return { counter, name: step.name };
}

// Detailed layout, col1: `<emoji> <bold job name → logs link> · <status/timer>`.
// The job name itself is the logs link, so there's no separate `logs ↗︎` —
// that frees the right column entirely for the step name.
function detailedCol1(w: WatchedJob, runUrl: string): { emoji: string; text: string } {
  if (w.rows.length === 0) {
    return { emoji: MISSING_EMOJI, text: `*${escapeText(w.label)}*  ·  waiting` };
  }

  if (w.rows.length === 1 && !w.multi) {
    const r = w.rows[0]!;
    const url = r.html_url ?? runUrl;
    let status: string;
    if (r.status === "completed") {
      status = completedStatus(
        r.conclusion,
        durationBetween(r.started_at, r.completed_at),
      );
    } else if (r.status === "in_progress") {
      // Live per-job timer: now − started_at, ticking each poll. Falls back to
      // "running" if we somehow have no start time.
      status = elapsedSince(r.started_at) ?? "running";
    } else {
      status = humanStatus(r.status);
    }
    return {
      emoji: pickEmoji(r.status, r.conclusion),
      text: `${link(url, w.label)}  ·  ${status}`,
    };
  }

  // Matrix/reusable: collapse the rows into one summary line. GitHub calls each
  // matrix combination a "job" ("the workflow will run six jobs, one for each
  // combination"), so we count "N jobs". The name links to the run.
  const agg = aggregateState(w.rows);
  const done = w.rows.filter((r) => r.status === "completed").length;
  const failed = w.rows.filter(
    (r) => r.status === "completed" && r.conclusion === "failure",
  ).length;
  const total = w.rows.length;
  const noun = total === 1 ? "job" : "jobs";
  let count: string;
  if (failed > 0) count = `${done}/${total} ${noun} done, ${failed} failed`;
  else if (done < total) count = `${done}/${total} ${noun} done`;
  else count = `${total} ${noun}`;
  // Wall-clock runtime, just like a single job: ticks while combos run, freezes
  // at earliest-start→latest-finish once all are done — i.e. how long the whole
  // matrix blocked downstream jobs.
  const runtime = rowsRuntime(w.rows);
  const summary = runtime ? `${count}  ·  ${runtime}` : count;
  return {
    emoji: pickEmoji(agg.status, agg.conclusion),
    text: `${link(runUrl, w.label)}  ·  ${summary}`,
  };
}

function humanStatus(status: string | null): string {
  if (!status) return "pending";
  if (status === "queued") return "queued";
  if (status === "waiting") return "waiting";
  if (status === "pending") return "pending";
  return status;
}

function overallColor(watched: WatchedJob[]): string {
  const aggs = watched.map((w) => aggregateState(w.rows));
  if (aggs.some((a) => a.status === "completed" && a.conclusion === "failure")) {
    return COLOR_FAILURE;
  }
  if (watched.every((w) => allRowsTerminal(w))) {
    if (aggs.some((a) => a.conclusion === "cancelled")) return COLOR_CANCELLED;
    return COLOR_SUCCESS;
  }
  return COLOR_RUNNING;
}

// Two layouts, both built from the same col1 (`emoji *Job → logs* · timer`):
//   "detailed" (default) — 2 fields per job, col2 holds the current/failed step
//   "compact"            — 1 field per job, so jobs flow into a dense 2-column grid
export type Layout = "detailed" | "compact";

// A section's `fields` array caps at 10 entries. "detailed" spends 2 fields per
// job (col1 | step), so 5 jobs fill a section; "compact" spends 1, so 10 do.
// Past those counts we chunk into further sections (each adds a visible gap).
const MAX_DETAILED_JOBS = 5;
const MAX_FIELDS = 10;

// Slack fills a section's `fields` row-major (left cell, right cell, next row).
// We want each column read top-to-bottom instead, so we reorder: the first
// half of the items become the left column, the rest the right column, then we
// interleave them back into the row-major order Slack expects. For an odd
// count the extra item lands in the left column and the last row has no right
// cell.
//   in:  [A, B, C, D, E, F]  →  left [A,B,C] right [D,E,F]  →  out [A,D,B,E,C,F]
function columnMajor<T>(items: T[]): T[] {
  const rows = Math.ceil(items.length / 2);
  const left = items.slice(0, rows);
  const right = items.slice(rows);
  const out: T[] = [];
  for (let i = 0; i < rows; i += 1) {
    out.push(left[i]!);
    if (i < right.length) out.push(right[i]!);
  }
  return out;
}

function jobListBlocks(
  watched: WatchedJob[],
  runUrl: string,
  layout: Layout,
): Block[] {
  if (layout === "compact") {
    // 1 field per job — `emoji *Job → logs* · timer` in a single cell. Slack
    // lays fields out in two columns, so jobs flow into a dense 2-column grid
    // with no step line. One section fits 10 jobs; past that we chunk further.
    const fields = watched.map((w) => {
      const { emoji, text } = detailedCol1(w, runUrl);
      return { type: "mrkdwn", text: `${emoji} ${text}` };
    });
    const blocks: Block[] = [];
    for (let i = 0; i < fields.length; i += MAX_FIELDS) {
      const section = fields.slice(i, i + MAX_FIELDS);
      blocks.push({ type: "section", fields: columnMajor(section) });
    }
    return blocks;
  }

  // "detailed" (default): 2 fields per job — col1 `emoji *Job → logs* · timer`,
  // col2 the current/failed step. 5 jobs per section; beyond that we chunk into
  // further sections to stay under Slack's 10-field cap.
  const fieldPairs = watched.map((w) => {
    const { emoji, text } = detailedCol1(w, runUrl);
    const step = w.rows.length === 1 && !w.multi ? currentStep(w.rows[0]!) : null;
    return [
      { type: "mrkdwn", text: `${emoji} ${text}` },
      { type: "mrkdwn", text: step ? stepCell(step) : " " },
    ];
  });
  const blocks: Block[] = [];
  for (let i = 0; i < fieldPairs.length; i += MAX_DETAILED_JOBS) {
    blocks.push({
      type: "section",
      fields: fieldPairs.slice(i, i + MAX_DETAILED_JOBS).flat(),
    });
  }
  return blocks;
}

export function renderCard(
  watched: WatchedJob[],
  run: Run,
  repo: string,
  monitoringError?: boolean,
  layout: Layout = "detailed",
  buildNumber?: string,
): Card {
  const branch = run.head_branch ?? "?";
  const repoShort = repo.split("/").pop() ?? repo;
  const subject = run.head_commit?.message?.split("\n")[0] ?? "";
  const author =
    run.head_commit?.author?.name ?? run.triggering_actor?.login ?? null;

  const attemptSuffix =
    run.run_attempt > 1 ? ` (attempt ${run.run_attempt})` : "";
  // A caller-supplied `build_number` overrides GitHub's run number (labelled
  // `build #` rather than `run #`); otherwise we fall back to the run number.
  const numberPart = buildNumber
    ? `build #${buildNumber}`
    : `run #${run.run_number}`;
  // Title carries everything you scan for: which repo, which workflow, which
  // build, and how long it took. Repo + workflow disambiguate cards from
  // different repos/workflows sharing one channel. Runtime ticks while running
  // (see workflowRuntime) and freezes at the final value once watched jobs end.
  const workflow = run.name?.trim() || "CI";
  const runtime = workflowRuntime(watched) ?? "running";
  const headline =
    `${repoShort} · ${workflow} · ${numberPart}${attemptSuffix} · ${runtime}`;
  // Used for the notification fallback and nowhere visible.
  const fallback = `[${repoShort}:${branch}] ${workflow} ${numberPart}`;

  const blocks: Block[] = [];

  // Title as a real `header` block so it reads as a card title (large + bold).
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: headline, emoji: true },
  });

  if (monitoringError) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "⚠️ *Monitoring stopped* — the GitHub API kept failing, so this " +
          "card may be out of date. Check the run directly.",
      },
    });
  }

  for (const b of jobListBlocks(watched, run.html_url, layout)) blocks.push(b);

  // Footer: who pushed + commit subject (to pair this card with GitHub's push
  // notification when several land in the channel at once), plus the run link.
  // No GitHub logo — it's dim and near-invisible in dark mode, doing no work.
  const footerBits = [author, subject]
    .filter((b): b is string => !!b && b.length > 0)
    .map(escapeText);
  footerBits.push(link(run.html_url, "View run ↗︎"));
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: footerBits.join("  ·  ") }],
  });

  return {
    blocks,
    color: monitoringError ? COLOR_ERROR : overallColor(watched),
    fallback,
  };
}
