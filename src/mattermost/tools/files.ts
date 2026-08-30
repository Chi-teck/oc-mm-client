import { mkdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { humanSize, type MattermostContext, truncate } from "../context.js";

// The server caps uploads at `MaxFileSize` = 268435456 (`GET /api/v4/config/client?format=old`), so
// no legitimate attachment can exceed this and the ceiling can never refuse a real file.
const MAX_DOWNLOAD = 256 * 1024 * 1024;
// Same cut as `api.ts`: enough of the body to identify the failure, not a whole HTML error page.
const MAX_ERROR = 500;

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
async function ensureConfiguredDir(dir: string): Promise<string> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw new Error(`Download directory ${dir} could not be created`, { cause: error });
  }
  return dir;
}

async function uniquePath(dir: string, filename: string): Promise<string> {
  const ext = extname(filename);
  const base = basename(filename, ext);
  for (let i = 0; ; i++) {
    const target = join(dir, i === 0 ? filename : `${base}-${i}${ext}`);
    if (!(await Bun.file(target).exists())) return target;
  }
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
        throw new Error(
          `File ${fileId} is ${humanSize(declared)}, over the ${humanSize(MAX_DOWNLOAD)} limit`,
        );
      }
      const disposition = response.headers.get("content-disposition") ?? "";
      // Matches both `filename="x"` and the RFC 5987 `filename*=UTF-8''x` form.
      const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
      const preferred = (name ?? fromHeader ?? `${fileId}.bin`).replace(/[/\\]/g, "_");
      const dir = ctx.downloadDir
        ? await ensureConfiguredDir(ctx.downloadDir)
        : await ensureDownloadDir([tctx.worktree, tctx.directory, process.cwd()]);
      const target = await uniquePath(dir, preferred);
      await Bun.write(target, response);
      return {
        title: `Mattermost: saved ${preferred}`,
        output: `Saved ${target} (file id: ${fileId})`,
      };
    },
  });
}
