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

```sh
mkdir -p .opencode/mm-files
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["github:Chi-teck/oc-mm-client#v0.4.0", { "downloadDir": ".opencode/mm-files" }]],
  "permission": {
    "mattermost_create_post": "ask",
    "mattermost_react": "ask",
    "mattermost_edit_post": "ask",
    "mattermost_dm": "ask",
    "mattermost_api": "ask"
  }
}
```

The `#v0.4.0` tag is deliberate. A bare `github:Chi-teck/oc-mm-client` tracks the default branch,
so an unrelated push changes the code under a running install. opencode caches by the literal spec
string, so bumping the tag is also what triggers a re-download.

Do not skip the `permission` block. The write tools raise a permission request, but with no matching
rule opencode's default allow-all approves it silently, and the plugin has no channel or user
allowlist of its own. `mattermost_api` matters most: it reaches every endpoint the token can, so
without a rule a raw `DELETE` goes through unattended. It asks only for non-GET requests; reads run
unprompted like the other read tools.

## Configuration

Credentials come from the environment:

```sh
export OC_MM_URL=https://mattermost.example.com
export OC_MM_TOKEN=your-personal-access-token
export OC_MM_TEAM=my-team
```

Every setting can also be passed inline as a plugin option, which takes precedence over the
environment:

```json
{
  "plugin": [
    [
      "github:Chi-teck/oc-mm-client#v0.4.0",
      {
        "url": "https://mattermost.example.com",
        "token": "…",
        "team": "…",
        "downloadDir": "attachments"
      }
    ]
  ]
}
```

`downloadDir` says where `mattermost_get_file` saves attachments. It is the one setting with no
default and no environment variable: the plugin does not start without it, because a client that
cannot agree with you on where files land is one you would rather find out about at startup than
after an attachment has gone somewhere unexpected. A relative value resolves against the opencode
project directory — the same root `.env.local` is read from — and it has to name a directory that:

- already exists and is writable; the plugin never creates it, so a typo cannot quietly become a
  second empty directory next to the one you meant;
- stays inside the git worktree, both as written and after symlinks are resolved, since opencode
  resolves the agent's `read` permission against it: a file saved outside is one the agent cannot
  open;
- is neither the worktree root — attachments would land among the tracked sources — nor anything
  inside `.git`.

`uploadRoot` is the other direction: every file `mattermost_create_post` attaches has to resolve
inside it. It defaults to the git worktree, so the ordinary workflow — the agent writes a file, or
downloads one with `mattermost_get_file`, then attaches it — needs no configuration, and a file
outside the project is refused with an error naming this option. Unlike `downloadDir` it is
optional, it is never written to, and it does not have to sit inside the worktree: `"/"` restores
the pre-v0.4.0 behaviour of attaching any file the process can read. A relative value resolves
against the project directory, and a relative *attachment* still resolves against the tool call's
working directory rather than against this root. Both sides of the comparison are resolved through
symlinks, so a link inside the root cannot point out of it. The `oc-mm` CLI is deliberately
unconfined — the path there was typed by you, not produced by a model.

Two things it is not. It is not an exfiltration control: an agent with `read` and `bash` can put a
secret in the `message` argument, and nothing here reads message bodies. And it cannot see
opencode's own `read` rules — a root is one boundary, a permission block is a list of globs. If you
deny paths by pattern (`*.env`, say), set `uploadRoot` narrowly enough that the patterns do not
matter; the worktree default will happily attach a denied file that lives inside the project. There
is also a gap this does not close: the path is checked and then opened, so a file swapped between
the two is not caught. Closing that needs an `fstat` on the open handle, which is not implemented —
it requires local write access to the root to exploit.

A value that is not a string, or is blank, is refused rather than ignored silently. None of this is
patched over with a fallback: every one of these mistakes disables the plugin, with one line in the
log naming the value, the path it resolved to, and what is wrong with it. Missing or rejected
credentials get the same treatment, and the two are reported together in that one line, so a config
with a mistake in each does not cost two restarts. Nothing here ever throws into opencode's own
startup: the plugin logs and registers no tools. An unreachable host gets 10 seconds before it gives
up, so it cannot hang the session either.

