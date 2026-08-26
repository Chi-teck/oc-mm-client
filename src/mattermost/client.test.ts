import { afterEach, describe, expect, it } from "bun:test";
import { createMattermostClient } from "./client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = ((input: string | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as unknown as typeof fetch;
}

describe("createMattermostClient", () => {
  it("configures Client4 with base url and bearer token", async () => {
    let captured: { url: string; headers: Record<string, string> } | undefined;
    mockFetch((url, init) => {
      captured = { url, headers: Object.fromEntries(new Headers(init?.headers).entries()) };
      return jsonResponse({ id: "u1", username: "mmbot" });
    });

    const client = createMattermostClient({ url: "https://mm.example.com", token: "tok" });
    const me = await client.getMe();

    expect(me.username).toBe("mmbot");
    expect(captured?.url).toBe("https://mm.example.com/api/v4/users/me");
    expect(captured?.headers.authorization?.toLowerCase()).toBe("bearer tok");
  });

  it("strips trailing slashes and stray whitespace from the url", () => {
    const base = (url: string) => createMattermostClient({ url, token: "tok" }).getBaseRoute();

    expect(base("https://mm.example.com/")).toBe("https://mm.example.com/api/v4");
    expect(base("https://mm.example.com///")).toBe("https://mm.example.com/api/v4");
    expect(base("https://mm.example.com/\n")).toBe("https://mm.example.com/api/v4");
  });

  it("asks for English so server errors do not come back in the instance's locale", async () => {
    let captured: Record<string, string> | undefined;
    mockFetch((_url, init) => {
      captured = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse({ id: "u1", username: "mmbot" });
    });

    const client = createMattermostClient({ url: "https://mm.example.com", token: "tok" });
    await client.getMe();

    expect(captured?.["accept-language"]).toBe("en");
  });

  it("posts messages with channel_id and message body", async () => {
    let captured: { url: string; method: string; body: string } | undefined;
    mockFetch((url, init) => {
      captured = { url, method: init?.method ?? "", body: String(init?.body ?? "") };
      return jsonResponse({ id: "p1", message: "hi", channel_id: "c1" });
    });

    const client = createMattermostClient({ url: "https://mm.example.com", token: "tok" });
    const post = await client.createPost({ channel_id: "c1", message: "hi" });

    expect(post.id).toBe("p1");
    expect(captured?.url).toBe("https://mm.example.com/api/v4/posts");
    expect(captured?.method.toUpperCase()).toBe("POST");
    expect(JSON.parse(captured?.body ?? "{}")).toEqual({ channel_id: "c1", message: "hi" });
  });

  it("rejects on API errors", async () => {
    mockFetch(() => new Response("unauthorized", { status: 401 }));

    const client = createMattermostClient({ url: "https://mm.example.com", token: "bad" });
    await expect(client.getMe()).rejects.toThrow();
  });
});
