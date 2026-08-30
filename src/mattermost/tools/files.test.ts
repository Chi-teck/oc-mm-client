import { afterEach, describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
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

  it("writes into a configured directory, creating it", async () => {
    await cleanScratch();
    mockFetch(
      () =>
        new Response("data", {
          headers: { "Content-Disposition": 'attachment; filename="report.csv"' },
        }),
    );
    const downloadDir = resolve(SCRATCH, "attachments");
    const ctx = createMattermostContext(config, undefined, { downloadDir });
    const result = await getFileTool(ctx).execute({ file_id: FILE_ID }, toolCtx(SCRATCH));
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain(`${downloadDir}/report.csv`);
    expect(await Bun.file(`${downloadDir}/report.csv`).text()).toBe("data");
    // The default is not created alongside it: a configured directory is the only destination.
    expect(await Bun.file(`${SCRATCH}/.opencode/mm-files/report.csv`).exists()).toBe(false);
    await cleanScratch();
  });

  it("reports a configured directory it cannot create, without relocating", async () => {
    await cleanScratch();
    mockFetch(() => new Response("data", { headers: { "Content-Disposition": "x.txt" } }));
    const ctx = createMattermostContext(config, undefined, {
      downloadDir: "/proc/nonexistent/mm-files",
    });
    await expect(
      getFileTool(ctx).execute({ file_id: FILE_ID, name: "saved.txt" }, toolCtx(SCRATCH)),
    ).rejects.toThrow(
      /^Download directory \/proc\/nonexistent\/mm-files could not be created \(E[A-Z]+\)$/,
    );
    expect(await Bun.file(`${SCRATCH}/.opencode/mm-files/saved.txt`).exists()).toBe(false);
    await cleanScratch();
  });

  it("names the OS reason when the configured directory is a regular file", async () => {
    await cleanScratch();
    mockFetch(() => new Response("data"));
    const blocker = resolve(SCRATCH, "attachments");
    await Bun.write(blocker, "in the way");
    const ctx = createMattermostContext(config, undefined, {
      downloadDir: join(blocker, "files"),
    });
    await expect(
      getFileTool(ctx).execute({ file_id: FILE_ID, name: "saved.txt" }, toolCtx(SCRATCH)),
    ).rejects.toThrow(`could not be created (ENOTDIR)`);
    await cleanScratch();
  });

  it("cancels the body instead of leaking it when the directory cannot be created", async () => {
    await cleanScratch();
    let cancelled = false;
    mockFetch(
      () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.enqueue(new TextEncoder().encode("data")),
            cancel: () => {
              cancelled = true;
            },
          }),
        ),
    );
    const ctx = createMattermostContext(config, undefined, {
      downloadDir: "/proc/nonexistent/mm-files",
    });
    await expect(
      getFileTool(ctx).execute({ file_id: FILE_ID, name: "saved.txt" }, toolCtx(SCRATCH)),
    ).rejects.toThrow("could not be created");
    expect(cancelled).toBe(true);
    await cleanScratch();
  });

  it("cancels the body when the download is over the size ceiling", async () => {
    await cleanScratch();
    let cancelled = false;
    mockFetch(
      () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
          { headers: { "Content-Length": String(256 * 1024 * 1024 + 1) } },
        ),
    );
    const ctx = createMattermostContext(config);
    await expect(getFileTool(ctx).execute({ file_id: FILE_ID }, toolCtx(SCRATCH))).rejects.toThrow(
      "over the 256.0 MB limit",
    );
    expect(cancelled).toBe(true);
    await cleanScratch();
  });

  it("gives concurrent downloads of one name a file each", async () => {
    await cleanScratch();
    let n = 0;
    mockFetch(() => new Response(`body-${n++}`));
    const ctx = createMattermostContext(config);
    const results = await Promise.all([
      getFileTool(ctx).execute({ file_id: FILE_ID, name: "notes.txt" }, toolCtx(SCRATCH)),
      getFileTool(ctx).execute({ file_id: FILE_ID, name: "notes.txt" }, toolCtx(SCRATCH)),
    ]);
    const paths = results.map((r) => (typeof r === "string" ? r : r.output).split(" ")[1] ?? "");
    expect(new Set(paths).size).toBe(2);
    const bodies = await Promise.all(paths.map((p) => Bun.file(p).text()));
    expect(new Set(bodies)).toEqual(new Set(["body-0", "body-1"]));
    await cleanScratch();
  });

  it("writes a binary body byte for byte", async () => {
    await cleanScratch();
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    mockFetch(() => new Response(bytes));
    const ctx = createMattermostContext(config);
    await getFileTool(ctx).execute({ file_id: FILE_ID, name: "blob.bin" }, toolCtx(SCRATCH));
    const saved = new Uint8Array(
      await Bun.file(`${SCRATCH}/.opencode/mm-files/blob.bin`).arrayBuffer(),
    );
    expect(saved).toEqual(bytes);
    await cleanScratch();
  });

  it("switches to a random suffix once the sequential names run out", async () => {
    await cleanScratch();
    mockFetch(() => new Response("new"));
    const dir = `${SCRATCH}/.opencode/mm-files`;
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        Bun.write(`${dir}/${i === 0 ? "notes.txt" : `notes-${i}.txt`}`, "old"),
      ),
    );
    const ctx = createMattermostContext(config);
    const result = await getFileTool(ctx).execute(
      { file_id: FILE_ID, name: "notes.txt" },
      toolCtx(SCRATCH),
    );
    const output = typeof result === "string" ? result : result.output;
    expect(output).not.toContain("notes-100.txt");
    expect(output).toMatch(/notes-[a-z0-9]+\.txt/);
    await cleanScratch();
  });

  it("names the configured directory in the description", async () => {
    const downloadDir = resolve(SCRATCH, "attachments");
    const ctx = createMattermostContext(config, undefined, { downloadDir });
    expect(getFileTool(ctx).description).toBe(
      `Download a Mattermost file attachment by id into ${downloadDir} and return the saved path.`,
    );
  });

  it("keeps the default description when no directory is configured", () => {
    const ctx = createMattermostContext(config);
    expect(getFileTool(ctx).description).toBe(
      "Download a Mattermost file attachment by id into <worktree>/.opencode/mm-files/ and return the saved path.",
    );
  });
});
