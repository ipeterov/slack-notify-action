import { Pool } from "undici";
import type { Card } from "./render.js";

const SLACK_HOST = "https://slack.com";

export class SlackClient {
  private pool: Pool;
  private headers: Record<string, string>;
  private channel: string;

  constructor(token: string, channel: string) {
    this.pool = new Pool(SLACK_HOST, {
      connections: 2,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
    this.channel = channel;
    this.headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "ipeterov/slack-notify-action",
    };
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  /** Post the card and return the message `ts` (Slack's message id). */
  async post(card: Card): Promise<string> {
    const body = await this.call("/api/chat.postMessage", {
      channel: this.channel,
      ...this.payload(card),
    });
    const ts = (body as { ts?: string }).ts;
    if (!ts) {
      throw new Error("Slack chat.postMessage returned no `ts`");
    }
    return ts;
  }

  /** Update a previously posted message in place. */
  async update(ts: string, card: Card): Promise<void> {
    await this.call("/api/chat.update", {
      channel: this.channel,
      ts,
      ...this.payload(card),
    });
  }

  // Slack carries the per-job blocks inside a single attachment so the optional
  // `color` renders as a vertical status bar beside the card. Defensive
  // no-ping posture: never enable `link_names`, and the renderer never emits
  // `<!channel>`/`<!here>`, so commit/job text can't ping the channel.
  private payload(card: Card): Record<string, unknown> {
    return {
      attachments: [
        {
          color: card.color,
          // `fallback` is notification/accessibility text only — unlike the
          // message-level `text`, it is never rendered above the card.
          fallback: card.fallback,
          blocks: card.blocks,
        },
      ],
    };
  }

  // Slack returns HTTP 200 even on logical failure — the real status lives in
  // the JSON body's `ok` flag. Parse it and throw on `ok: false`, surfacing
  // `error`. Relying on the status code alone is the classic porting bug.
  private async call(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await this.pool.request({
      method: "POST",
      path,
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`Slack ${path} → HTTP ${res.statusCode}: ${text}`);
    }
    let body: { ok?: boolean; error?: string };
    try {
      body = JSON.parse(text) as { ok?: boolean; error?: string };
    } catch {
      throw new Error(`Slack ${path} → non-JSON response: ${text}`);
    }
    if (!body.ok) {
      throw new Error(`Slack ${path} failed: ${body.error ?? "unknown error"}`);
    }
    return body;
  }
}
