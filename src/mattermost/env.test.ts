import { describe, expect, it } from "bun:test";
import { loadEnvFile, mergeEnv, readMattermostEnv } from "./env.js";

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

  it("names only the vars that are missing", () => {
    // Naming the two that are already set would send the user auditing settings that are fine.
    const env = { OC_MM_URL: "https://mm.example.com", OC_MM_TOKEN: "tok" };
    expect(() => readMattermostEnv(env)).toThrow("Set OC_MM_TEAM");
    expect(() => readMattermostEnv({ OC_MM_TOKEN: "tok" })).toThrow("Set OC_MM_URL and OC_MM_TEAM");
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
    try {
      // The composition both entry points use: file first, real environment last.
      expect(mergeEnv(loadEnvFile(path), { OC_MM_TOKEN: "shell-tok" })).toEqual({
        OC_MM_URL: "https://file.example.com",
        OC_MM_TOKEN: "shell-tok",
      });
    } finally {
      await Bun.write(path, "");
    }
  });

  it("strips an unquoted trailing comment but keeps a quoted #", async () => {
    const path = "local/tmp/.env.local.comment";
    await Bun.write(
      path,
      [
        "OC_MM_TOKEN=realtoken  # my token",
        'OC_MM_URL="https://file.example.com/#x" # note',
        "OC_MM_TEAM=a#b",
      ].join("\n"),
    );
    try {
      // The note used to travel with the token, and the 401 that followed read as an expired one.
      expect(loadEnvFile(path)).toEqual({
        OC_MM_TOKEN: "realtoken",
        OC_MM_URL: "https://file.example.com/#x",
        OC_MM_TEAM: "a#b",
      });
    } finally {
      await Bun.write(path, "");
    }
  });

  it("lets the last occurrence of a key win", async () => {
    const path = "local/tmp/.env.local.duplicate";
    await Bun.write(path, ["OC_MM_TEAM=stale", "OC_MM_TEAM=corrected"].join("\n"));
    try {
      expect(loadEnvFile(path)).toEqual({ OC_MM_TEAM: "corrected" });
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

describe("mergeEnv", () => {
  it("lets a real variable win over the file", () => {
    expect(mergeEnv({ OC_MM_TEAM: "from-file" }, { OC_MM_TEAM: "from-shell" })).toEqual({
      OC_MM_TEAM: "from-shell",
    });
  });

  it("keeps the file's value when the real variable is empty", () => {
    // `export OC_MM_TEAM=` is an accident, not a choice; a spread would blank the file's team and
    // the missing-key check would then reject the url and token that came with it.
    const merged = mergeEnv(
      { OC_MM_URL: "https://file.example.com", OC_MM_TOKEN: "file-tok", OC_MM_TEAM: "from-file" },
      { OC_MM_TEAM: "", OC_MM_TOKEN: "  " },
    );
    expect(readMattermostEnv(merged)).toEqual({
      url: "https://file.example.com",
      token: "file-tok",
      team: "from-file",
    });
  });
});
