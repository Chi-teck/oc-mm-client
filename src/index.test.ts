import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
const errors: string[] = [];
const realError = console.error;

beforeAll(async () => {
  cwd = process.cwd();
  sandbox = await mkdtemp(join(tmpdir(), "oc-mm-plugin-"));
  input = { directory: sandbox } as PluginInput;
  process.chdir(sandbox);
  saved = Object.fromEntries(OC_MM_KEYS.map((key) => [key, process.env[key]]));
  for (const key of OC_MM_KEYS) delete process.env[key];
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
});

afterAll(async () => {
  console.error = realError;
  for (const key of OC_MM_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.chdir(cwd);
  await rm(sandbox, { recursive: true, force: true });
});

afterEach(() => {
  errors.length = 0;
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
    expect(errors.join("\n")).toContain("oc-mm-client disabled");
  });

  it("registers no tools when the server rejects the token", async () => {
    const server = startMockMattermost({ unauthorized: true });
    try {
      expect(await plugin(input, { url: server.url, token: "bad", team: "my-team" })).toEqual({});
      expect(errors.join("\n")).toContain("oc-mm-client disabled");
    } finally {
      server.stop();
    }
  });

  it("blames the token, not the team, when the server rejects the token", async () => {
    const server = startMockMattermost({ unauthorized: true });
    try {
      await plugin(input, { url: server.url, token: "bad", team: "my-team" });
      expect(errors.join("\n")).toContain("Invalid or expired session");
      expect(errors.join("\n")).not.toContain("team not found");
    } finally {
      server.stop();
    }
  });

  it("names the status and endpoint when the server sends no error message", async () => {
    const server = startMockMattermost({ silentError: true });
    try {
      expect(await plugin(input, { url: server.url, token: "tok", team: "my-team" })).toEqual({});
      expect(errors.join("\n")).toContain(
        "oc-mm-client disabled: Mattermost API 500 /api/v4/users/me: the server sent no message",
      );
      expect(errors.join("\n")).not.toContain("disabled: \n");
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
      const hooks = await plugin({ directory: project } as PluginInput, undefined);
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
      const hooks = await plugin({ directory: project } as PluginInput, {
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
      const hooks = await plugin({ directory: project } as PluginInput, {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: "attachments/../attachments",
      });
      const def = hooks.tool?.mattermost_get_file;
      expect(def?.description).toContain(join(project, "attachments"));
      expect(errors.join("\n")).not.toContain("downloadDir");
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("refuses a downloadDir outside the project and keeps the default", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    try {
      const hooks = await plugin({ directory: project } as PluginInput, {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: "../escape",
      });
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(13);
      expect(errors.join("\n")).toContain("ignoring downloadDir ../escape");
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
      const hooks = await plugin({ directory: project } as PluginInput, {
        url: server.url,
        token: "tok",
        team: "my-team",
        downloadDir: "/etc/mm-files",
      });
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(13);
      expect(errors.join("\n")).toContain("ignoring downloadDir /etc/mm-files");
      const def = hooks.tool?.mattermost_get_file;
      expect(def?.description).toContain("<worktree>/.opencode/mm-files/");
    } finally {
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });

  it("accepts a downloadDir inside the worktree but outside the session directory", async () => {
    const server = startMockMattermost();
    const project = await mkdtemp(join(tmpdir(), "oc-mm-project-"));
    try {
      // opencode started in a subdirectory: `..` leaves the session directory but not the worktree,
      // which is the root `read` permissions are resolved against.
      const hooks = await plugin(
        { directory: join(project, "sub"), worktree: project } as PluginInput,
        {
          url: server.url,
          token: "tok",
          team: "my-team",
          downloadDir: "../attachments",
        },
      );
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
      const hooks = await plugin({ directory: project } as PluginInput, undefined);
      expect(Object.keys(hooks.tool ?? {})).toHaveLength(13);
      expect(server.paths).toContain("/api/v4/teams/name/my-team");
    } finally {
      for (const key of OC_MM_KEYS) delete process.env[key];
      await rm(project, { recursive: true, force: true });
      server.stop();
    }
  });
});
