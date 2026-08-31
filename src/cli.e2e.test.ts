import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MockServer, startMockMattermost } from "../test/mock-server.js";

const root = join(import.meta.dir, "..");

let server: MockServer;
let outsideDir: string;
let outside: string;

beforeAll(async () => {
  server = startMockMattermost();
  outsideDir = await mkdtemp(join(tmpdir(), "oc-mm-cli-"));
  outside = join(outsideDir, "shot.png");
  await Bun.write(outside, "png");
});

afterAll(async () => {
  server.stop();
  await rm(outsideDir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: root,
    env: {
      ...process.env,
      OC_MM_URL: server.url,
      OC_MM_TOKEN: "tok",
      OC_MM_TEAM: "my-team",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("oc-mm exit codes", () => {
  it("prints usage to stdout and exits 0 for --help", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("usage: oc-mm <tool>");
  });

  it("prints usage to stderr and exits 1 with no tool", async () => {
    const { code, stderr } = await runCli([]);
    expect(code).toBe(1);
    expect(stderr).toContain("usage: oc-mm <tool>");
  });

  it("exits 1 on an unknown tool", async () => {
    const { code, stderr } = await runCli(["nope"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown tool: nope");
  });

  it("exits 1 on an unknown argument instead of ignoring it", async () => {
    const { code, stderr } = await runCli(["read_posts", "channel=my-channel", "limitt=5"]);
    expect(code).toBe(1);
    expect(stderr).toContain("invalid arguments for read_posts");
  });

  it("exits 1 on a write without --yes", async () => {
    const { code, stderr } = await runCli(["create_post", "channel=my-channel", "message=hi"]);
    expect(code).toBe(1);
    expect(stderr).toContain("permission required");
  });

  it("attaches a file from outside the working directory", async () => {
    // The CLI runs unconfined (`uploadRoot: "/"`), unlike the plugin: the operator typed the path.
    // Stopping at the permission gate is the assertion — it is reached only after the attachment
    // has been resolved and accepted, and the summary is where the accepted path is named.
    const { code, stderr } = await runCli([
      "create_post",
      "channel=my-channel",
      "message=hi",
      `attachments=${outside}`,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain(`permission required`);
    expect(stderr).toContain(`[files: ${outside}]`);
    expect(stderr).not.toContain("Attachment outside");
  });

  it("runs a read tool and exits 0", async () => {
    const { code, stdout } = await runCli(["list_channels"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Mattermost: 1 channels");
    expect(stdout).toContain("- my-channel — My Channel [P]");
  });
});
