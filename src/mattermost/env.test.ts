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
  it("parses comments, quotes and blank lines", async () => {
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
    try {
      expect(loadEnvFile(path)).toEqual({
        MM_URL: "https://file.example.com",
        MM_TOKEN: "file-tok",
      });
    } finally {
      await Bun.write(path, "");
    }
  });

  it("keeps the file's keys out of process.env", async () => {
    const path = "local/tmp/.env.local.leak";
    await Bun.write(path, "MM_TOKEN=file-tok");
    const had = "MM_TOKEN" in process.env;
    try {
      expect(loadEnvFile(path)).toEqual({ MM_TOKEN: "file-tok" });
      // Compared against the file's value, never against the real one: a failed `toBe` prints it.
      expect(process.env.MM_TOKEN).not.toBe("file-tok");
      expect("MM_TOKEN" in process.env).toBe(had);
    } finally {
      await Bun.write(path, "");
    }
  });

  it("loses to the real environment for keys it already defines", async () => {
    const path = "local/tmp/.env.local.precedence";
    await Bun.write(path, ["MM_URL=https://file.example.com", 'MM_TOKEN="file-tok"'].join("\n"));
    const shellEnv = { MM_TOKEN: "shell-tok" };
    try {
      // The composition both entry points use: file first, real environment last.
      const merged: Record<string, string> = { ...loadEnvFile(path), ...shellEnv };
      expect(merged).toEqual({ MM_URL: "https://file.example.com", MM_TOKEN: "shell-tok" });
    } finally {
      await Bun.write(path, "");
    }
  });

  it("ignores keys outside the MM_ namespace", async () => {
    const path = "local/tmp/.env.local.foreign";
    await Bun.write(path, ["AWS_SECRET_ACCESS_KEY=leak", "MM_TEAM=from-file"].join("\n"));
    try {
      expect(loadEnvFile(path)).toEqual({ MM_TEAM: "from-file" });
    } finally {
      await Bun.write(path, "");
    }
  });

  it("silently skips missing files", () => {
    expect(loadEnvFile("local/tmp/definitely-missing.env")).toEqual({});
  });
});
