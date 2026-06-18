import type { Job } from "./github.js";
import type { JobMeta } from "./workflow.js";

export function matchJobs(meta: JobMeta, jobs: Job[]): Job[] {
  const base = meta.label;
  const matched: Job[] = [];
  for (const j of jobs) {
    if (
      j.name === base ||
      j.name.startsWith(`${base} (`) ||
      j.name.startsWith(`${base} / `)
    ) {
      matched.push(j);
    }
  }
  return matched;
}
