import { afterEach, describe, expect, it } from "bun:test";
import type { ToolContext } from "@opencode-ai/plugin";
import { createMattermostContext } from "../context.js";
import type { MattermostEnv } from "../env.js";
import { apiTool } from "./api.js";

const config: MattermostEnv = { url: "https://mm.example.com", token: "tok", team: "my-team" };
const ME_ID = "uuuuuuuuuuuuuuuuuuuuuuuuu1";
const TEAM_ID = "tttttttttttttttttttttttttt";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const toolCtx = (onAsk?: (input: unknown) => Promise<void>) =>
  ({
    sessionID: "s",
    messageID: "m",
    agent: "a",
    directory: "local/tmp",
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: onAsk ?? (async () => {}),
  }) as ToolContext;

function recordingCtx() {
  const asks: unknown[] = [];
  return { asks, tctx: toolCtx(async (input) => void asks.push(input)) };
}

const rejectingCtx = () =>
  toolCtx(async () => {
    throw new Error("The user rejected permission to use this specific tool call.");
  });

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A real Client4 pointed at a stubbed `fetch`, so the tool's url building and `getOptions` headers
 * are exercised for real. `/users/me` and the team lookup are answered because the placeholders
 * resolve through the context.
 */
function makeTool(respond: (url: URL) => Response = () => json({ ok: true })) {
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body === undefined ? undefined : String(init.body),
    });
    if (url.pathname === "/api/v4/users/me") return Promise.resolve(json({ id: ME_ID }));
    if (url.pathname === "/api/v4/teams/name/my-team")
      return Promise.resolve(json({ id: TEAM_ID }));
    return Promise.resolve(respond(url));
  }) as unknown as typeof fetch;
  const { execute } = apiTool(createMattermostContext(config));
  return { api: execute, calls };
}

function outputOf(result: Awaited<ReturnType<ReturnType<typeof apiTool>["execute"]>>): string {
  return typeof result === "string" ? result : result.output;
}

