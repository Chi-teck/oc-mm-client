import { describe, expect, it } from "bun:test";
import { loadEnvFile, readMattermostEnv } from "./env.js";

describe("readMattermostEnv", () => {
  it("reads OC_MM_* variables", () => {
    const env = { OC_MM_URL: "https://mm.example.com", OC_MM_TOKEN: "tok", OC_MM_TEAM: "my-team" };
    expect(readMattermostEnv(env)).toEqual({
      url: "https://mm.example.com",
      token: "tok",
      team: "my-team",
    });
  });

  it("ignores bare MM_* variables", () => {
    // The collision the `OC_` prefix exists to avoid: a host project's own Mattermost keys.
    const env = { MM_URL: "https://mm.example.com", MM_TOKEN: "tok", MM_TEAM: "my-team" };
    expect(() => readMattermostEnv(env)).toThrow("Set OC_MM_URL, OC_MM_TOKEN and OC_MM_TEAM");
  });

  it("ignores MATTERMOST_* variables", () => {
    const env = {
      MATTERMOST_URL: "https://mm.example.com",
      MATTERMOST_TOKEN: "tok",
      MATTERMOST_TEAM: "my-team",
    };
    expect(() => readMattermostEnv(env)).toThrow("Set OC_MM_URL, OC_MM_TOKEN and OC_MM_TEAM");
  });

  it("throws naming all three vars when team is missing", () => {
    const env = { OC_MM_URL: "https://mm.example.com", OC_MM_TOKEN: "tok" };
    expect(() => readMattermostEnv(env)).toThrow("OC_MM_TEAM");
  });

  it("throws when missing", () => {
    expect(() => readMattermostEnv({})).toThrow("OC_MM_URL");
    expect(() => readMattermostEnv({ OC_MM_URL: "https://mm.example.com" })).toThrow();
  });
});

describe("loadEnvFile", () => {
  it("parses comments, quotes and blank lines", async () => {
    const path = "local/tmp/.env.local.test";
    await Bun.write(
      path,
      [
        "# comment",
        "OC_MM_URL=https://file.example.com",
        'OC_MM_TOKEN="file-tok"',
        "",
        "not-an-assignment",
      ].join("\n"),
    );
    try {
      expect(loadEnvFile(path)).toEqual({
        OC_MM_URL: "https://file.example.com",
        OC_MM_TOKEN: "file-tok",
      });
    } finally {
      await Bun.write(path, "");
    }
  });

  it("keeps the file's keys out of process.env", async () => {
    const path = "local/tmp/.env.local.leak";
    await Bun.write(path, "OC_MM_TOKEN=file-tok");
    const had = "OC_MM_TOKEN" in process.env;
    try {
      expect(loadEnvFile(path)).toEqual({ OC_MM_TOKEN: "file-tok" });
      // Compared against the file's value, never against the real one: a failed `toBe` prints it.
      expect(process.env.OC_MM_TOKEN).not.toBe("file-tok");
      expect("OC_MM_TOKEN" in process.env).toBe(had);
    } finally {
      await Bun.write(path, "");
    }
  });

  it("loses to the real environment for keys it already defines", async () => {
    const path = "local/tmp/.env.local.precedence";
    await Bun.write(
      path,
      ["OC_MM_URL=https://file.example.com", 'OC_MM_TOKEN="file-tok"'].join("\n"),
    );
    const shellEnv = { OC_MM_TOKEN: "shell-tok" };
    try {
      // The composition both entry points use: file first, real environment last.
      const merged: Record<string, string> = { ...loadEnvFile(path), ...shellEnv };
      expect(merged).toEqual({ OC_MM_URL: "https://file.example.com", OC_MM_TOKEN: "shell-tok" });
    } finally {
      await Bun.write(path, "");
    }
  });

  it("ignores keys outside the OC_MM_ namespace", async () => {
    const path = "local/tmp/.env.local.foreign";
    await Bun.write(
      path,
      ["AWS_SECRET_ACCESS_KEY=leak", "MM_TEAM=host-project", "OC_MM_TEAM=from-file"].join("\n"),
    );
    try {
      expect(loadEnvFile(path)).toEqual({ OC_MM_TEAM: "from-file" });
    } finally {
      await Bun.write(path, "");
    }
  });

  it("silently skips missing files", () => {
    expect(loadEnvFile("local/tmp/definitely-missing.env")).toEqual({});
  });
});
