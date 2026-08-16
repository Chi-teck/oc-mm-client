import { readFileSync } from "node:fs";

export interface MattermostEnv {
  url: string;
  token: string;
  team: string;
}

export function readMattermostEnv(env = process.env): MattermostEnv {
  const url = env.MM_URL;
  const token = env.MM_TOKEN;
  const team = env.MM_TEAM;
  if (!url || !token || !team) {
    throw new Error("Set MM_URL, MM_TOKEN and MM_TEAM");
  }
  return { url, token, team };
}

/**
 * Loads `MM_*` keys from a dotenv-style file into `process.env`. A missing or unreadable file is
 * not an error, and variables already set in the real environment are left untouched.
 */
export function loadEnvFile(path = ".env.local"): void {
  let file: string;
  try {
    file = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of file.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key.startsWith("MM_")) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
