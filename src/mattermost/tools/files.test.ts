import { afterEach, describe, expect, it } from "bun:test";
import type { ToolContext } from "@opencode-ai/plugin";
import { createMattermostContext } from "../context.js";
import type { MattermostEnv } from "../env.js";
import { getFileTool } from "./files.js";

const config: MattermostEnv = { url: "https://mm.example.com", token: "tok", team: "my-team" };
const FILE_ID = "ffffffffffffffffffffffff01";
const SCRATCH = "local/tmp/mm-files-test";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const toolCtx = (worktree: string) =>
  ({
    sessionID: "s",
    messageID: "m",
    agent: "a",
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }) as ToolContext;

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: RequestInit["redirect"];
  signal: RequestInit["signal"];
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      redirect: init?.redirect,
      signal: init?.signal,
    });
    return Promise.resolve(handler(String(input), init));
  }) as unknown as typeof fetch;
  return calls;
}

async function cleanScratch() {
  await Bun.$`rm -rf ${SCRATCH}`.quiet();
}

describe("mattermost_get_file", () => {
  it("saves with Content-Disposition name and sends the client's own headers", async () => {
    await cleanScratch();
    const calls = mockFetch(
      () =>
        new Response("data", {
          headers: { "Content-Disposition": 'attachment; filename="report.csv"' },
        }),
    );
    const ctx = createMattermostContext(config);
    const tctx = toolCtx(SCRATCH);
    const result = await getFileTool(ctx).execute({ file_id: FILE_ID }, tctx);
    expect(calls[0]?.url).toContain(`/api/v4/files/${FILE_ID}?`);
    expect(calls[0]?.headers.authorization?.toLowerCase()).toBe("bearer tok");
    expect(calls[0]?.headers["accept-language"]).toBe("en");
    expect(calls[0]?.redirect).toBe("manual");
    expect(calls[0]?.signal).toBe(tctx.abort);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("report.csv");
    expect(output).toContain(FILE_ID);
    expect(await Bun.file(`${SCRATCH}/.opencode/mm-files/report.csv`).text()).toBe("data");
    await cleanScratch();
  });

  it("prefers the name arg over Content-Disposition", async () => {
    await cleanScratch();
    mockFetch(
      () =>
        new Response("data", {
          headers: { "Content-Disposition": 'attachment; filename="wrong.txt"' },
        }),
    );
    const ctx = createMattermostContext(config);
    const result = await getFileTool(ctx).execute(
      { file_id: FILE_ID, name: "right.txt" },
      toolCtx(SCRATCH),
    );
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("right.txt");
    expect(await Bun.file(`${SCRATCH}/.opencode/mm-files/right.txt`).text()).toBe("data");
    await cleanScratch();
  });

  it("falls back to <id>.bin when no name and no header", async () => {
    await cleanScratch();
    mockFetch(() => new Response("data"));
    const ctx = createMattermostContext(config);
    const result = await getFileTool(ctx).execute({ file_id: FILE_ID }, toolCtx(SCRATCH));
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(`${FILE_ID}.bin`);
    expect(await Bun.file(`${SCRATCH}/.opencode/mm-files/${FILE_ID}.bin`).text()).toBe("data");
    await cleanScratch();
  });

  it("suffixes -1, -2 on collision", async () => {
    await cleanScratch();
    mockFetch(() => new Response("more"));
    const ctx = createMattermostContext(config);
    const worktree = SCRATCH;
    await Bun.write(`${worktree}/.opencode/mm-files/notes.txt`, "old");
    const first = await getFileTool(ctx).execute(
      { file_id: FILE_ID, name: "notes.txt" },
      toolCtx(worktree),
    );
    const second = await getFileTool(ctx).execute(
      { file_id: FILE_ID, name: "notes.txt" },
      toolCtx(worktree),
    );
    const out1 = typeof first === "string" ? first : first.output;
    const out2 = typeof second === "string" ? second : second.output;
    expect(out1).toContain("notes-1.txt");
    expect(out2).toContain("notes-2.txt");
    expect(await Bun.file(`${worktree}/.opencode/mm-files/notes.txt`).text()).toBe("old");
    expect(await Bun.file(`${worktree}/.opencode/mm-files/notes-1.txt`).text()).toBe("more");
    await cleanScratch();
  });

  it("falls back to the session directory when the worktree is not writable", async () => {
    await cleanScratch();
    mockFetch(() => new Response("data"));
    const ctx = createMattermostContext(config);
    const tctx = { ...toolCtx(SCRATCH), worktree: "/proc/nonexistent" } as ToolContext;
    const result = await getFileTool(ctx).execute({ file_id: FILE_ID, name: "saved.txt" }, tctx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(`${SCRATCH}/.opencode/mm-files/saved.txt`);
    expect(await Bun.file(`${SCRATCH}/.opencode/mm-files/saved.txt`).text()).toBe("data");
    await cleanScratch();
  });

  it("throws on non-ok response and quotes the server's message", async () => {
    mockFetch(() => new Response('{"message":"Unable to get the file."}', { status: 404 }));
    const ctx = createMattermostContext(config);
    await expect(getFileTool(ctx).execute({ file_id: FILE_ID }, toolCtx(SCRATCH))).rejects.toThrow(
      'File download failed (404): ffffffffffffffffffffffff01 — {"message":"Unable to get the file."}',
    );
    await cleanScratch();
  });

  it("refuses to follow a redirect", async () => {
    await cleanScratch();
    mockFetch(
      () => new Response(null, { status: 302, headers: { Location: "https://evil.example/x" } }),
    );
    const ctx = createMattermostContext(config);
    await expect(getFileTool(ctx).execute({ file_id: FILE_ID }, toolCtx(SCRATCH))).rejects.toThrow(
      "redirected to https://evil.example/x; refusing to follow it",
    );
    expect(await Bun.file(`${SCRATCH}/.opencode/mm-files/${FILE_ID}.bin`).exists()).toBe(false);
    await cleanScratch();
  });

  it("refuses a download over the size ceiling before writing anything", async () => {
    await cleanScratch();
    mockFetch(
      () => new Response("data", { headers: { "Content-Length": String(256 * 1024 * 1024 + 1) } }),
    );
    const ctx = createMattermostContext(config);
    await expect(getFileTool(ctx).execute({ file_id: FILE_ID }, toolCtx(SCRATCH))).rejects.toThrow(
      "over the 256.0 MB limit",
    );
    expect(await Bun.file(`${SCRATCH}/.opencode/mm-files/${FILE_ID}.bin`).exists()).toBe(false);
    await cleanScratch();
  });

  it("accepts a download right at the ceiling", async () => {
    await cleanScratch();
    mockFetch(
      () => new Response("data", { headers: { "Content-Length": String(256 * 1024 * 1024) } }),
    );
    const ctx = createMattermostContext(config);
    await getFileTool(ctx).execute({ file_id: FILE_ID }, toolCtx(SCRATCH));
    expect(await Bun.file(`${SCRATCH}/.opencode/mm-files/${FILE_ID}.bin`).text()).toBe("data");
    await cleanScratch();
  });

  it("proceeds when Content-Length is missing", async () => {
    await cleanScratch();
    const calls = mockFetch(() => new Response("data"));
    const ctx = createMattermostContext(config);
    await getFileTool(ctx).execute({ file_id: FILE_ID }, toolCtx(SCRATCH));
    expect(calls).toHaveLength(1);
    expect(await Bun.file(`${SCRATCH}/.opencode/mm-files/${FILE_ID}.bin`).text()).toBe("data");
    await cleanScratch();
  });

  it("sanitizes path separators in names", async () => {
    await cleanScratch();
    mockFetch(() => new Response("data"));
    const ctx = createMattermostContext(config);
    const result = await getFileTool(ctx).execute(
      { file_id: FILE_ID, name: "../evil.txt" },
      toolCtx(SCRATCH),
    );
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(".._evil.txt");
    await cleanScratch();
  });
});
