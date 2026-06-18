import * as yaml from "js-yaml";

export interface JobMeta {
  /** Resolved label to display in Discord. */
  label: string;
  /** True if the job has a matrix strategy or could otherwise fan out. */
  multi: boolean;
  /** True if `name:` contains expression syntax we can't resolve statically. */
  dynamicName: boolean;
}

export function parseWorkflow(workflowYaml: string): Map<string, JobMeta> {
  const doc = yaml.load(workflowYaml);
  const map = new Map<string, JobMeta>();
  if (!doc || typeof doc !== "object") return map;
  const jobs = (doc as { jobs?: unknown }).jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return map;
  for (const [id, def] of Object.entries(jobs as Record<string, unknown>)) {
    let label = id;
    let dynamicName = false;
    let multi = false;
    if (def && typeof def === "object") {
      const d = def as {
        name?: unknown;
        strategy?: { matrix?: unknown };
        uses?: unknown;
      };
      if (typeof d.name === "string" && d.name.length > 0) {
        if (d.name.includes("${{")) {
          dynamicName = true;
          // Use static prefix before the first expression as a best-effort label.
          // Strip trailing whitespace and any trailing opening punctuation like
          // `(` or `[` so `"Android (${{ matrix.arch }})"` becomes `"Android"`.
          const head = d.name.split("${{")[0] ?? "";
          const prefix = head.replace(/[\s(\[]+$/, "");
          label = prefix.length > 0 ? prefix : id;
        } else {
          label = d.name;
        }
      }
      if (d.strategy && typeof d.strategy === "object") {
        if ("matrix" in d.strategy) multi = true;
      }
      if (typeof d.uses === "string") {
        // Reusable workflows fan out names into "<label> / <child>".
        multi = true;
      }
    }
    map.set(id, { label, multi, dynamicName });
  }
  return map;
}
