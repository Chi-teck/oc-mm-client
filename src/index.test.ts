import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import { startMockMattermost } from "../test/mock-server.js";
import plugin from "./index.js";

const OC_MM_KEYS = ["OC_MM_URL", "OC_MM_TOKEN", "OC_MM_TEAM"] as const;
/** The plugin refuses to start without one, so every test that expects tools passes it. */
const DOWNLOAD_DIR = "attachments";
// Root writes through the permission bits, so the writability check would pass and prove nothing.
const asRoot = process.getuid?.() === 0;

let cwd: string;
let sandbox: string;
let input: Where;
let saved: Record<string, string | undefined>;

/** The two paths `setup` takes from `ctx.location`. */
interface Where {
  directory: string;
  worktree: string;
}

/**
 * `worktree` defaults to `directory` because opencode always sends both — `project.directory` is
 * non-optional in `Location.Info` — and the cast below would otherwise let the suite drive a branch
 * that cannot happen in production while leaving the real one untested.
 */
function pluginInput(directory: string, worktree = directory): Where {
  return { directory, worktree };
}

/**
 * Just the parts of the v2 context `setup` touches. The RPC side answers nothing: whether a write
 * gets confirmed is `prompt.test.ts`'s business, and here no TUI is ever attached.
 */
function fakeContext(where: Where, options: unknown, tools: Record<string, ToolInfo>) {
  return {
    location: {
      directory: where.directory,
      project: { id: "p", directory: where.worktree, canonical: where.worktree },
    },
    options: options ?? {},
    rpc: {
      register: async () => ({ dispose: async () => {}, events: { emit: async () => {} } }),
    },
    tool: {
      transform: async (edit: (editor: { add(tool: ToolInfo): void }) => void) => {
        edit({
          add: (tool) => {
            tools[tool.name] = tool;
          },
        });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Plugin.Context;
}

/** Runs `setup` and returns the tools it registered, keyed by name. */
async function start(where: Where, options?: unknown): Promise<Record<string, ToolInfo>> {
  const tools: Record<string, ToolInfo> = {};
  await plugin.setup(fakeContext(where, options, tools));
  return tools;
}

/** Runs `setup` expecting it to refuse, and returns the reason it gave. */
async function refusal(where: Where, options?: unknown): Promise<string> {
  const tools: Record<string, ToolInfo> = {};
  const error = await plugin.setup(fakeContext(where, options, tools)).then(
    () => new Error("setup did not refuse"),
    (thrown: unknown) => thrown,
  );
  expect(tools).toEqual({});
  return error instanceof Error ? error.message : String(error);
}

/** A throwaway project directory with the download directory the plugin insists on already in it. */
async function newProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
  await mkdir(join(dir, DOWNLOAD_DIR));
  return dir;
}

/**
 * Starts the plugin on options it must refuse and returns the reason. No mock server: the gate
 * throws before anything is probed, and the credentials are only there to prove that the refusal
 * was not about them.
 */
async function refuseOptions(project: string, extra: Record<string, unknown>): Promise<string> {
  const options = { url: "https://mm.example.com", token: "tok", team: "my-team", ...extra };
  return refusal(pluginInput(project), options);
}

const refuse = (project: string, downloadDir: unknown) => refuseOptions(project, { downloadDir });

/** The `downloadDir` is a good one, so only the upload root can be what the refusal is about. */
const refuseUpload = (project: string, uploadRoot: unknown) =>
  refuseOptions(project, { downloadDir: DOWNLOAD_DIR, uploadRoot });

beforeAll(async () => {
  cwd = process.cwd();
  sandbox = await mkdtemp(join(tmpdir(), "oc-mm-plugin-"));
  await mkdir(join(sandbox, DOWNLOAD_DIR));
  input = pluginInput(sandbox);
  process.chdir(sandbox);
  saved = Object.fromEntries(OC_MM_KEYS.map((key) => [key, process.env[key]]));
  for (const key of OC_MM_KEYS) delete process.env[key];
});

afterAll(async () => {
  for (const key of OC_MM_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.chdir(cwd);
  await rm(sandbox, { recursive: true, force: true });
});

describe("plugin entry", () => {
  it("registers every Mattermost tool once the credentials validate", async () => {
    const server = startMockMattermost();
    try {
      const tools = await start(input, {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
      });
      expect(Object.keys(tools)).toContain("mattermost_read_posts");
      expect(Object.keys(tools)).toHaveLength(15);
      expect(server.paths).toContain("/api/v4/users/me");
      expect(server.paths).toContain("/api/v4/teams/name/my-team");
    } finally {
      server.stop();
    }
  });

  it("registers direct tools, outside Code Mode, that answer with content", async () => {
    const server = startMockMattermost();
    const tctx = { sessionID: "s", signal: new AbortController().signal };
    try {
      const options = { url: server.url, token: "tok", team: "my-team", downloadDir: DOWNLOAD_DIR };
      const list = (await start(input, options)).mattermost_list_channels;
      expect(list?.options).toEqual({ codemode: false });
      const result = await list?.execute({}, tctx as never);
      expect(result?.content).toContain("- my-channel — My Channel");
      expect(result?.metadata).toEqual({ title: "Mattermost: 1 channels" });
    } finally {
      server.stop();
    }
  });

  it("refuses a write when no TUI is attached to confirm it, before sending anything", async () => {
    const server = startMockMattermost();
    const tctx = { sessionID: "s", signal: new AbortController().signal };
    try {
      const options = { url: server.url, token: "tok", team: "my-team", downloadDir: DOWNLOAD_DIR };
      const post = (await start(input, options)).mattermost_create_post;
      await expect(
        post?.execute({ channel: "my-channel", message: "hi" }, tctx as never),
      ).rejects.toThrow("no opencode TUI is attached");
      expect(server.paths).not.toContain("/api/v4/posts");
    } finally {
      server.stop();
    }
  });

  it('sends a write with no TUI attached when confirm is "none"', async () => {
    const server = startMockMattermost();
    const tctx = { sessionID: "s", signal: new AbortController().signal };
    try {
      const options = {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
        confirm: "none",
      };
      const post = (await start(input, options)).mattermost_create_post;
      const result = await post?.execute({ channel: "my-channel", message: "hi" }, tctx as never);
      expect(result?.content).toContain("Posted to my-channel");
      expect(server.paths).toContain("/api/v4/posts");
    } finally {
      server.stop();
    }
  });

  it('refuses a write with no TUI attached when confirm is "tui", as when it is unset', async () => {
    const server = startMockMattermost();
    const tctx = { sessionID: "s", signal: new AbortController().signal };
    try {
      const options = {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
        confirm: "tui",
      };
      const post = (await start(input, options)).mattermost_create_post;
      await expect(
        post?.execute({ channel: "my-channel", message: "hi" }, tctx as never),
      ).rejects.toThrow("no opencode TUI is attached");
      expect(server.paths).not.toContain("/api/v4/posts");
    } finally {
      server.stop();
    }
  });

  it("refuses a confirm that is not one of the known modes and quotes it", async () => {
    const project = await newProject();
    try {
      const refuseConfirm = (confirm: unknown) =>
        refuseOptions(project, { downloadDir: DOWNLOAD_DIR, confirm });
      expect(await refuseConfirm("yes")).toBe(
        'oc-mm-client disabled: confirm "yes" is not one of "tui", "none"',
      );
      expect(await refuseConfirm(1)).toContain('confirm 1 is not one of "tui", "none"');
      expect(await refuseConfirm("  ")).toContain('confirm "  " is not one of');
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("reports a bad confirm and a bad downloadDir in one line", async () => {
    const project = await newProject();
    try {
      const line = await refuseOptions(project, { downloadDir: "../escape", confirm: "yes" });
      expect(line).toContain("downloadDir ../escape resolves to ");
      expect(line).toContain('; confirm "yes" is not one of');
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("registers no tools when credentials are missing", async () => {
    expect(await refusal(input, { downloadDir: DOWNLOAD_DIR })).toContain("oc-mm-client disabled");
  });

  it("names only the credential that is actually missing", async () => {
    const options = { url: "https://mm.example.com", token: "tok", downloadDir: DOWNLOAD_DIR };
    const line = await refusal(input, options);
    expect(line).toContain("oc-mm-client disabled: set OC_MM_TEAM");
    expect(line).toContain("the team plugin option");
    expect(line).not.toContain("OC_MM_URL");
  });

  it("registers no tools when the server rejects the token", async () => {
    const server = startMockMattermost({ unauthorized: true });
    try {
      const options = { url: server.url, token: "bad", team: "my-team", downloadDir: DOWNLOAD_DIR };
      expect(await refusal(input, options)).toContain("oc-mm-client disabled");
    } finally {
      server.stop();
    }
  });

  it("blames the token, not the team, when the server rejects the token", async () => {
    const server = startMockMattermost({ unauthorized: true });
    try {
      const line = await refusal(input, {
        url: server.url,
        token: "bad",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
      });
      expect(line).toContain("Invalid or expired session");
      expect(line).not.toContain("team not found");
    } finally {
      server.stop();
    }
  });

  it("names the status and endpoint when the server sends no error message", async () => {
    const server = startMockMattermost({ silentError: true });
    try {
      const options = { url: server.url, token: "tok", team: "my-team", downloadDir: DOWNLOAD_DIR };
      expect(await refusal(input, options)).toBe(
        "oc-mm-client disabled: Mattermost API 500 /api/v4/users/me: the server sent no message",
      );
    } finally {
      server.stop();
    }
  });

  it("takes credentials from the environment when no credential options are given", async () => {
    const server = startMockMattermost();
    process.env.OC_MM_URL = server.url;
    process.env.OC_MM_TOKEN = "tok";
    process.env.OC_MM_TEAM = "my-team";
    try {
      const tools = await start(input, { downloadDir: DOWNLOAD_DIR });
      expect(Object.keys(tools)).toHaveLength(15);
    } finally {
      for (const key of OC_MM_KEYS) delete process.env[key];
      server.stop();
    }
  });

  it("reads .env.local from the project directory, not the process cwd", async () => {
    const server = startMockMattermost();
    const project = await newProject();
    await Bun.write(
      join(project, ".env.local"),
      [`OC_MM_URL=${server.url}`, "OC_MM_TOKEN=tok", "OC_MM_TEAM=my-team"].join("\n"),
    );
    try {
      const tools = await start(pluginInput(project), { downloadDir: DOWNLOAD_DIR });
      expect(Object.keys(tools)).toHaveLength(15);
      // The file's credentials stay out of the environment opencode hands to spawned processes.
      for (const key of OC_MM_KEYS) expect(process.env[key]).toBeUndefined();
    } finally {
      for (const key of OC_MM_KEYS) delete process.env[key];
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("resolves a relative downloadDir against the project directory, not the process cwd", async () => {
    const server = startMockMattermost();
    // A fresh directory, not `sandbox`: `beforeAll` chdirs into that one, so resolving against the
    // cwd would produce the same string and the assertion would prove nothing.
    const project = await newProject();
    try {
      const tools = await start(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
      });
      const def = tools.mattermost_get_file;
      expect(def?.description).toContain(join(project, DOWNLOAD_DIR));
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("accepts a downloadDir whose `..` resolves back inside the project", async () => {
    const server = startMockMattermost();
    const project = await newProject();
    try {
      const tools = await start(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: "attachments/../attachments",
      });
      const def = tools.mattermost_get_file;
      expect(def?.description).toContain(join(project, DOWNLOAD_DIR));
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("accepts a downloadDir inside the worktree but outside the session directory", async () => {
    const server = startMockMattermost();
    const project = await newProject();
    try {
      // opencode started in a subdirectory: `..` leaves the session directory but not the worktree,
      // which is the root `read` permissions are resolved against.
      const tools = await start(pluginInput(join(project, "sub"), project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: "../attachments",
      });
      const def = tools.mattermost_get_file;
      expect(def?.description).toContain(join(project, DOWNLOAD_DIR));
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("registers no tools when downloadDir is not set at all", async () => {
    const project = await newProject();
    try {
      // The whole message: credentials that are fine have no business being in it.
      expect(await refuse(project, undefined)).toBe(
        "oc-mm-client disabled: set the downloadDir plugin option",
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses a downloadDir outside the project", async () => {
    const project = await newProject();
    try {
      const line = await refuse(project, "../escape");
      expect(line).toContain("downloadDir ../escape resolves to ");
      expect(line).toContain(`outside ${project}`);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses an absolute downloadDir outside the project", async () => {
    const project = await newProject();
    try {
      // Named as an escape rather than as a path that does not exist: the lexical pass runs first,
      // so the answer does not depend on what happens to be on the machine.
      const line = await refuse(project, "/etc/mm-files");
      expect(line).toContain("downloadDir /etc/mm-files resolves to /etc/mm-files,");
      expect(line).toContain(`outside ${project}`);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses the worktree root as a downloadDir", async () => {
    const project = await newProject();
    try {
      expect(await refuse(project, ".")).toContain(`downloadDir . is ${project} itself`);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses a downloadDir inside .git", async () => {
    const project = await newProject();
    // Created, so the refusal is the git directory and not the missing path.
    await mkdir(join(project, ".git/objects/mm-files"), { recursive: true });
    try {
      const line = await refuse(project, ".git/objects/mm-files");
      expect(line).toContain("downloadDir .git/objects/mm-files resolves to ");
      expect(line).toContain("inside a git directory");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses a downloadDir that is a symlink out of the worktree", async () => {
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    const outside = await mkdtemp(join(tmpdir(), "oc-mm-outside-"));
    // The lexical pass reads this as `<project>/attachments` and lets it through; only the
    // `realpath` one sees where it lands.
    await symlink(outside, join(project, DOWNLOAD_DIR));
    try {
      const line = await refuse(project, DOWNLOAD_DIR);
      expect(line).toContain(`downloadDir ${DOWNLOAD_DIR} resolves to `);
      expect(line).toContain(await realpath(outside));
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a downloadDir that does not exist, without creating it", async () => {
    const project = await newProject();
    const missing = join(project, "missing");
    try {
      expect(await refuse(project, "missing")).toContain(
        `downloadDir missing resolves to ${missing}, which does not exist`,
      );
      expect(existsSync(missing)).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses a downloadDir that is a regular file", async () => {
    const project = await newProject();
    await Bun.write(join(project, "notes.txt"), "in the way");
    try {
      expect(await refuse(project, "notes.txt")).toContain(
        `downloadDir notes.txt resolves to ${join(project, "notes.txt")}, which is not a directory`,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it.skipIf(asRoot)("refuses a downloadDir it cannot write to", async () => {
    const project = await newProject();
    await chmod(join(project, DOWNLOAD_DIR), 0o500);
    try {
      expect(await refuse(project, DOWNLOAD_DIR)).toContain("which is not writable");
    } finally {
      await chmod(join(project, DOWNLOAD_DIR), 0o700);
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses a downloadDir that is not a string and says so", async () => {
    const project = await newProject();
    try {
      expect(await refuse(project, ["attachments"])).toContain(
        'downloadDir ["attachments"] is not a string path',
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses a blank downloadDir and quotes it", async () => {
    const project = await newProject();
    try {
      expect(await refuse(project, "   ")).toContain('downloadDir "   " is blank');
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("starts with no uploadRoot at all, taking the worktree as the default", async () => {
    const server = startMockMattermost();
    const project = await newProject();
    try {
      // The one place `uploadRoot` differs from `downloadDir`: absent is the default, not a
      // mistake, so an existing config keeps working without an edit.
      const tools = await start(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
      });
      expect(Object.keys(tools)).toHaveLength(15);
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("resolves a relative uploadRoot against the project directory, not the process cwd", async () => {
    const server = startMockMattermost();
    const project = await newProject();
    // A name the sandbox the suite chdir'd into does not have: resolved against the cwd this would
    // be refused as missing, and the plugin would register nothing.
    await mkdir(join(project, "uploads"));
    try {
      const tools = await start(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
        uploadRoot: "uploads",
      });
      expect(Object.keys(tools)).toHaveLength(15);
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("accepts an uploadRoot outside the worktree, which is the documented opt-out", async () => {
    const server = startMockMattermost();
    const project = await newProject();
    try {
      // Unlike `downloadDir`: nothing is written there, and `"/"` is how a caller keeps the
      // pre-v0.4.0 behaviour of attaching any file on the machine.
      const tools = await start(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
        uploadRoot: "/",
      });
      expect(Object.keys(tools)).toHaveLength(15);
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("refuses an uploadRoot that does not exist", async () => {
    const project = await newProject();
    try {
      expect(await refuseUpload(project, "missing")).toContain(
        `uploadRoot missing resolves to ${join(project, "missing")}, which does not exist`,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses an uploadRoot that is a regular file", async () => {
    const project = await newProject();
    await Bun.write(join(project, "notes.txt"), "in the way");
    try {
      expect(await refuseUpload(project, "notes.txt")).toContain(
        `uploadRoot notes.txt resolves to ${join(project, "notes.txt")}, which is not a directory`,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses an uploadRoot that is not a string and says so", async () => {
    const project = await newProject();
    try {
      expect(await refuseUpload(project, ["uploads"])).toContain(
        'uploadRoot ["uploads"] is not a string path',
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("reports the credentials and the downloadDir in one line", async () => {
    const project = await newProject();
    try {
      // Both mistakes in one startup: reporting whichever gate ran first would cost a restart to
      // learn about the other.
      const line = await refusal(pluginInput(project), { downloadDir: "../escape" });
      expect(line).toContain("oc-mm-client disabled: set OC_MM_URL, OC_MM_TOKEN, OC_MM_TEAM");
      expect(line).toContain("; downloadDir ../escape resolves to ");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("lets the real environment win over .env.local", async () => {
    const server = startMockMattermost();
    const project = await newProject();
    await Bun.write(
      join(project, ".env.local"),
      [`OC_MM_URL=${server.url}`, "OC_MM_TOKEN=tok", "OC_MM_TEAM=from-file"].join("\n"),
    );
    process.env.OC_MM_TEAM = "my-team";
    try {
      const tools = await start(pluginInput(project), { downloadDir: DOWNLOAD_DIR });
      expect(Object.keys(tools)).toHaveLength(15);
      expect(server.paths).toContain("/api/v4/teams/name/my-team");
    } finally {
      for (const key of OC_MM_KEYS) delete process.env[key];
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("does not let an empty environment variable mask the .env.local value", async () => {
    const server = startMockMattermost();
    const project = await newProject();
    await Bun.write(
      join(project, ".env.local"),
      [`OC_MM_URL=${server.url}`, "OC_MM_TOKEN=tok", "OC_MM_TEAM=my-team"].join("\n"),
    );
    // `export OC_MM_TEAM=` is not a choice of team; a plain spread let it blank the file's value,
    // and since one missing key rejects all three, it disabled the plugin entirely.
    process.env.OC_MM_TEAM = "";
    try {
      const tools = await start(pluginInput(project), { downloadDir: DOWNLOAD_DIR });
      expect(Object.keys(tools)).toHaveLength(15);
      expect(server.paths).toContain("/api/v4/teams/name/my-team");
    } finally {
      for (const key of OC_MM_KEYS) delete process.env[key];
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });
});
