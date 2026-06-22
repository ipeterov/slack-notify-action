import * as yaml from "js-yaml";

import type { Layout } from "./render.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 1_000;

export function parseLayout(raw: string): Layout {
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "detailed") return "detailed";
  if (v === "compact") return "compact";
  throw new Error(
    `Invalid \`layout\`: '${raw}'. Expected 'detailed' or 'compact'.`,
  );
}

// Poll interval in seconds (e.g. `10`). Empty → the 5s default. Must be a
// finite number ≥ 1s — polling faster than that risks GitHub rate limits and
// buys little, since job state rarely changes sub-second.
export function parsePollInterval(raw: string): number {
  const v = raw.trim();
  if (v === "") return DEFAULT_POLL_INTERVAL_MS;
  const seconds = Number(v);
  if (!Number.isFinite(seconds)) {
    throw new Error(
      `Invalid \`poll_interval\`: '${raw}'. Expected a number of seconds.`,
    );
  }
  const ms = Math.round(seconds * 1_000);
  if (ms < MIN_POLL_INTERVAL_MS) {
    throw new Error(`\`poll_interval\` must be at least 1 second, got '${raw}'.`);
  }
  return ms;
}

export function parseJobsInput(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("`jobs` input is empty");
  }
  const parsed = yaml.load(trimmed);
  const list = normalize(parsed);
  if (list.length === 0) {
    throw new Error("`jobs` input parsed to an empty list");
  }
  return list;
}

function normalize(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item !== "string") {
        throw new Error(
          `\`jobs\` entry at index ${index} must be a string, got ${typeof item}`,
        );
      }
      return item;
    });
  }
  throw new Error(
    `\`jobs\` must be a string or list of strings, got ${typeof value}`,
  );
}
