import { afterEach, describe, expect, it } from "bun:test";
import type { Client4 } from "@mattermost/client";
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

function mockClient(): Client4 {
  return {
    getFileUrl: (fileId: string, timestamp: number) =>
      `https://mm.example.com/api/v4/files/${fileId}?_=${timestamp}`,
  } as unknown as Client4;
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return Promise.resolve(handler(String(input), init));
  }) as unknown as typeof fetch;
  return calls;
}

async function cleanScratch() {
  await Bun.$`rm -rf ${SCRATCH}`.quiet();
}

describe("mattermost_get_file", () => {
  it("saves with Content-Disposition name and sends Bearer auth", async () => {
    await cleanScratch();
    const calls = mockFetch(
      () =>
        new Response("data", {
          headers: { "Content-Disposition": 'attachment; filename="report.csv"' },
        }),
    );
    const ctx = createMattermostContext(config, mockClient());
    const result = await getFileTool(ctx).execute({ file_id: FILE_ID }, toolCtx(SCRATCH));
    expect(calls[0]?.url).toContain(`/api/v4/files/${FILE_ID}?_=`);
    expect(calls[0]?.headers.authorization?.toLowerCase()).toBe("bearer tok");
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
    const ctx = createMattermostContext(config, mockClient());
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
    const ctx = createMattermostContext(config, mockClient());
    const result = await getFileTool(ctx).execute({ file_id: FILE_ID }, toolCtx(SCRATCH));
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(`${FILE_ID}.bin`);
    expect(await Bun.file(`${SCRATCH}/.opencode/mm-files/${FILE_ID}.bin`).text()).toBe("data");
    await cleanScratch();
  });

  it("suffixes -1, -2 on collision", async () => {
    await cleanScratch();
    mockFetch(() => new Response("more"));
    const ctx = createMattermostContext(config, mockClient());
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
    const ctx = createMattermostContext(config, mockClient());
    const tctx = { ...toolCtx(SCRATCH), worktree: "/proc/nonexistent" } as ToolContext;
    const result = await getFileTool(ctx).execute({ file_id: FILE_ID, name: "saved.txt" }, tctx);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(`${SCRATCH}/.opencode/mm-files/saved.txt`);
    expect(await Bun.file(`${SCRATCH}/.opencode/mm-files/saved.txt`).text()).toBe("data");
    await cleanScratch();
  });

  it("throws on non-ok response", async () => {
    mockFetch(() => new Response("nope", { status: 404 }));
    const ctx = createMattermostContext(config, mockClient());
    await expect(getFileTool(ctx).execute({ file_id: FILE_ID }, toolCtx(SCRATCH))).rejects.toThrow(
      "File download failed (404)",
    );
    await cleanScratch();
  });

  it("sanitizes path separators in names", async () => {
    await cleanScratch();
    mockFetch(() => new Response("data"));
    const ctx = createMattermostContext(config, mockClient());
    const result = await getFileTool(ctx).execute(
      { file_id: FILE_ID, name: "../evil.txt" },
      toolCtx(SCRATCH),
    );
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(".._evil.txt");
    await cleanScratch();
  });
});
