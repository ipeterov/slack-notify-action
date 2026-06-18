import * as core from "@actions/core";
import { setTimeout as sleep } from "node:timers/promises";

import { GitHubClient } from "./github.js";
import type { Job } from "./github.js";
import { parseJobsInput } from "./inputs.js";
import { matchJobs } from "./match.js";
import { allRowsTerminal, failedWatched, renderCard } from "./render.js";
import type { WatchedJob } from "./render.js";
import { SlackClient } from "./slack.js";
import { parseWorkflow } from "./workflow.js";
import type { JobMeta } from "./workflow.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_DURATION_MS = 6 * 60 * 60 * 1_000;

async function main(): Promise<void> {
  const channel = core.getInput("channel_id", { required: true });
  const jobsInput = core.getInput("jobs", { required: true });
  const watchedIds = parseJobsInput(jobsInput);
  const token =
    core.getInput("github-token") || process.env.GITHUB_TOKEN || "";

  // Read the bot token from the environment exactly as ivelum does, so swapping
  // actions needs no Slack-admin or secret changes.
  const slackToken = process.env.SLACK_BOT_TOKEN || "";
  if (!slackToken) {
    throw new Error(
      "Missing SLACK_BOT_TOKEN. Pass the bot token via `env:` on this job, " +
        "as the ivelum action does.",
    );
  }

  const repo = requireEnv("GITHUB_REPOSITORY");
  const runId = requireEnv("GITHUB_RUN_ID");

  core.setSecret(slackToken);

  const gh = new GitHubClient(token);
  const slack = new SlackClient(slackToken, channel);

  try {
    const runPromise = gh.fetchRun(repo, runId);
    const jobsPromise = gh.fetchJobs(repo, runId);
    const workflowPromise = runPromise.then((run) =>
      gh.fetchWorkflowFile(repo, run.path, run.head_sha),
    );

    const [run, jobs, workflowYaml] = await Promise.all([
      runPromise,
      jobsPromise,
      workflowPromise,
    ]);

    const meta = parseWorkflow(workflowYaml);
    validateIds(watchedIds, meta);
    warnDynamicNames(watchedIds, meta);

    const watched = buildWatched(watchedIds, meta, jobs);
    const card = renderCard(watched, run, repo);
    const ts = await slack.post(card);

    let lastPayload = JSON.stringify(card);
    let lastRun = run;
    const deadline = Date.now() + MAX_POLL_DURATION_MS;

    while (Date.now() < deadline) {
      if (watched.every(allRowsTerminal)) {
        reportWatchedFailures(watched);
        return;
      }
      await sleep(POLL_INTERVAL_MS);

      let nextRun: typeof run;
      let nextJobs: Job[];
      try {
        [nextRun, nextJobs] = await Promise.all([
          gh.fetchRun(repo, runId),
          gh.fetchJobs(repo, runId),
        ]);
      } catch (err) {
        // Retries inside GitHubClient are already exhausted. Rather than letting
        // the card freeze at its last state, mark it as broken and stop.
        const msg = err instanceof Error ? err.message : String(err);
        core.error(`Notify Slack: GitHub polling failed: ${msg}`);
        const errCard = renderCard(watched, lastRun, repo, true);
        try {
          await slack.update(ts, errCard);
        } catch {
          // The Slack update is best-effort; the job failure below is what matters.
        }
        core.setFailed(`Notify Slack: GitHub polling failed: ${msg}`);
        return;
      }

      const nextWatched = buildWatched(watchedIds, meta, nextJobs);
      const nextCard = renderCard(nextWatched, nextRun, repo);
      const nextPayload = JSON.stringify(nextCard);
      if (nextPayload !== lastPayload) {
        await slack.update(ts, nextCard);
        lastPayload = nextPayload;
      }
      watched.splice(0, watched.length, ...nextWatched);
      lastRun = nextRun;
    }

    core.setFailed("Notify Slack: poll deadline exceeded");
  } finally {
    await Promise.all([gh.close(), slack.close()]);
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function validateIds(ids: string[], meta: Map<string, JobMeta>): void {
  const missing = ids.filter((id) => !meta.has(id));
  if (missing.length > 0) {
    const known = [...meta.keys()].join(", ");
    throw new Error(
      `Unknown job id(s): ${missing.join(", ")}. Known ids in this workflow: ${known}`,
    );
  }
}

function warnDynamicNames(ids: string[], meta: Map<string, JobMeta>): void {
  for (const id of ids) {
    const m = meta.get(id);
    if (m?.dynamicName) {
      core.warning(
        `Job '${id}' uses expression syntax in its name (\`${m.label} …\`). ` +
          `Matching will use the static prefix '${m.label}'; verify the card looks right.`,
      );
    }
  }
}

function reportWatchedFailures(watched: WatchedJob[]): void {
  const failed = failedWatched(watched);
  if (failed.length === 0) return;
  const ids = failed.map((w) => w.id).join(", ");
  core.setFailed(`Watched job(s) failed: ${ids}`);
}

function buildWatched(
  ids: string[],
  meta: Map<string, JobMeta>,
  jobs: Job[],
): WatchedJob[] {
  return ids.map((id) => {
    const m = meta.get(id)!;
    const rows = matchJobs(m, jobs);
    return { id, label: m.label, rows, multi: m.multi };
  });
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