Every request asks for English (`Accept-Language: en`). Mattermost picks the language of its error
messages from that header alone — not from the token user's locale — so on a server whose default
locale is not English the tools would otherwise report failures in that language.

The `.env.local` file is a development convenience only — it is read from the opencode project
directory (the one `--dir` points at, not the shell's working directory), so an installed plugin
will not find one inside the package. Its values are read straight into the plugin and never
exported into the process environment, so they are not inherited by the commands opencode runs.
Use real environment variables or plugin options instead.

## Upgrading

opencode caches a plugin by the literal spec string, so nothing changes under a running install
until you edit the tag — and both minors so far ask something of an existing config.

- **v0.4.0** confines `mattermost_create_post` attachments to `uploadRoot`, which defaults to the
  git worktree. Attaching `/tmp/report.pdf`, a file in a sibling checkout, or a path reached through
  a symlink that leaves the project now fails with an error naming the option. Nothing else changes:
  every other tool, and every post without attachments, behaves as before. No config edit is
  required to stay on the happy path; `"uploadRoot": "/"` restores the old behaviour outright.
- **v0.3.0** made `downloadDir` mandatory — the plugin does not start without it — and the directory
  has to exist already, since it is never created for you.

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
| `mattermost_create_post` | Post a message, optionally as a thread reply, with file attachments, and scheduled for later (`schedule_at`). |
| `mattermost_react` | Add or remove an emoji reaction on a post. |
| `mattermost_edit_post` | Edit or delete one of the token user's own posts. |
| `mattermost_dm` | Open (or reuse) a direct-message channel with a user. |
| `mattermost_api` | Fallback: raw request to any `/api/v4` endpoint. `path`, plus optional `method`, `body` and `full`. |

`mattermost_create_post`, `mattermost_react`, `mattermost_edit_post` and `mattermost_dm` are the
write tools gated by the `permission` block above; `mattermost_api` joins them for any method other
than `GET`. `mattermost_mark_read` also changes server state but is deliberately ungated — it only
clears your own unread markers.

`schedule_at` on `mattermost_create_post` takes `"30m"`, `"2h"`, `"3d"`, an ISO 8601 datetime or
epoch milliseconds — the same grammar as `since` on the reads, added to now instead of subtracted,
and capped at a year out. A datetime carrying no offset is read as the plugin host's local time; a
bare *date* is not, since `2027-06-01` is UTC midnight by JavaScript's parsing rule, so write the
time out when the hour matters. The confirmation prompt names the resolved time and its zone, since
approving a scheduled post approves a send that happens with nobody watching. Delivery is a
server-side job, so a message arrives at or shortly after its time, not to the second. There is no tool for the rest of the lifecycle; `mattermost_api`
covers it: `GET /posts/scheduled/team/{team_id}?includeDirectChannels=true` lists them (including
the `error_code` of one that failed to send), and `DELETE /posts/schedule/<id>` cancels one.

`mattermost_api` exists so a rare endpoint does not need a tool of its own. It takes a path relative
to `/api/v4` (`/users/me/status`), expands the `{team_id}` and `{user_id}` placeholders, and returns
the response body as it came, cut at 4000 characters unless `full=true`. Prefer the dedicated tools
where they exist — they resolve channel names and format their output for reading.

Real-time WebSocket events are not supported yet; every read goes through the REST API.

## Development

```sh
bun install
cp .env.example .env.local
mkdir -p local/mm-files
```

Set `OC_MM_URL`, `OC_MM_TOKEN` and `OC_MM_TEAM` there; real environment variables take precedence
over the file. `.opencode/` is not tracked, so create `.opencode/opencode.json` yourself: the same
config as in [Install](#install), keeping the `permission` block, with the plugin entry pointing at
the working tree instead of the git spec and `downloadDir` at the untracked `local/` area.

```json
"plugin": [["../src/index.ts", { "downloadDir": "local/mm-files" }]]
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
