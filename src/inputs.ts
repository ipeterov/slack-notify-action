import * as yaml from "js-yaml";

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
