import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { startMockMattermost } from "../test/mock-server.js";
import plugin from "./index.js";

const OC_MM_KEYS = ["OC_MM_URL", "OC_MM_TOKEN", "OC_MM_TEAM"] as const;

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
      const hooks = await plugin(input, { url: server.url, token: "tok", team: "my-team" });
      expect(Object.keys(hooks.tool ?? {})).toContain("mattermost_read_posts");
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(13);
      expect(server.paths).toContain("/api/v4/users/me");
      expect(server.paths).toContain("/api/v4/teams/name/my-team");
    } finally {
      server.stop();
    }
  });

  it("registers no tools when credentials are missing", async () => {
    expect(await plugin(input, undefined)).toEqual({});
    expect(logs.join("\n")).toContain("oc-mm-client disabled");
  });

  it("names only the credential that is actually missing", async () => {
    expect(await plugin(input, { url: "https://mm.example.com", token: "tok" })).toEqual({});
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
        plugin(failing, { url: server.url, token: "bad", team: "my-team" }),
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
      expect(await plugin(input, { url: server.url, token: "bad", team: "my-team" })).toEqual({});
      expect(logs.join("\n")).toContain("oc-mm-client disabled");
    } finally {
      server.stop();
    }
  });

  it("blames the token, not the team, when the server rejects the token", async () => {
    const server = startMockMattermost({ unauthorized: true });
    try {
      await plugin(input, { url: server.url, token: "bad", team: "my-team" });
      expect(logs.join("\n")).toContain("Invalid or expired session");
      expect(logs.join("\n")).not.toContain("team not found");
    } finally {
      server.stop();
    }
  });

  it("names the status and endpoint when the server sends no error message", async () => {
    const server = startMockMattermost({ silentError: true });
    try {
      expect(await plugin(input, { url: server.url, token: "tok", team: "my-team" })).toEqual({});
      expect(logs.join("\n")).toContain(
        "oc-mm-client disabled: Mattermost API 500 /api/v4/users/me: the server sent no message",
      );
      expect(logs.join("\n")).not.toContain("disabled: \n");
    } finally {
      server.stop();
    }
  });

  it("takes credentials from the environment when no options are given", async () => {
    const server = startMockMattermost();
    process.env.OC_MM_URL = server.url;
    process.env.OC_MM_TOKEN = "tok";
    process.env.OC_MM_TEAM = "my-team";
    try {
      const hooks = await plugin(input, undefined);
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(13);
    } finally {
      for (const key of OC_MM_KEYS) delete process.env[key];
      server.stop();
    }
  });

  it("reads .env.local from the project directory, not the process cwd", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    await Bun.write(
      join(project, ".env.local"),
      [`OC_MM_URL=${server.url}`, "OC_MM_TOKEN=tok", "OC_MM_TEAM=my-team"].join("\n"),
    );
    try {
      const hooks = await plugin(pluginInput(project), undefined);
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(13);
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
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    try {
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: "attachments",
      });
      const def = hooks.tool?.mattermost_get_file;
      expect(def?.description).toContain(join(project, "attachments"));
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("accepts a downloadDir whose `..` resolves back inside the project", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    try {
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: "attachments/../attachments",
      });
      const def = hooks.tool?.mattermost_get_file;
      expect(def?.description).toContain(join(project, "attachments"));
      expect(logs.join("\n")).not.toContain("downloadDir");
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("refuses a downloadDir outside the project and keeps the default", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    try {
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: "../escape",
      });
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(13);
      expect(logs.join("\n")).toContain("ignoring downloadDir ../escape");
      const def = hooks.tool?.mattermost_get_file;
      expect(def?.description).toContain("<worktree>/.opencode/mm-files/");
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("refuses an absolute downloadDir outside the project and keeps the default", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    try {
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: "/etc/mm-files",
      });
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(13);
      expect(logs.join("\n")).toContain("ignoring downloadDir /etc/mm-files");
      const def = hooks.tool?.mattermost_get_file;
      expect(def?.description).toContain("<worktree>/.opencode/mm-files/");
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("refuses the worktree root as a downloadDir and keeps the default", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    try {
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: ".",
      });
      expect(logs.join("\n")).toContain("ignoring downloadDir .");
      const def = hooks.tool?.mattermost_get_file;
      expect(def?.description).toContain("<worktree>/.opencode/mm-files/");
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("refuses a downloadDir inside .git and keeps the default", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    try {
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: ".git/objects/mm-files",
      });
      expect(logs.join("\n")).toContain("ignoring downloadDir .git/objects/mm-files");
      const def = hooks.tool?.mattermost_get_file;
      expect(def?.description).toContain("<worktree>/.opencode/mm-files/");
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("refuses a downloadDir that is a symlink out of the worktree", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    const outside = await mkdtemp(join(tmpdir(), "oc-mm-outside-"));
    // The lexical check reads this as `<project>/attachments` and lets it through.
    await symlink(outside, join(project, "attachments"));
    try {
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: "attachments",
      });
      expect(logs.join("\n")).toContain("ignoring downloadDir attachments");
      expect(logs.join("\n")).toContain(await realpath(outside));
      const def = hooks.tool?.mattermost_get_file;
      expect(def?.description).toContain("<worktree>/.opencode/mm-files/");
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      server.stop();
    }
  });

  it("refuses a downloadDir that is not a string and says so", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    try {
      const hooks = await plugin(pluginInput(project), {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: ["attachments"],
      });
      expect(logs.join("\n")).toContain('ignoring downloadDir ["attachments"]');
      const def = hooks.tool?.mattermost_get_file;
      expect(def?.description).toContain("<worktree>/.opencode/mm-files/");
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("warns about a bad downloadDir even when the credentials are missing", async () => {
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    try {
      // Both mistakes in one startup: the credentials gate used to return before the check ran.
      expect(await plugin(pluginInput(project), { downloadDir: "../escape" })).toEqual({});
      expect(logs.join("\n")).toContain("ignoring downloadDir ../escape");
      expect(logs.join("\n")).toContain("oc-mm-client disabled");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("accepts a downloadDir inside the worktree but outside the session directory", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
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
      expect(def?.description).toContain(join(project, "attachments"));
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("lets the real environment win over .env.local", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    await Bun.write(
      join(project, ".env.local"),
      [`OC_MM_URL=${server.url}`, "OC_MM_TOKEN=tok", "OC_MM_TEAM=from-file"].join("\n"),
    );
    process.env.OC_MM_TEAM = "my-team";
    try {
      const hooks = await plugin(pluginInput(project), undefined);
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(13);
      expect(server.paths).toContain("/api/v4/teams/name/my-team");
    } finally {
      for (const key of OC_MM_KEYS) delete process.env[key];
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("does not let an empty environment variable mask the .env.local value", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    await Bun.write(
      join(project, ".env.local"),
      [`OC_MM_URL=${server.url}`, "OC_MM_TOKEN=tok", "OC_MM_TEAM=my-team"].join("\n"),
    );
    // `export OC_MM_TEAM=` is not a choice of team; a plain spread let it blank the file's value,
    // and since one missing key rejects all three, it disabled the plugin entirely.
    process.env.OC_MM_TEAM = "";
    try {
      const hooks = await plugin(pluginInput(project), undefined);
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(13);
      expect(server.paths).toContain("/api/v4/teams/name/my-team");
    } finally {
      for (const key of OC_MM_KEYS) delete process.env[key];
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });
});
