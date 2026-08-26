import { readFileSync } from "node:fs";

export interface MattermostEnv {
  url: string;
  token: string;
  team: string;
}

export function readMattermostEnv(env = process.env): MattermostEnv {
  const url = env.OC_MM_URL;
  const token = env.OC_MM_TOKEN;
  const team = env.OC_MM_TEAM;
  if (!url || !token || !team) {
    throw new Error("Set OC_MM_URL, OC_MM_TOKEN and OC_MM_TEAM");
  }
  return { url, token, team };
}

/**
 * Reads `OC_MM_*` keys from a dotenv-style file and returns them. A missing or unreadable file is not
 * an error — it yields an empty object. Nothing is written to `process.env`: the token would then
 * be inherited by every process opencode spawns. Callers merge the result under the real
 * environment, which stays authoritative for the keys it defines.
 */
export function loadEnvFile(path = ".env.local"): Record<string, string> {
  let file: string;
  try {
    file = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of file.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key.startsWith("OC_MM_")) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in values)) values[key] = value;
  }
  return values;
}
