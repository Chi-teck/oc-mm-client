import { mkdir, open } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { humanSize, type MattermostContext, truncate } from "../context.js";

// The server caps uploads at `MaxFileSize` = 268435456 (`GET /api/v4/config/client?format=old`), so
// no legitimate attachment can exceed this and the ceiling can never refuse a real file.
const MAX_DOWNLOAD = 256 * 1024 * 1024;
// Same cut as `api.ts`: enough of the body to identify the failure, not a whole HTML error page.
const MAX_ERROR = 500;
// `notes.txt`, `notes-1.txt`, `notes-2.txt` is the naming callers see, but every collision costs one
// more syscall on the next download, and a configured directory keeps its files across sessions —
// so past this many namesakes a random suffix takes over and lands on a free name in one attempt.
const SEQUENTIAL_NAMES = 100;
// A random suffix only collides by accident, so a few retries are already generous; the bound is
// there so a name that can never be claimed ends the download instead of spinning forever.
const MAX_NAME_ATTEMPTS = SEQUENTIAL_NAMES + 10;

// Roots come in preference order: the worktree may be missing or read-only, so keep trying.
async function ensureDownloadDir(roots: string[]): Promise<string> {
  let lastError: unknown;
  for (const root of new Set(roots)) {
    const dir = resolve(root, ".opencode/mm-files");
    try {
      await mkdir(dir, { recursive: true });
      return dir;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// A configured directory never falls back. The walk above exists because nobody named a directory;
// once somebody has, writing to a different one is a silent surprise — and the path is in this
// tool's own description, so the caller would be told one place and handed another.
async function ensureConfiguredDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    // `registry.ts` forwards anything that is not a `ClientError` untouched and opencode prints only
    // `.message`, so a `cause` is read by nobody: without the errno in the text, a file sitting where
    // the directory should be (ENOTDIR), a path the process may not write (EACCES) and a full disk
    // (ENOSPC) all reach the user as the same sentence, and none of them says what to fix.
    const reason = (error as NodeJS.ErrnoException).code ?? String(error);
    throw new Error(`Download directory ${dir} could not be created (${reason})`, { cause: error });
  }
}

// Asking `exists()` and then writing lets two concurrent downloads of one name agree on the same
// free path, and the second `Bun.write` silently replaces the first file. `wx` (O_EXCL) hands that
// decision to the kernel instead: exactly one caller creates the name, the loser sees EEXIST and
// moves on. The body then goes through that very descriptor, so it lands in the file we claimed even
// if the path is renamed or replaced meanwhile.
async function writeUnique(dir: string, filename: string, response: Response): Promise<string> {
  const ext = extname(filename);
  const base = basename(filename, ext);
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const suffix = attempt < SEQUENTIAL_NAMES ? attempt : Math.random().toString(36).slice(2, 8);
    const target = join(dir, attempt === 0 ? filename : `${base}-${suffix}${ext}`);
    const handle = await open(target, "wx").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      return null;
    });
    if (!handle) continue;
    try {
      await Bun.write(Bun.file(handle.fd), response);
    } finally {
      // A write that fails partway still owes the descriptor back; leaking one per download would
      // exhaust the process's fd limit long before anyone noticed the failed downloads.
      await handle.close();
    }
    return target;
  }
  throw new Error(`No free name for ${filename} in ${dir} after ${MAX_NAME_ATTEMPTS} attempts`);
}

// An unread `Response` keeps its connection alive until GC happens to collect it. The throw paths
// below are not exotic — a `downloadDir` that cannot be created fails on every single call — so the
// body is released explicitly. `bodyUsed` covers the one case that must not be cancelled: once
// `Bun.write` has taken the stream it is locked, and cancelling a locked stream throws.
async function discardBody(response: Response): Promise<void> {
  if (!response.bodyUsed) await response.body?.cancel();
}

export function getFileTool(ctx: MattermostContext) {
  // What the model is told is where the file will be: a configured directory the description does
  // not name teaches the caller a path that then shows up in whatever it writes next.
  const where = ctx.downloadDir ?? "<worktree>/.opencode/mm-files/";
  return tool({
    description: `Download a Mattermost file attachment by id into ${where} and return the saved path.`,
    args: {
      file_id: tool.schema.string().describe("26-char file id"),
      name: tool.schema.string().optional().describe("Preferred file name"),
    },
    execute: async ({ file_id: fileId, name }, tctx) => {
      // Client4 only builds the URL for downloads — `doFetch` decodes the body by `Content-Type`
      // and would run `.text()` over a binary attachment — so the request is hand-rolled. It still
      // comes from `getOptions`, so the token, `Accept-Language` and the abort signal stay in one
      // place. The timestamp is the cache buster Mattermost appends to the query.
      const url = ctx.client.getFileUrl(fileId, Date.now());
      const response = await fetch(url, {
        ...ctx.client.getOptions({ signal: tctx.abort }),
        // Following a 3xx would resend the request — and the token — wherever the server points.
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") ?? "an undisclosed location";
        throw new Error(`File download ${fileId} redirected to ${location}; refusing to follow it`);
      }
      if (!response.ok) {
        // Read the body only here: on the success path it must reach `Bun.write` unconsumed.
        const detail = truncate((await response.text()).trim(), "response cut", MAX_ERROR);
        throw new Error(
          `File download failed (${response.status}): ${fileId}${detail ? ` — ${detail}` : ""}`,
        );
      }
      // `Bun.write` buffers the whole body whatever shape it is handed, so the declared length is
      // the only thing standing between a huge attachment and this process's heap. A missing or
      // unparseable header falls open — `Number(null)` is 0 and `Number("x")` is NaN, and both
      // compare false here: the server always sets it for a file download, and refusing without it
      // would break any proxy that re-chunks the response.
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_DOWNLOAD) {
        await discardBody(response);
        throw new Error(
          `File ${fileId} is ${humanSize(declared)}, over the ${humanSize(MAX_DOWNLOAD)} limit`,
        );
      }
      const disposition = response.headers.get("content-disposition") ?? "";
      // Matches both `filename="x"` and the RFC 5987 `filename*=UTF-8''x` form.
      const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
      const preferred = (name ?? fromHeader ?? `${fileId}.bin`).replace(/[/\\]/g, "_");
      let target: string;
      try {
        let dir = ctx.downloadDir;
        if (dir) await ensureConfiguredDir(dir);
        else dir = await ensureDownloadDir([tctx.worktree, tctx.directory, process.cwd()]);
        target = await writeUnique(dir, preferred, response);
      } catch (error) {
        await discardBody(response);
        throw error;
      }
      return {
        title: `Mattermost: saved ${preferred}`,
        output: `Saved ${target} (file id: ${fileId})`,
      };
    },
  });
}
