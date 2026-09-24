import { z } from "zod";
import { type MattermostContext, truncate } from "../context.js";
import { confirmWrite } from "./confirm.js";
import { tool } from "./types.js";

const MAX_OUTPUT = 4000;
const MAX_ERROR = 500;
const MAX_CONFIRM = 200;
const FULL_HINT = "pass full=true for the whole response";

/** Replaces `{team_id}` / `{user_id}`, hitting the context caches only when they are used. */
async function expandPath(ctx: MattermostContext, path: string): Promise<string> {
  let expanded = path;
  if (expanded.includes("{team_id}")) {
    expanded = expanded.replaceAll("{team_id}", (await ctx.team()).id);
  }
  if (expanded.includes("{user_id}")) {
    expanded = expanded.replaceAll("{user_id}", (await ctx.me()).id);
  }
  return expanded;
}

/**
 * Resolves a caller-supplied path against `<url>/api/v4`. The request carries the personal access
 * token, so the path must not be able to send it anywhere else: an absolute URL is refused, and
 * anything that resolves outside the API root — `..` climbing, mostly — is refused too, both as
 * written and as the server reads it once the escapes are decoded. The path is concatenated onto
 * the absolute base rather than resolved against it, so a protocol-relative `//host` stays a path
 * segment. This matters because the path comes from a model that reads untrusted channel content.
 */
export function apiUrl(ctx: MattermostContext, path: string): { url: URL; target: string } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new Error(`Path must be relative to /api/v4, not a full URL: ${path}`);
  }
  const base = ctx.client.getBaseRoute();
  // Only a whole `api/v4` segment is a prefix: stripping it from `/api/v4beta/x` would quietly
  // rewrite the request to a different endpoint.
  const rest = path.replace(/^\/?api\/v4(?=\/|$)/, "");
  const url = new URL(`${base}${rest.startsWith("/") ? "" : "/"}${rest}`);
  const root = new URL(base);
  if (url.origin !== root.origin || !url.pathname.startsWith(`${root.pathname}/`)) {
    throw new Error(`Path must stay under ${base}: ${path}`);
  }
  // `new URL` resolves `..`, but `%2f` and `%5c` stay encoded, so `..%2f..%2fevil` survives the
  // check above and only the server sees the climb. Re-run the same parse over the decoded path,
  // holding back `?` and `#` so they stay path characters instead of ending the path early. Only
  // the path is decoded: `%2f` in a query value is data, and `?terms=docs%2Fapi` must still work.
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw new Error(`Path must use valid percent-encoding: ${path}`);
  }
  const replay = new URL(root.origin + decoded.replaceAll("?", "%3F").replaceAll("#", "%23"));
  if (!replay.pathname.startsWith(`${root.pathname}/`)) {
    throw new Error(`Path must stay under ${base}: ${path}`);
  }
  // The normalized path as the caller writes it — what the permission prompt should show.
  return { url, target: `${url.pathname.slice(root.pathname.length)}${url.search}` };
}

export function apiTool(ctx: MattermostContext) {
  return tool({
    description:
      "Fallback for Mattermost REST endpoints that have no dedicated tool: send a raw request under /api/v4 and return the response body. Prefer a dedicated mattermost_* tool whenever one covers the task — those resolve channel names and format the output for reading. Non-GET methods ask for permission.",
    input: z.object({
      path: z
        .string()
        .describe(
          'Endpoint under /api/v4, e.g. "/users/me/status" — may carry a query string and the {team_id} and {user_id} placeholders',
        ),
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
        .optional()
        .describe("HTTP method (default GET)"),
      body: z.string().optional().describe("Request body as a JSON string"),
      full: z
        .boolean()
        .optional()
        .describe(`Print the whole response instead of cutting it at ${MAX_OUTPUT} chars`),
    }),
    execute: async ({ path, method, body, full }, tctx) => {
      const verb = method ?? "GET";
      if (body !== undefined) {
        if (verb === "GET") throw new Error("A GET request cannot carry a body");
        try {
          JSON.parse(body);
        } catch {
          throw new Error(`body is not valid JSON: ${truncate(body, "shorten it", 120)}`);
        }
      }
      const { url, target } = apiUrl(ctx, await expandPath(ctx, path));
      if (verb !== "GET") {
        // Spell out the body: the path alone does not say what a `POST /posts` would write, and
        // approving the call is approving this exact payload.
        const payload = body === undefined ? "" : `: ${body.slice(0, MAX_CONFIRM)}`;
        await confirmWrite(tctx, "mattermost_api", `mattermost_api ${verb} ${target}${payload}`);
      }
      // Client4 exposes no generic request method (`doFetch` is protected and drops the status
      // code), so the request is hand-rolled — but `getOptions` still builds the headers, so the
      // token and content type stay in one place.
      const response = await fetch(url, {
        ...ctx.client.getOptions({ method: verb, body, signal: tctx.signal }),
        // The path guard only covers the first hop. Following a 3xx would resend the request —
        // and, while it stays on this origin, the token — wherever the server points.
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") ?? "an undisclosed location";
        throw new Error(
          `Mattermost API ${verb} ${target} redirected to ${location}; refusing to follow it`,
        );
      }
      const text = (await response.text()).trim();
      if (!response.ok) {
        throw new Error(
          `Mattermost API ${verb} ${target} failed (${response.status}): ${truncate(text, "response cut", MAX_ERROR)}`,
        );
      }
      return {
        title: `Mattermost: ${verb} ${target}`,
        output: text ? (full ? text : truncate(text, FULL_HINT, MAX_OUTPUT)) : "(empty response)",
      };
    },
  });
}
