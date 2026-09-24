# oc-mm-client

[![CI](https://github.com/Chi-teck/oc-mm-client/actions/workflows/ci.yml/badge.svg)](https://github.com/Chi-teck/oc-mm-client/actions/workflows/ci.yml)

Mattermost client for [opencode](https://opencode.ai): tools to read and post messages, browse
channels, search and download attachments, plus a raw REST fallback.

Requirements: [Bun](https://bun.sh) 1.0+, opencode 2.0.14+, `git`, and a Mattermost
[personal access token](https://developers.mattermost.com/integrate/reference/personal-access-token/).
For opencode v1, use the `1.x` branch (plugin 0.x, `v0.*` tags), which gets fixes only.

## Install

The plugin is not on npm; opencode installs it from git on startup.

```sh
mkdir -p .opencode/mm-files
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:Chi-teck/oc-mm-client#v1.0.0",
      "options": { "downloadDir": ".opencode/mm-files" }
    }
  ]
}
```

Keep the tag: a bare spec tracks the default branch, and since opencode caches by the literal spec,
bumping the tag is what triggers a re-download.

### Confirmation

opencode v2 has no permission prompt for plugin tools (`"ask"` rules do nothing for them), so the
plugin's TUI half shows an Allow/Deny dialog before every write, naming what it is about to do.
Nothing is sent before the answer. It fails closed:

- With no TUI attached (`opencode run`, a bare `opencode serve`, the web app) writes are refused.
  Reads work everywhere.
- With several TUIs, each asks; the first answer counts and the others close their dialog.
- An unanswered dialog gives up after 10 minutes, closing the last TUI refuses what it left open,
  and an interrupted tool call withdraws the dialog.

There is no channel or user allowlist, so the dialog is the only gate — `mattermost_api` matters
most, as it reaches every endpoint the token can (it asks only for non-GET requests). A `"deny"`
rule still removes a tool from the agent's toolset.

## Configuration

Credentials come from the environment:

```sh
export OC_MM_URL=https://mattermost.example.com
export OC_MM_TOKEN=your-personal-access-token
export OC_MM_TEAM=my-team
```

Plugin options take precedence over the environment:

```json
"options": {
  "url": "https://mattermost.example.com",
  "token": "…",
  "team": "…",
  "downloadDir": "attachments"
}
```

`downloadDir` (required, no default) is where `mattermost_get_file` saves attachments. A relative
value resolves against the opencode project directory. It must be an existing, writable directory
inside the git worktree (also after resolving symlinks, since opencode checks the agent's `read`
permission against the worktree), and neither the worktree root nor inside `.git`. It is never
created for you.

`uploadRoot` (optional, defaults to the git worktree) confines `mattermost_create_post`
attachments: every file must resolve inside it, symlinks included. It need not sit inside the
worktree; `"/"` allows any file the process can read. Relative attachments resolve against the
session directory. The `oc-mm` CLI is unconfined. Limits:

- It is not an exfiltration control: an agent can put a secret in the `message` itself.
- It does not see opencode's `read` rules; if you deny paths by pattern (`*.env`), set
  `uploadRoot` narrowly enough that they do not matter.
- The path is checked, then opened, so a file swapped in between is not caught.

Any invalid value, or missing or rejected credentials, stops the plugin from loading with one line
listing every problem. opencode marks the plugin as failed and keeps that line in the plugin's
status and in `~/.local/share/opencode/log/opencode.log`; the session starts without the tools. An
unreachable host is given up on after 10 seconds.

Requests send `Accept-Language: en`, so server errors come back in English whatever the server's
default locale.

`.env.local` is a development convenience: it is read from the opencode project directory (the one
`--dir` points at), never exported to the commands opencode runs, and an installed plugin will not
find one. Use environment variables or plugin options instead.

## Upgrading

Nothing changes under a running install until you edit the tag.

- **v1.0.0** moves to opencode v2 (v1 cannot load it, and v2 cannot load v0.x). The entry becomes
  `"plugins": [{ "package": …, "options": { … } }]`, and the `permission` `"ask"` rules go — writes
  are confirmed by the plugin's own [dialog](#confirmation), and refused under `opencode run`. A
  startup problem shows as a failed plugin. Tool names, arguments and options are unchanged.
- **v0.6.0** adds the ungated `mattermost_follow_thread` and `mattermost_unfollow_thread`.
- **v0.5.1** is v0.5.0 with correct release metadata; install it instead of v0.5.0.
- **v0.5.0** adds `schedule_at` to `mattermost_create_post`.
- **v0.4.0** confines attachments to `uploadRoot`; `"uploadRoot": "/"` restores the old behaviour.
- **v0.3.0** makes `downloadDir` mandatory, and the directory must already exist.

## Tools

| Tool | Description |
| --- | --- |
| `mattermost_list_channels` | List the channels the token's user belongs to. |
| `mattermost_read_posts` | Read channel posts: latest, `since` a time, `before` a post, a full thread, or pinned only. Bodies are cut at 500 characters unless `full=true`. |
| `mattermost_get_post` | Read one post by id, with its channel, reactions and attachments. |
| `mattermost_read_unread` | Unread and mention counts per channel, or the unread posts of one channel. |
| `mattermost_search` | Search posts or files across the team. |
| `mattermost_list_members` | List channel members, optionally fuzzy-matched by username. |
| `mattermost_get_file` | Download an attachment into `downloadDir` and return the saved path. |
| `mattermost_mark_read` | Clear a channel's unread state. |
| `mattermost_follow_thread` | Follow a thread, so its replies keep reaching the bot. |
| `mattermost_unfollow_thread` | Stop following a thread. |
| `mattermost_create_post` | Post a message, optionally as a thread reply, with file attachments, and scheduled for later (`schedule_at`). |
| `mattermost_react` | Add or remove an emoji reaction on a post. |
| `mattermost_edit_post` | Edit or delete one of the token user's own posts. |
| `mattermost_dm` | Open (or reuse) a direct-message channel with a user. |
| `mattermost_api` | Fallback: raw request to any `/api/v4` endpoint. `path`, plus optional `method`, `body` and `full`. |

`mattermost_create_post`, `mattermost_react`, `mattermost_edit_post`, `mattermost_dm` and non-GET
`mattermost_api` calls need [confirmation](#confirmation). `mattermost_mark_read` and the thread
follow tools are ungated: they touch only your own unread markers and subscriptions.

Posting into a thread follows it again, so unfollow last. To check follow state, call
`mattermost_api` with `GET /users/me/teams/{team_id}/threads/<root_id>`: 200 while followed, 404
otherwise (also for a root with no replies yet).

`schedule_at` takes `"30m"`, `"2h"`, `"3d"`, an ISO 8601 datetime or epoch ms, up to a year out. A
datetime without an offset is the host's local time, but a bare date (`2027-06-01`) is UTC
midnight. The confirmation names the resolved time and zone; delivery is a server-side job, so it
may run slightly late. Manage scheduled posts via `mattermost_api`:
`GET /posts/scheduled/team/{team_id}?includeDirectChannels=true` lists them,
`DELETE /posts/schedule/<id>` cancels one.

`mattermost_api` takes a path under `/api/v4`, expands `{team_id}` and `{user_id}`, and returns
the body cut at 4000 characters unless `full=true`. Prefer the dedicated tools where they exist.

Real-time WebSocket events are not supported; every read goes through the REST API.

## Development

```sh
bun install
cp .env.example .env.local   # set OC_MM_URL, OC_MM_TOKEN, OC_MM_TEAM
mkdir -p local/mm-files
```

Real environment variables override `.env.local`. `.opencode/` is not tracked; create
`.opencode/opencode.json` pointing at the `src` directory (v2 drops a path that is not a
directory):

```json
"plugins": [{ "package": "../src", "options": { "downloadDir": "local/mm-files" } }]
```

Sources hot-reload. After editing `.opencode/opencode.json`, run `opencode reload`;
`opencode plugin list` shows what loaded.

```sh
bun run check   # tsc --noEmit
bun test
bun run lint    # biome check .
```

### `oc-mm` CLI

A testing aid: runs the same tools without opencode or an LLM. Use `bun src/cli.ts …` in a clone,
or `bun link` for `oc-mm` on `PATH`.

```sh
bun src/cli.ts --help
bun src/cli.ts read_posts channel=my-channel since=2h
bun src/cli.ts create_post channel=my-channel message="hello" --yes
bun src/cli.ts api path=/teams/{team_id}/channels
```

The `mattermost_` prefix is optional, values are coerced to the tool's schema (`limit=5` becomes a
number), and writes abort without `--yes`.

## License

[MIT](LICENSE)
