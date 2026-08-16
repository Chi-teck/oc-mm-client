import { mkdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { tool } from "@opencode-ai/plugin";
import type { MattermostContext } from "../context.js";

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

async function uniquePath(dir: string, filename: string): Promise<string> {
  const ext = extname(filename);
  const base = basename(filename, ext);
  for (let i = 0; ; i++) {
    const target = join(dir, i === 0 ? filename : `${base}-${i}${ext}`);
    if (!(await Bun.file(target).exists())) return target;
  }
}

export function getFileTool(ctx: MattermostContext) {
  return tool({
    description:
      "Download a Mattermost file attachment by id into <worktree>/.opencode/mm-files/ and return the saved path.",
    args: {
      file_id: tool.schema.string().describe("26-char file id"),
      name: tool.schema.string().optional().describe("Preferred file name"),
    },
    execute: async ({ file_id: fileId, name }, tctx) => {
      // Client4 only builds the URL for downloads, so fetch the bytes directly. The timestamp is
      // the cache buster Mattermost appends to the query.
      const url = ctx.client.getFileUrl(fileId, Date.now());
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${ctx.config.token}` },
      });
      if (!response.ok) {
        throw new Error(`File download failed (${response.status}): ${fileId}`);
      }
      const disposition = response.headers.get("content-disposition") ?? "";
      // Matches both `filename="x"` and the RFC 5987 `filename*=UTF-8''x` form.
      const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
      const preferred = (name ?? fromHeader ?? `${fileId}.bin`).replace(/[/\\]/g, "_");
      const dir = await ensureDownloadDir([tctx.worktree, tctx.directory, process.cwd()]);
      const target = await uniquePath(dir, preferred);
      await Bun.write(target, await response.arrayBuffer());
      return {
        title: `Mattermost: saved ${preferred}`,
        output: `Saved ${target} (file id: ${fileId})`,
      };
    },
  });
}
