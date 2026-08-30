# oc-mm-client

[![CI](https://github.com/Chi-teck/oc-mm-client/actions/workflows/ci.yml/badge.svg)](https://github.com/Chi-teck/oc-mm-client/actions/workflows/ci.yml)

Mattermost client for [opencode](https://opencode.ai). It gives the agent tools to read and post
messages, browse channels, search and download attachments, plus a raw REST fallback for the
endpoints those do not cover.

Requirements: [Bun](https://bun.sh) 1.0+, opencode 1.18+, `git` on the machine, and a Mattermost
[personal access token](https://developers.mattermost.com/integrate/reference/personal-access-token/).

## Install

The plugin is not on npm. Point `opencode.json` at the git repository; opencode installs it on
startup.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:Chi-teck/oc-mm-client#v0.2.0"],
  "permission": {
    "mattermost_create_post": "ask",
    "mattermost_react": "ask",
    "mattermost_edit_post": "ask",
    "mattermost_dm": "ask",
    "mattermost_api": "ask"
  }
}
```

The `#v0.2.0` tag is deliberate. A bare `github:Chi-teck/oc-mm-client` tracks the default branch,
so an unrelated push changes the code under a running install. opencode caches by the literal spec
string, so bumping the tag is also what triggers a re-download — upgrading is a one-line edit, with
no cache to clear.

Do not skip the `permission` block. The write tools raise a permission request, but with no
matching rule opencode's default allow-all approves it silently. The plugin has no channel or
user allowlist of its own, so these rules are the only enforcement point.

`mattermost_api` is the one that matters most: it reaches every endpoint the token can, so without
a rule a raw `DELETE` goes through unattended. It asks only for non-GET requests; reads run
unprompted like the other read tools.

## Configuration

Credentials come from the environment:

```sh
export OC_MM_URL=https://mattermost.example.com
export OC_MM_TOKEN=your-personal-access-token
export OC_MM_TEAM=my-team
```

They can also be passed inline as plugin options, which take precedence over the environment:

```json
"plugin": [
  ["github:Chi-teck/oc-mm-client#v0.2.0", { "url": "https://mattermost.example.com", "token": "…", "team": "…" }]
]
```

`downloadDir` moves where `mattermost_get_file` saves attachments; the default is
`.opencode/mm-files/`. A relative value resolves against the opencode project directory — the same
root `.env.local` is read from — and is created on the first download. It may not escape the git
worktree, since opencode resolves the agent's `read` permission against it: a file saved outside is
one the agent cannot open. Containment is checked after symlinks are resolved, so a directory that
is itself a link pointing outside the worktree is refused as well. The worktree root itself is
refused — attachments would land among the tracked sources — and so is anything inside `.git`. A
`downloadDir` that is not a string in `opencode.json` is refused the same way rather than ignored
silently. In every one of these cases the plugin logs one line and keeps the default; none of them
is fatal. Existing downloads are not moved.

```json
"plugin": [
  ["github:Chi-teck/oc-mm-client#v0.2.0", { "downloadDir": "attachments" }]
]
```

Missing or rejected credentials are not fatal: the plugin logs the reason and registers no tools.
An unreachable host gets 10 seconds before the plugin gives up, so it cannot hang opencode's
startup.

Every request asks for English (`Accept-Language: en`). Mattermost picks the language of its error
messages from that header alone — not from the token user's locale — so on a server whose default
locale is not English the tools would otherwise report failures in that language.

The `.env.local` file is a development convenience only — it is read from the opencode project
directory (the one `--dir` points at, not the shell's working directory), so an installed plugin
will not find one inside the package. Its values are read straight into the plugin and never
exported into the process environment, so they are not inherited by the commands opencode runs.
Use real environment variables or plugin options instead.

## Tools

| Tool | Description |
| --- | --- |
| `mattermost_list_channels` | List the channels the token's user belongs to. |
| `mattermost_read_posts` | Read channel posts: latest, `since` a time, `before` a post, a full thread, or pinned only. Bodies are cut at 500 characters unless `full=true`. |
| `mattermost_get_post` | Read one post by id, with its channel, reactions and attachments. |
| `mattermost_read_unread` | Unread and mention counts per channel, or the unread posts of one channel. |
| `mattermost_search` | Search posts or files across the team. |
| `mattermost_list_members` | List channel members, optionally fuzzy-matched by username. |
| `mattermost_get_file` | Download an attachment into `.opencode/mm-files/` (or `downloadDir`) and return the saved path. |
| `mattermost_mark_read` | Clear a channel's unread state. |
| `mattermost_create_post` | Post a message, optionally as a thread reply and with file attachments. |
| `mattermost_react` | Add or remove an emoji reaction on a post. |
| `mattermost_edit_post` | Edit or delete one of the token user's own posts. |
| `mattermost_dm` | Open (or reuse) a direct-message channel with a user. |
| `mattermost_api` | Fallback: raw request to any `/api/v4` endpoint. `path`, plus optional `method`, `body` and `full`. |

`mattermost_create_post`, `mattermost_react`, `mattermost_edit_post` and `mattermost_dm` are the
write tools gated by the `permission` block above; `mattermost_api` joins them for any method other
than `GET`. `mattermost_mark_read` also changes server state but is deliberately ungated — it only
clears your own unread markers.

`mattermost_api` exists so a rare endpoint does not need a tool of its own. It takes a path relative
to `/api/v4` (`/users/me/status`), expands the `{team_id}` and `{user_id}` placeholders, and returns
the response body as it came, cut at 4000 characters unless `full=true`. Prefer the dedicated tools
where they exist — they resolve channel names and format their output for reading.

Real-time WebSocket events are not supported yet; every read goes through the REST API.

## Development

```sh
bun install
cp .env.example .env.local
```

Set `OC_MM_URL`, `OC_MM_TOKEN` and `OC_MM_TEAM` there; real environment variables take precedence over the
file. `.opencode/` is not tracked, so create `.opencode/opencode.json` yourself — it registers the
working tree as a plugin instead of the git spec, and marks the write tools as `ask`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["../src/index.ts"],
  "permission": {
    "mattermost_create_post": "ask",
    "mattermost_react": "ask",
    "mattermost_edit_post": "ask",
    "mattermost_dm": "ask",
    "mattermost_api": "ask"
  }
}
```

Restart opencode after changing anything under `.opencode/`.

```sh
bun run check   # tsc --noEmit
bun test
bun run lint    # biome check .
```

A command file under `.opencode/command/` can wrap all three into a single `/check`.

### `oc-mm` CLI

A testing aid, not a feature of the plugin: the `oc-mm` binary runs the same tool definitions
directly — no opencode session, no LLM — so a change can be exercised without restarting the TUI.
Run it as `bun src/cli.ts …` in a clone, or `bun link` it to get `oc-mm` on `PATH`.

```sh
bun src/cli.ts --help
bun src/cli.ts list_channels
bun src/cli.ts read_posts channel=my-channel since=2h
bun src/cli.ts create_post channel=my-channel message="hello" --yes
bun src/cli.ts api path=/teams/{team_id}/channels
```

The `mattermost_` prefix is optional, values are coerced against the tool's schema (`limit=5`
becomes a number), and write tools abort unless `--yes` is passed — the `permission` keys in
`opencode.json` are read by opencode only, so the CLI carries its own gate.

## License

[MIT](LICENSE)
