import { describe, expect, it } from "bun:test";
import { loadEnvFile, readMattermostEnv } from "./env.js";

describe("readMattermostEnv", () => {
  it("reads MM_* variables", () => {
    const env = { MM_URL: "https://mm.example.com", MM_TOKEN: "tok", MM_TEAM: "my-team" };
    expect(readMattermostEnv(env)).toEqual({
      url: "https://mm.example.com",
      token: "tok",
      team: "my-team",
    });
  });

  it("ignores MATTERMOST_* variables", () => {
    const env = {
      MATTERMOST_URL: "https://mm.example.com",
      MATTERMOST_TOKEN: "tok",
      MATTERMOST_TEAM: "my-team",
    };
    expect(() => readMattermostEnv(env)).toThrow("Set MM_URL, MM_TOKEN and MM_TEAM");
  });

  it("throws naming all three vars when team is missing", () => {
    const env = { MM_URL: "https://mm.example.com", MM_TOKEN: "tok" };
    expect(() => readMattermostEnv(env)).toThrow("MM_TEAM");
  });

  it("throws when missing", () => {
    expect(() => readMattermostEnv({})).toThrow("MM_URL");
    expect(() => readMattermostEnv({ MM_URL: "https://mm.example.com" })).toThrow();
  });
});

describe("loadEnvFile", () => {
  it("loads keys without overwriting existing env", async () => {
    const path = "local/tmp/.env.local.test";
    await Bun.write(
      path,
      [
        "# comment",
        "MM_URL=https://file.example.com",
        'MM_TOKEN="file-tok"',
        "",
        "not-an-assignment",
      ].join("\n"),
    );
    const prev = process.env.MM_TOKEN;
    process.env.MM_TOKEN = "shell-tok";
    try {
      loadEnvFile(path);
      expect(process.env.MM_URL).toBe("https://file.example.com");
      expect(process.env.MM_TOKEN).toBe("shell-tok");
    } finally {
      delete process.env.MM_URL;
      if (prev === undefined) delete process.env.MM_TOKEN;
      else process.env.MM_TOKEN = prev;
      await Bun.write(path, "");
    }
  });

  it("ignores keys outside the MM_ namespace", async () => {
    const path = "local/tmp/.env.local.foreign";
    await Bun.write(path, ["AWS_SECRET_ACCESS_KEY=leak", "MM_TEAM=from-file"].join("\n"));
    const env = process.env as Record<string, string | undefined>;
    const prev = env.MM_TEAM;
    delete env.MM_TEAM;
    try {
      loadEnvFile(path);
      const after = { ...env };
      expect(after.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(after.MM_TEAM).toBe("from-file");
    } finally {
      if (prev === undefined) delete env.MM_TEAM;
      else env.MM_TEAM = prev;
      await Bun.write(path, "");
    }
  });

  it("silently skips missing files", () => {
    loadEnvFile("local/tmp/definitely-missing.env");
  });
});
