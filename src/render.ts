import type { Job, Run } from "./github.js";

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

// Wall-clock runtime of the *watched* jobs. We can't use GitHub's run duration:
// our notify job is itself part of the run, so the run is never "finished"
// while we're polling. We measure across the jobs we watch instead.
//   start = earliest watched start (immune to our own scheduling delay)
//   end   = latest watched completion once all watched jobs are terminal
//           (frozen), otherwise `now` — which advances on each poll/update so
//           the value ticks live while the pipeline runs.
function workflowRuntime(watched: WatchedJob[]): string | null {
  const rows = watched.flatMap((w) => w.rows);
  const start = earliestStart(rows);
  if (start === null) return null;
  const allTerminal =
    watched.length > 0 && watched.every((w) => allRowsTerminal(w));
  const end = allTerminal
    ? latestCompletion(rows)
    : Math.floor(Date.now() / 1000);
  if (end === null || end < start) return null;
  return formatDuration(end - start);
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

// A rendered job: the emoji + bold label headline, and the dim detail line
// shown beneath it. Mirrors the Discord card's two-line-per-job layout.
function jobParts(
  w: WatchedJob,
  runUrl: string,
): { emoji: string; detail: string } {
  if (w.rows.length === 0) {
    return { emoji: MISSING_EMOJI, detail: "waiting" };
  }

  if (w.rows.length === 1 && !w.multi) {
    const r = w.rows[0]!;
    const url = r.html_url ?? runUrl;
    return { emoji: pickEmoji(r.status, r.conclusion), detail: rowDetail(r, url) };
  }

  // Collapsed multi-row (matrix or reusable workflow).
  const agg = aggregateState(w.rows);
  const done = w.rows.filter((r) => r.status === "completed").length;
  const failed = w.rows.filter(
    (r) => r.status === "completed" && r.conclusion === "failure",
  ).length;
  const total = w.rows.length;
  let summary: string;
  if (failed > 0) {
    summary = `${done}/${total} done, ${failed} failed`;
  } else if (done < total) {
    summary = `${done}/${total} done`;
  } else {
    summary = `${total} combos`;
  }
  return {
    emoji: pickEmoji(agg.status, agg.conclusion),
    detail: matrixDetail(w.rows, summary, runUrl),
  };
}

function rowDetail(job: Job, url: string): string {
  const bits: string[] = [];
  if (job.status === "completed") {
    const d = durationBetween(job.started_at, job.completed_at);
    if (d) bits.push(d);
  } else if (job.status === "in_progress") {
    bits.push("running");
  } else {
    bits.push(humanStatus(job.status));
  }
  bits.push(link(url, "logs ↗︎"));
  return bits.join("  ·  ");
}

function matrixDetail(rows: Job[], summary: string, runUrl: string): string {
  const bits: string[] = [summary];
  const allDone = rows.every((r) => r.status === "completed");
  if (allDone) {
    const earliest = earliestStart(rows);
    const latest = latestCompletion(rows);
    if (earliest !== null && latest !== null && latest >= earliest) {
      bits.push(formatDuration(latest - earliest));
    }
  }
  bits.push(link(runUrl, "logs ↗︎"));
  return bits.join("  ·  ");
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

// Job-list layout variants under evaluation. "context" is the shipping default;
// the others are candidates we're comparing visually in scripts/layouts.ts.
// "auto" (the default) picks by job count; the rest are explicit variants kept
// for the comparison scripts.
export type Layout =
  | "auto"
  | "fields"
  | "columns"
  | "context"
  | "richlist"
  | "table";

// A section's `fields` array caps at 10 entries. With ≤5 jobs we spend 2 fields
// per job (label | detail) for the clearest two-column read; above that we
// switch to 1 field per job so up to 10 jobs still fit one gap-free section.
const MAX_TWO_FIELD_JOBS = 5;
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
  // Count-driven default: clearest layout that fits.
  if (layout === "auto") {
    layout = watched.length <= MAX_TWO_FIELD_JOBS ? "fields" : "columns";
  }

  if (layout === "fields") {
    // 2 fields per job (`emoji *Label*` | detail) — clearest two-column grid.
    // One section holds 5 jobs (10 fields); beyond that we chunk into more
    // sections (which adds a visible gap, so `auto` only uses this for ≤5).
    const fieldPairs = watched.map((w) => {
      const { emoji, detail } = jobParts(w, runUrl);
      return [
        { type: "mrkdwn", text: `${emoji} *${escapeText(w.label)}*` },
        { type: "mrkdwn", text: detail },
      ];
    });
    const blocks: Block[] = [];
    for (let i = 0; i < fieldPairs.length; i += MAX_TWO_FIELD_JOBS) {
      blocks.push({
        type: "section",
        fields: fieldPairs.slice(i, i + MAX_TWO_FIELD_JOBS).flat(),
      });
    }
    return blocks;
  }

  if (layout === "columns") {
    // 1 field per job: `emoji *Label* · detail` in a single cell. Slack lays
    // fields out in two columns, so jobs flow into a compact 2-column grid with
    // no inter-section gap. One section fits 10 jobs; past that we chunk into
    // further 10-job sections (gap reappears, but it's the best option at that
    // size).
    const fields = watched.map((w) => {
      const { emoji, detail } = jobParts(w, runUrl);
      return {
        type: "mrkdwn",
        text: `${emoji} *${escapeText(w.label)}*  ·  ${detail}`,
      };
    });
    const blocks: Block[] = [];
    for (let i = 0; i < fields.length; i += MAX_FIELDS) {
      const section = fields.slice(i, i + MAX_FIELDS);
      blocks.push({ type: "section", fields: columnMajor(section) });
    }
    return blocks;
  }

  if (layout === "richlist") {
    // rich_text_list: a true bulleted list, one job per bullet, emoji inline.
    const elements = watched.map((w) => {
      const { emoji, detail } = jobParts(w, runUrl);
      return {
        type: "rich_text_section",
        elements: [
          { type: "text", text: `${emoji} `, style: {} },
          { type: "text", text: w.label, style: { bold: true } },
          { type: "text", text: `  —  ${stripMrkdwn(detail)}` },
        ],
      };
    });
    return [
      {
        type: "rich_text",
        elements: [{ type: "rich_text_list", style: "bullet", elements }],
      },
    ];
  }

  if (layout === "table") {
    // table block: real columns. Header row + one row per job.
    const header = ["", "Job", "Status", "Logs"].map((t) => ({
      type: "raw_text",
      text: t,
    }));
    const rows: unknown[][] = [header];
    for (const w of watched) {
      const { emoji, detail } = jobParts(w, runUrl);
      rows.push([
        { type: "raw_text", text: emoji },
        { type: "raw_text", text: w.label },
        { type: "raw_text", text: stripMrkdwn(detail.split("  ·  ")[0] ?? "") },
        { type: "raw_text", text: "logs" },
      ]);
    }
    return [{ type: "table", rows }];
  }

  // Default "context": single compact line, emoji inline-small, no collapse.
  const jobText = watched
    .map((w) => {
      const { emoji, detail } = jobParts(w, runUrl);
      return `${emoji} *${escapeText(w.label)}* ${detail}`;
    })
    .join("      ");
  return [{ type: "context", elements: [{ type: "mrkdwn", text: jobText }] }];
}

// Strip mrkdwn link syntax `<url|text>` → `text` for contexts (rich_text/table
// cells) that take plain strings rather than mrkdwn.
function stripMrkdwn(s: string): string {
  return s.replace(/<([^|>]+)\|([^>]+)>/g, "$2");
}

export function renderCard(
  watched: WatchedJob[],
  run: Run,
  repo: string,
  monitoringError?: boolean,
  layout: Layout = "auto",
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
