import { describe, expect, it } from "bun:test";
import type { Client4 } from "@mattermost/client";
import { coerce, parseArgv, parseToolArgs, resolveTool, usage } from "./cli.js";
import { createMattermostContext } from "./mattermost/context.js";
import type { MattermostEnv } from "./mattermost/env.js";
import { createTools } from "./mattermost/tools/registry.js";

const config: MattermostEnv = { url: "https://mm.example.com", token: "tok", team: "my-team" };
const tools = createTools(createMattermostContext(config, {} as Client4));
const readPostsArgs = tools.mattermost_read_posts?.args ?? {};
const createPostArgs = tools.mattermost_create_post?.args ?? {};

describe("parseArgv", () => {
  it("splits tool name from key=value pairs", () => {
    expect(parseArgv(["read_posts", "channel=my-channel"])).toEqual({
      name: "read_posts",
      pairs: ["channel=my-channel"],
      approve: false,
    });
  });

  it("strips --yes from anywhere and flags approval", () => {
    expect(parseArgv(["--yes", "react", "emoji=tada"])).toEqual({
      name: "react",
      pairs: ["emoji=tada"],
      approve: true,
    });
  });

  it("reports no tool for empty argv", () => {
    expect(parseArgv([]).name).toBeUndefined();
  });
});

describe("resolveTool", () => {
  it("accepts the bare name", () => {
    expect(resolveTool(tools, "list_channels")).toBe(tools.mattermost_list_channels);
  });

  it("accepts the prefixed name", () => {
    expect(resolveTool(tools, "mattermost_list_channels")).toBe(tools.mattermost_list_channels);
  });

  it("returns undefined for unknown tools", () => {
    expect(resolveTool(tools, "nope")).toBeUndefined();
  });
});

describe("coerce", () => {
  it("keeps digit-only text as a string when the schema wants a string", () => {
    expect(coerce(createPostArgs.message, ["2026"])).toBe("2026");
  });

  it("converts to number when the schema wants a number", () => {
    expect(coerce(readPostsArgs.limit, ["5"])).toBe(5);
  });

  it("converts to boolean when the schema wants a boolean", () => {
    expect(coerce(readPostsArgs.pinned, ["true"])).toBe(true);
  });

  it("wraps a single value when the schema wants an array", () => {
    expect(coerce(createPostArgs.attachments, ["a.txt"])).toEqual(["a.txt"]);
  });

  it("groups repeated values into an array", () => {
    expect(coerce(createPostArgs.attachments, ["a.txt", "b.txt"])).toEqual(["a.txt", "b.txt"]);
  });

  it("falls back to raw text when nothing matches", () => {
    expect(coerce(readPostsArgs.limit, ["soon"])).toBe("soon");
  });

  it("keeps an out-of-range number a number so the error names the range", () => {
    expect(coerce(readPostsArgs.limit, ["201"])).toBe(201);
  });
});

describe("parseToolArgs", () => {
  it("parses pairs against the tool schema", () => {
    expect(parseToolArgs(["channel=my-channel", "limit=5"], readPostsArgs)).toEqual({
      channel: "my-channel",
      limit: 5,
    });
  });

  it("keeps = inside values", () => {
    expect(parseToolArgs(["message=a=b"], createPostArgs)).toEqual({ message: "a=b" });
  });

  it("rejects arguments without =", () => {
    expect(() => parseToolArgs(["channel"], readPostsArgs)).toThrow("expected key=value");
  });

  it("rejects a leading =", () => {
    expect(() => parseToolArgs(["=my-channel"], readPostsArgs)).toThrow("expected key=value");
  });
});

describe("usage", () => {
  it("marks optional args with brackets", () => {
    expect(usage(tools)).toContain("mattermost_read_posts channel [since]");
  });

  it("lists every registered tool", () => {
    const text = usage(tools);
    for (const id of Object.keys(tools)) expect(text).toContain(id);
  });
});