describe("mattermost_api", () => {
  it("sends a GET with the bearer token and returns the body verbatim", async () => {
    const { api, calls } = makeTool(() => json({ status: "online" }));
    const { asks, tctx } = recordingCtx();

    const result = await api({ path: "/users/me/status" }, tctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://mm.example.com/api/v4/users/me/status");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.authorization?.toLowerCase()).toBe("bearer tok");
    expect(outputOf(result)).toBe('{"status":"online"}');
    expect(asks).toEqual([]);
  });

  it("accepts a path with or without the leading slash and /api/v4 prefix", async () => {
    for (const path of ["users/me/status", "/users/me/status", "/api/v4/users/me/status"]) {
      const { api, calls } = makeTool();
      await api({ path }, toolCtx());
      expect(calls[0]?.url).toBe("https://mm.example.com/api/v4/users/me/status");
    }
  });

  it("keeps a query string", async () => {
    const { api, calls } = makeTool();
    await api({ path: "/users?per_page=2&page=1" }, toolCtx());
    expect(calls[0]?.url).toBe("https://mm.example.com/api/v4/users?per_page=2&page=1");
  });

  it("expands {team_id} and {user_id}", async () => {
    const { api, calls } = makeTool();
    await api({ path: "/teams/{team_id}/channels/{user_id}" }, toolCtx());
    expect(calls.at(-1)?.url).toBe(
      `https://mm.example.com/api/v4/teams/${TEAM_ID}/channels/${ME_ID}`,
    );
  });

  it("resolves nothing when the path has no placeholder", async () => {
    const { api, calls } = makeTool();
    await api({ path: "/users/me/status" }, toolCtx());
    expect(calls).toHaveLength(1);
  });

  it("asks for permission before a non-GET request", async () => {
    const { api, calls } = makeTool(() => json({ id: "p1" }));
    const { asks, tctx } = recordingCtx();

    await api({ path: "/posts", method: "POST", body: '{"message":"hi"}' }, tctx);

    const summary = 'mattermost_api POST /posts: {"message":"hi"}';
    expect(asks).toEqual([
      {
        permission: "mattermost_api",
        patterns: [summary],
        always: [],
        metadata: { summary },
      },
    ]);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe('{"message":"hi"}');
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
  });

  it("shows the body in the permission request, cut at 200 chars", async () => {
    const { api } = makeTool(() => json({ id: "p1" }));
    const { asks, tctx } = recordingCtx();
    const message = "x".repeat(300);

    await api({ path: "/posts", method: "POST", body: JSON.stringify({ message }) }, tctx);

    const summary = (asks[0] as { metadata: { summary: string } }).metadata.summary;
    expect(summary.startsWith('mattermost_api POST /posts: {"message":"xxx')).toBe(true);
    expect(summary).toHaveLength("mattermost_api POST /posts: ".length + 200);
  });

  it("sends nothing when permission is rejected", async () => {
    const { api, calls } = makeTool();
    await expect(api({ path: "/posts/p1", method: "DELETE" }, rejectingCtx())).rejects.toThrow(
      "rejected permission",
    );
    expect(calls).toEqual([]);
  });

  it("rejects a malformed body before sending anything", async () => {
    const { api, calls } = makeTool();
    await expect(
      api({ path: "/posts", method: "POST", body: "message=hi" }, toolCtx()),
    ).rejects.toThrow("body is not valid JSON");
    expect(calls).toEqual([]);
  });

  it("refuses a body on a GET", async () => {
    const { api, calls } = makeTool();
    await expect(api({ path: "/users", body: "{}" }, toolCtx())).rejects.toThrow(
      "GET request cannot carry a body",
    );
    expect(calls).toEqual([]);
  });

  it("reports the status and the server message on failure", async () => {
    const { api } = makeTool(() => json({ message: "Unable to find the channel." }, 404));
    await expect(api({ path: "/channels/nope" }, toolCtx())).rejects.toThrow(
      /GET \/channels\/nope failed \(404\): .*Unable to find the channel/,
    );
  });

  it("cuts a long response unless full is set", async () => {
    const big = "x".repeat(5000);
    const { api } = makeTool(() => new Response(big));

    const cut = outputOf(await api({ path: "/users" }, toolCtx()));
    expect(cut).toContain("truncated at 4000 chars — pass full=true");
    expect(cut.startsWith("x".repeat(4000))).toBe(true);

    const whole = outputOf(await api({ path: "/users", full: true }, toolCtx()));
    expect(whole).toBe(big);
  });

  it("reports an empty body instead of returning nothing", async () => {
    const { api } = makeTool(() => new Response(""));
    expect(outputOf(await api({ path: "/users/me/status" }, toolCtx()))).toBe("(empty response)");
  });

  it("refuses paths that would leave the server", async () => {
    for (const path of ["https://evil.example/x", "/../../evil", "/users/../../../evil"]) {
      const { api, calls } = makeTool();
      await expect(api({ path }, toolCtx())).rejects.toThrow(/Path must/);
      expect(calls).toEqual([]);
    }
  });

  it("strips only a whole api/v4 segment", async () => {
    // `/api/v4beta` is not the prefix: stripping the first 7 characters would send the request to
    // a different endpoint than the caller asked for, and report the result as if it were right.
    const { api, calls } = makeTool();
    await api({ path: "/api/v4beta/users" }, toolCtx());
    expect(calls[0]?.url).toBe("https://mm.example.com/api/v4/api/v4beta/users");
  });

  it("refuses to follow a redirect off the API root", async () => {
    const { api } = makeTool(
      () => new Response(null, { status: 302, headers: { Location: "https://evil.example/x" } }),
    );
    await expect(api({ path: "/users/me/status" }, toolCtx())).rejects.toThrow(
      "redirected to https://evil.example/x; refusing to follow it",
    );
  });

  it("keeps a protocol-relative path on the configured host", async () => {
    // The path is concatenated onto the absolute base, so `//host` is just a path segment here.
    const { api, calls } = makeTool();
    await api({ path: "//evil.example/x" }, toolCtx());
    expect(calls[0]?.url).toBe("https://mm.example.com/api/v4//evil.example/x");
  });
});
