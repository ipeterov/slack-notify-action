import { Pool } from "undici";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff with full jitter: ~1s, 2s, 4s, ... capped at 30s.
// Spans ~2min total over maxAttempts so a brief API outage doesn't kill a poll.
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

export interface Run {
  id: number;
  run_number: number;
  run_attempt: number;
  html_url: string;
  head_branch: string | null;
  head_sha: string;
  path: string;
  status: string | null;
  conclusion: string | null;
  triggering_actor: { login: string } | null;
  head_commit: {
    message: string | null;
    author: { name: string | null } | null;
  } | null;
}

export interface Job {
  id: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  labels: string[];
}

export class GitHubClient {
  private pool: Pool;
  private headers: Record<string, string>;

  constructor(token: string) {
    this.pool = new Pool("https://api.github.com", {
      connections: 4,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
    this.headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ipeterov/slack-notify-action",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  private async get<T>(path: string): Promise<T> {
    const maxAttempts = 8;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await this.pool.request({
          method: "GET",
          path,
          headers: this.headers,
        });
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const body = await res.body.text();
          const err = new Error(`GitHub ${path} → ${res.statusCode}: ${body}`);
          // Retry on rate limiting (429) and transient server errors (5xx).
          if (res.statusCode === 429 || res.statusCode >= 500) {
            lastErr = err;
            if (attempt < maxAttempts) {
              await sleep(backoffMs(attempt));
              continue;
            }
          }
          throw err;
        }
        return (await res.body.json()) as T;
      } catch (err) {
        // Network-level errors (resets, timeouts, DNS) are also transient.
        if (err instanceof Error && err.message.startsWith("GitHub ")) throw err;
        lastErr = err;
        if (attempt < maxAttempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  fetchRun(repo: string, runId: string): Promise<Run> {
    return this.get<Run>(`/repos/${repo}/actions/runs/${runId}`);
  }

  async fetchJobs(repo: string, runId: string): Promise<Job[]> {
    const jobs: Job[] = [];
    let page = 1;
    while (true) {
      const data = await this.get<{ jobs: Job[]; total_count: number }>(
        `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      );
      jobs.push(...data.jobs);
      if (jobs.length >= data.total_count) break;
      page += 1;
    }
    return jobs;
  }

  async fetchWorkflowFile(
    repo: string,
    path: string,
    ref: string,
  ): Promise<string> {
    let data: { content: string; encoding: string };
    try {
      data = await this.get<{ content: string; encoding: string }>(
        `/repos/${repo}/contents/${path}?ref=${ref}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("403")) {
        throw new Error(
          `Cannot read ${path}: the job lacks \`contents: read\` permission. ` +
            "Add `contents: read` to the notify-discord job's `permissions:` block.",
        );
      }
      throw err;
    }
    if (data.encoding !== "base64") {
      throw new Error(`Unexpected content encoding: ${data.encoding}`);
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  }
}
