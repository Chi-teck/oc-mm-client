import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { startMockMattermost } from "../test/mock-server.js";
import plugin from "./index.js";

const OC_MM_KEYS = ["OC_MM_URL", "OC_MM_TOKEN", "OC_MM_TEAM"] as const;
/** The plugin refuses to start without one, so every test that expects tools passes it. */
const DOWNLOAD_DIR = "attachments";
// Root writes through the permission bits, so the writability check would pass and prove nothing.
const asRoot = process.getuid?.() === 0;

let cwd: string;
let sandbox: string;
let input: PluginInput;
let saved: Record<string, string | undefined>;
const logs: string[] = [];

type LogEndpoint = (options: { body: { level: string; message: string } }) => Promise<unknown>;

/** The plugin reports through opencode's log endpoint; this records what it would have sent. */
async function recordLog({ body }: { body: { level: string; message: string } }) {
  logs.push(`${body.level}: ${body.message}`);
  return { data: true };
}

/**
 * `worktree` defaults to `directory` because opencode always sends both — the field is non-optional
 * in `PluginInput` — and the cast below would otherwise let the suite drive a branch that cannot
 * happen in production while leaving the real one untested.
 */
function pluginInput(directory: string, worktree = directory, log: LogEndpoint = recordLog) {
  return { directory, worktree, client: { app: { log } } } as unknown as PluginInput;
}

/** A throwaway project directory with the download directory the plugin insists on already in it. */
async function newProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
  await mkdir(join(dir, DOWNLOAD_DIR));
  return dir;
}

/**
 * Starts the plugin on options it must refuse and returns what was logged. No mock server: the gate
 * returns before anything is probed, and the credentials are only there to prove that the refusal
 * was not about them.
 */
async function refuseOptions(project: string, extra: Record<string, unknown>): Promise<string> {
  const options = { url: "https://mm.example.com", token: "tok", team: "my-team", ...extra };
  expect(await plugin(pluginInput(project), options)).toEqual({});
  return logs.join("\n");
}

const refuse = (project: string, downloadDir: unknown) => refuseOptions(project, { downloadDir });

/** The `downloadDir` is a good one, so only the upload root can be what the log complains about. */
const refuseUpload = (project: string, uploadRoot: unknown) =>
  refuseOptions(project, { downloadDir: DOWNLOAD_DIR, uploadRoot });

