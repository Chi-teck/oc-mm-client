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
    // Only the keys that are actually absent are named: telling someone with a working url and
    // token to "set OC_MM_URL, OC_MM_TOKEN and OC_MM_TEAM" sends them auditing two settings that
    // were already right instead of the one that is not.
    const missing = [
      url ? null : "OC_MM_URL",
      token ? null : "OC_MM_TOKEN",
      team ? null : "OC_MM_TEAM",
    ].filter((name) => name !== null);
    throw new Error(`Set ${missing.join(", ").replace(/, (?=[^,]*$)/, " and ")}`);
  }
  return { url, token, team };
}

/**
 * Merges the real environment over `fileEnv`, key by key, but only where the real value carries
 * something: a variable that is exported empty (`export OC_MM_TEAM=`) is not a configuration
 * choice, and letting it win would blank the file's value and take the whole config down with it,
 * since one missing key rejects all three. Kept separate from a plain spread so both entry points
 * agree on that rule.
 */
export function mergeEnv(
  fileEnv: Record<string, string>,
  realEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...fileEnv, ...realEnv };
  for (const [key, value] of Object.entries(fileEnv)) {
    if (!realEnv[key]?.trim()) merged[key] = value;
  }
  return merged;
}

/**
 * Reads `OC_MM_*` keys from a dotenv-style file and returns them. A missing or unreadable file is not
 * an error — it yields an empty object. Nothing is written to `process.env`: the token would then
 * be inherited by every process opencode spawns. Callers pass the result through `mergeEnv`, which
 * keeps the real environment authoritative for the keys it actually fills in.
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
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
    const close = quote ? value.indexOf(quote, 1) : -1;
    if (close > 0) {
      // Quotes end the value, so anything after the closing one is a comment and a `#` inside them
      // is data — a token written as "a#b" must survive intact.
      value = value.slice(1, close);
    } else {
      // Unquoted, a `#` only opens a comment when it starts the value or follows whitespace, as in
      // dotenv: `OC_MM_TEAM=a#b` is one team name, while `OC_MM_TOKEN=tok # mine` kept its trailing
      // note in the token and made every request answer 401, which reads as an expired session.
      value = value.replace(/(^|\s)#.*$/, "").trimEnd();
    }
    // Last occurrence wins, as in dotenv: a duplicate lower in the file is the correction someone
    // pasted below the stale line, not a line to discard.
    values[key] = value;
  }
  return values;
}
