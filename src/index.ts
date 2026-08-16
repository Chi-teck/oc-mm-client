import type { Plugin, PluginOptions } from "@opencode-ai/plugin";
import { createMattermostClient } from "./mattermost/client.js";
import { createMattermostContext, withTimeout } from "./mattermost/context.js";
import { loadEnvFile, type MattermostEnv, readMattermostEnv } from "./mattermost/env.js";
import { createTools } from "./mattermost/tools/registry.js";

const STARTUP_TIMEOUT_MS = 10_000;

function strOption(options: PluginOptions | undefined, key: string): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export default (async (_input, options) => {
  loadEnvFile();
  let env: MattermostEnv | undefined;
  try {
    env = readMattermostEnv();
  } catch {
    // Incomplete env is not fatal here: plugin options can supply what is missing.
    env = undefined;
  }
  const url = strOption(options, "url") ?? env?.url;
  const token = strOption(options, "token") ?? env?.token;
  const team = strOption(options, "team") ?? env?.team;
  if (!url || !token || !team) {
    console.error(
      "mm-oc-client disabled: set MM_URL, MM_TOKEN and MM_TEAM, or url/token/team plugin options",
    );
    return {};
  }

  const client = createMattermostClient({ url, token });
  const ctx = createMattermostContext({ url, token, team }, client);
  try {
    // Probe the server once at load; registering tools we cannot serve would turn every
    // later tool call into an error. `me()` goes first because it is the call that proves the
    // token — running it alongside `team()` let the team lookup's "team not found" win the race
    // and report a bad token as a bad team.
    await withTimeout(
      (async () => {
        await ctx.me();
        await ctx.team();
      })(),
      STARTUP_TIMEOUT_MS,
      `${url} did not respond within ${STARTUP_TIMEOUT_MS}ms`,
    );
  } catch (error) {
    console.error(
      `mm-oc-client disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }

  return { tool: createTools(ctx) };
}) satisfies Plugin;