/** The plugin's last resort when the log endpoint fails, so a test has to take stderr away first. */
async function captureStderr<T>(run: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await run(), stderr: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

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

afterEach(() => {
  logs.length = 0;
});

describe("plugin entry", () => {
  it("registers every Mattermost tool once the credentials validate", async () => {
    const server = startMockMattermost();
    try {
      const hooks = await plugin(input, {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
      });
      expect(Object.keys(hooks.tool ?? {})).toContain("mattermost_read_posts");
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(15);
      expect(server.paths).toContain("/api/v4/users/me");
      expect(server.paths).toContain("/api/v4/teams/name/my-team");
    } finally {
      server.stop();
    }
  });

  it("registers no tools when credentials are missing", async () => {
    expect(await plugin(input, { downloadDir: DOWNLOAD_DIR })).toEqual({});
    expect(logs.join("\n")).toContain("oc-mm-client disabled");
  });

  it("names only the credential that is actually missing", async () => {
    const options = { url: "https://mm.example.com", token: "tok", downloadDir: DOWNLOAD_DIR };
    expect(await plugin(input, options)).toEqual({});
    expect(logs.join("\n")).toContain("oc-mm-client disabled: set OC_MM_TEAM");
    expect(logs.join("\n")).toContain("the team plugin option");
    expect(logs.join("\n")).not.toContain("OC_MM_URL");
  });

  it("survives a log endpoint that rejects, keeping the reason on stderr", async () => {
    const server = startMockMattermost({ unauthorized: true });
    const failing = pluginInput(sandbox, sandbox, async () => {
      throw new Error("connect ECONNREFUSED");
    });
    try {
      const { value, stderr } = await captureStderr(() =>
        plugin(failing, {
          url: server.url,
          token: "bad",
          team: "my-team",
          downloadDir: DOWNLOAD_DIR,
        }),
      );
      expect(value).toEqual({});
      expect(stderr).toContain("oc-mm-client disabled");
      // The transport failure must not stand in for the diagnosis it was carrying.
      expect(stderr).toContain("Invalid or expired session");
    } finally {
      server.stop();
    }
  });

  it("falls back to stderr when the log endpoint answers with an error", async () => {
    // A 400 from `/log` comes back as a value, not a rejection: the generated client only throws
    // when asked to, so an unexamined result would leave the plugin disabled and silent.
    const refusing = pluginInput(sandbox, sandbox, async () => ({
      data: undefined,
      error: { name: "BadRequest", data: { message: "bad request" } },
    }));
    const { value, stderr } = await captureStderr(() => plugin(refusing, undefined));
    expect(value).toEqual({});
    expect(stderr).toContain("oc-mm-client disabled");
  });

  it("registers no tools when the server rejects the token", async () => {
    const server = startMockMattermost({ unauthorized: true });
    try {
      const options = { url: server.url, token: "bad", team: "my-team", downloadDir: DOWNLOAD_DIR };
      expect(await plugin(input, options)).toEqual({});
      expect(logs.join("\n")).toContain("oc-mm-client disabled");
    } finally {
      server.stop();
    }
  });

  it("blames the token, not the team, when the server rejects the token", async () => {
    const server = startMockMattermost({ unauthorized: true });
    try {
      await plugin(input, {
        url: server.url,
        token: "bad",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
      });
      expect(logs.join("\n")).toContain("Invalid or expired session");
      expect(logs.join("\n")).not.toContain("team not found");
    } finally {
      server.stop();
    }
  });

  it("names the status and endpoint when the server sends no error message", async () => {
    const server = startMockMattermost({ silentError: true });
    try {
      const options = { url: server.url, token: "tok", team: "my-team", downloadDir: DOWNLOAD_DIR };
      expect(await plugin(input, options)).toEqual({});
      expect(logs.join("\n")).toContain(
        "oc-mm-client disabled: Mattermost API 500 /api/v4/users/me: the server sent no message",
      );
      expect(logs.join("\n")).not.toContain("disabled: \n");
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
      const hooks = await plugin(input, { downloadDir: DOWNLOAD_DIR });
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(15);
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
      const hooks = await plugin(pluginInput(project), { downloadDir: DOWNLOAD_DIR });
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(15);
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
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
      });
      const def = hooks.tool?.mattermost_get_file;
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
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: "attachments/../attachments",
      });
      const def = hooks.tool?.mattermost_get_file;
      expect(def?.description).toContain(join(project, DOWNLOAD_DIR));
      expect(logs.join("\n")).not.toContain("downloadDir");
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
      const hooks = await plugin(pluginInput(join(project, "sub"), project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: "../attachments",
      });
      const def = hooks.tool?.mattermost_get_file;
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
        "error: oc-mm-client disabled: set the downloadDir plugin option",
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
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
      });
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(15);
      expect(logs.join("\n")).not.toContain("uploadRoot");
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
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
        uploadRoot: "uploads",
      });
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(15);
      expect(logs.join("\n")).not.toContain("uploadRoot");
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
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: DOWNLOAD_DIR,
        uploadRoot: "/",
      });
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(15);
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
      expect(await plugin(pluginInput(project), { downloadDir: "../escape" })).toEqual({});
      const line = logs.join("\n");
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
      const hooks = await plugin(pluginInput(project), { downloadDir: DOWNLOAD_DIR });
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(15);
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
      const hooks = await plugin(pluginInput(project), { downloadDir: DOWNLOAD_DIR });
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(15);
      expect(server.paths).toContain("/api/v4/teams/name/my-team");
    } finally {
      for (const key of OC_MM_KEYS) delete process.env[key];
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });
});
