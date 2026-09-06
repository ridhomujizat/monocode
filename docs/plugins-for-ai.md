# Writing, installing and removing a MonoCode plugin

Audience: an AI agent (or anyone) asked to add a workspace to MonoCode's
project rail. A plugin adds a menu entry under **Notes**; clicking it opens a
full-screen workspace, and clicking a row in that workspace hands the item to
the chat composer as a note-shaped chip.

There are two kinds. **This document covers the manifest kind** — a single
JSON file, no rebuild, no code:

| Kind         | Format                            | Needs a rebuild? |
| ------------ | --------------------------------- | ---------------- |
| **manifest** | `plugin.json` in the app data dir | no               |
| built-in     | `src/plugins/<id>/index.tsx`      | yes              |

A manifest plugin comes in two flavours, and one manifest may use both:

| Flavour     | Declares                      | Can do                                                        |
| ----------- | ----------------------------- | ------------------------------------------------------------- |
| **fetch**   | `request`                     | one HTTP call → a list (or one response) → rows into chat      |
| **process** | `startup` / `actions` / `card` | run argv commands in any language, push rows into a rail card |

Sections 1-2 cover fetch, section 3 covers process. If you need something
neither can express — a Postman-style request builder, a diff viewer, a
multi-step form — write a built-in instead (see `docs/plugins.md`).

## 1. Where the file goes

```
<appData>/plugins/<id>/plugin.json    the manifest you write
<appData>/plugins/<id>/config.json    written by the app, mode 0600, holds tokens
```

`<appData>` for `com.monocode.desktop`:

| OS      | Path                                                 |
| ------- | ---------------------------------------------------- |
| macOS   | `~/Library/Application Support/com.monocode.desktop` |
| Linux   | `~/.local/share/com.monocode.desktop`                |
| Windows | `%APPDATA%\com.monocode.desktop`                     |

The folder name **must equal** the manifest's `id`, otherwise the row shows up
as broken in Settings › Plugins.

## 2. The schema

Only `id`, `label` and `request.url` are required.

```jsonc
{
  "id": "jira", // required: 1-40 chars, a-z 0-9 - only. Same as the folder.
  "label": "Jira", // required: rail entry text
  "icon": "Inbox", // export name from src/chrome/icons.tsx, default Wrench
  "description": "Issues assigned to me.", // shown above the connect form

  // Values the user types once, in the workspace. Available to every {{template}}.
  "fields": [
    {
      "key": "baseUrl",
      "label": "Base URL",
      "placeholder": "https://acme.atlassian.net",
    },
    { "key": "email", "label": "Email" },
    { "key": "token", "label": "API token", "secret": true }, // secret: masked input
  ],

  // Optional shorthand for the Authorization header.
  // { "kind": "bearer", "token": "{{token}}" }
  // { "kind": "basic", "user": "{{email}}", "password": "{{token}}" }
  "auth": { "kind": "basic", "user": "{{email}}", "password": "{{token}}" },

  "request": {
    "method": "GET", // GET POST PUT PATCH DELETE HEAD, default GET
    "url": "{{baseUrl}}/rest/api/3/search?jql=assignee%3DcurrentUser()&maxResults=50",
    "headers": { "Accept": "application/json" },
    "body": "", // string, templated; omit for GET
  },

  "items": "issues", // dotted path to the array. Omit for a single-response view.
  "item": {
    "title": "{{key}} · {{fields.summary}}", // required when "items" is set
    "subtitle": "{{fields.status.name}}",
    "body": "{{key}} {{fields.summary}}\n\n{{fields.description}}", // default: the item as pretty JSON
  },
}
```

Icon names that exist today: `AlertCircle AppWindow Archive Bot AiIdea Check
Copy ExternalLink File Folder Gauge GitBranch GitPullRequest Inbox Keyboard
ListFilter Lock MessageSquare Palette Play Search Settings Sparkles Star
StickyNote Terminal Wrench Zap` — any export of `src/chrome/icons.tsx` works,
and an unknown name silently falls back to `Wrench`.

### Templates

`{{dotted.path}}` substitution, nothing else — no conditionals, no loops, no
function calls.

- In `request.*` and `auth.*` the scope is the **config** (the `fields` keys).
- In `item.*` the scope is **one element** of the `items` array.
- Array indexes work: `{{fields.labels.0}}`.
- `{{.}}` (or `{{$}}`) is the item itself — use it when `items` is a list of
  plain strings, e.g. a list of file paths.
- A missing path renders as an empty string. An object renders as JSON.
- **No escaping is applied.** If a value goes into a query string, percent-encode
  the literal parts yourself (`jql%3D…`) and keep values that contain `/` or `&`
  out of the query.

### Response handling

- `items` set → list view. Each row is a button: click sends
  `item.title` + `item.body` to chat.
- `items` omitted → single view: the raw response, pretty-printed if JSON, with
  one **Add to chat** button.
- `items` pointing at something that is not an array → empty list, no error.
- HTTP status ≥ 400 → the status is shown as an error; the body is still kept.

### Limits and rules the host enforces

- `http://` and `https://` only. Anything else is rejected before the request.
- 30 s timeout, response truncated at 8 MB, manifest capped at 256 KB.
- Requests are made by the Rust side, not the webview — no CORS, and the
  webview CSP is not involved.
- Values in `config.json` (tokens included) are sent wherever `request.url`
  points. Only install manifests you have read.

## 3. Process plugins: commands and a rail card

A manifest can declare **argv commands** instead of, or alongside, `request`.
The host spawns them in the plugin folder — any language, no SDK — and reads one
JSON object per stdout line as a UI push. This is the flavour for anything a
single HTTP fetch cannot do: read local files, run `git`, drive a media player,
watch a socket.

```jsonc
{
  "id": "media",
  "label": "Media",
  "icon": "Play",

  // A card this plugin owns on the project rail. Rows arrive by push.
  "card": { "title": "NOW PLAYING" },

  // Run when the plugin loads, and again after an app restart. Usually a
  // long-lived watcher; nothing about the card is persisted, so this is also
  // the repaint. Make it idempotent (a pidfile) — it can fire more than once.
  "startup": [{ "command": ["/usr/bin/perl", "media.pl", "start"] }],

  // Everything a row may point at. Ids must be declared here.
  "actions": [
    {
      "id": "playpause",
      "title": "Play / pause",
      "command": ["/usr/bin/perl", "media.pl", "playpause"],
    },
    {
      "id": "seek",
      "title": "Seek",
      "command": ["/usr/bin/perl", "media.pl", "seek"],
    },
  ],
}
```

### The push protocol

One JSON object per line on **stdout**:

```json
{"method":"card","params":{"rows":[
  {"text":"▶ Song — Artist","action":"playpause"},
  {"text":"  ⏭ next","action":"seek","value":"+10"},
  {"text":"buffering","dot":"working"}
]}}
```

| Row key  | Meaning                                                             |
| -------- | ------------------------------------------------------------------- |
| `text`   | required, the label                                                 |
| `dot`    | `working` \| `blocked` \| `done` \| `idle` — a coloured dot          |
| `action` | a **declared** action id; makes the row a button                    |
| `value`  | opaque payload handed to that action as `MONOCODE_ROW_VALUE`        |

Each push replaces the whole card, so a repaint is one line. Unknown row keys
are dropped. `value` is what turns a list into *buttons* without one action id
per row: a single `seek` action serves `+10` and `-10` rows.

What the host refuses, with the reason in the plugin log:

- a row naming an action the manifest never declared — the whole push is dropped
- `params.rows` missing, a row without `text`, an unknown `dot`
- rows pushed by a plugin with no `card` in its manifest
- more than 200 rows per push; each line is truncated at 8 KiB

Anything on stdout that is not a JSON object, plus everything on **stderr**,
goes to the log (Settings › Plugins → the plugin's row). That is the debugging
channel — there is no other.

### The environment

Everything arrives as environment variables, so a shell script never parses
JSON:

| Variable                    | Value                                                    |
| --------------------------- | -------------------------------------------------------- |
| `MONOCODE_ENV`              | always `1` — use it to detect being run by the host      |
| `MONOCODE_PLUGIN_ID`        | the plugin id                                            |
| `MONOCODE_PLUGIN_ROOT`      | the plugin folder, and the working directory of every command |
| `MONOCODE_PLUGIN_STATE_DIR` | `<root>/state`, created for you — pidfiles, caches       |
| `MONOCODE_PLUGIN_CONFIG`    | path of `config.json`                                    |
| `MONOCODE_PROJECT_CWD`      | the project open in the app right now                    |
| `MONOCODE_SETTING_<KEY>`    | one per key in `config.json`, key upper-cased            |
| `MONOCODE_ROW_VALUE`        | the clicked row's `value`, on action invocations only    |

Only variables named `MONOCODE_*` are passed through; the rest of the app's
environment is not forwarded. Settings are read **at spawn time**, so a
long-lived watcher should re-read `MONOCODE_PLUGIN_CONFIG` if it wants changes
to apply without a restart.

### Lifecycle

- `startup` runs when the plugin is loaded or toggled back on.
- Toggling off, uninstalling, or quitting the app kills every process the plugin
  started (the whole process tree, `SIGTERM` then `SIGKILL`).
- Nothing restarts a watcher that exits on its own. If it dies, its rows just
  stop updating — a non-zero exit code lands in the log.
- Actions are fire-and-forget: the host does not wait for them, and their output
  is read the same way as a watcher's.

### Shipping the script

`plugin_install` (the paste box) writes **only `plugin.json`**. A process plugin
needs its script on disk next to the manifest, so with filesystem access write
both:

```bash
DIR="$HOME/Library/Application Support/com.monocode.desktop/plugins/media"
mkdir -p "$DIR"
cat > "$DIR/plugin.json" <<'JSON'
{ "id": "media", "label": "Media", "card": { "title": "NOW PLAYING" },
  "startup": [{ "command": ["sh", "watch.sh"] }],
  "actions": [{ "id": "playpause", "title": "Play / pause", "command": ["sh", "toggle.sh"] }] }
JSON
cat > "$DIR/watch.sh" <<'SH'
#!/bin/sh
# One JSON object per line is the whole API.
while :; do
  printf '{"method":"card","params":{"rows":[{"text":"%s","action":"playpause"}]}}\n' "$(date '+%H:%M:%S')"
  sleep 1
done
SH
```

Then Settings › Plugins › Refresh. Without filesystem access, paste the
manifest and tell the user exactly which files to save where.

### Worked example: macOS Now Playing

The reason this flavour exists. On macOS 15.4+ the Now Playing read APIs sit
behind a private entitlement, so the working approach is the vendored
`ungive/mediaremote-adapter` trampoline running inside Apple's own signed
`/usr/bin/perl` — which is exactly the kind of "hardcode *that* interpreter"
dependency a JSON fetch cannot express. The watcher subscribes to MediaRemote
push notifications, extrapolates the elapsed counter locally between events,
skips the push when the rendered bytes are unchanged, and holds an empty payload
for ~1.5s so a track change does not flash "nothing playing". Controls
(play/pause, next, seek ±10s) are `actions`; the rows point at them.

## 4. Installing

Pick whichever fits the situation:

**A. Write the file (best for an agent with filesystem access)**

```bash
mkdir -p ~/Library/Application\ Support/com.monocode.desktop/plugins/jira
cat > ~/Library/Application\ Support/com.monocode.desktop/plugins/jira/plugin.json <<'JSON'
{ "id": "jira", "label": "Jira", "request": { "url": "https://api.example.com/issues" } }
JSON
```

Then in the app: **Settings › Plugins › Refresh**. The entry appears under
Notes. No restart.

**B. Paste it in the UI**

Settings › Plugins › _Install_: paste the JSON, press **Install**. The app
validates it, writes the folder for you, and reports the exact key to fix if
the shape is wrong (e.g. `"item.title" is required when "items" is set`).

**Filling in credentials.** Open the plugin from the rail. If any `fields` are
empty it opens the connect form; fill it and press **Save**. Values land in
`config.json` (mode 0600). Reopen later via **Connection** in the workspace
toolbar.

## 5. Turning off and uninstalling

- **Off, keep it:** Settings › Plugins → toggle. The rail entry disappears; the
  manifest and token stay. The toggle is per machine (localStorage
  `monocode.plugins.disabled`), not part of the manifest.
- **Uninstall:** Settings › Plugins → **Uninstall** → confirm. This deletes the
  whole `<appData>/plugins/<id>/` folder, manifest **and** stored token. It
  cannot be undone from the UI.
- **By hand:** `rm -rf "<appData>/plugins/<id>"`, then Refresh.
- Built-in plugins can be toggled off but never uninstalled — they ship with
  the app.
- Either one kills a process plugin's watcher and every child it spawned. A
  detached process the plugin started outside the host's knowledge is the
  plugin's own problem to reap.

## 6. Checklist before handing a manifest to a user

1. `id` is lowercase, matches the folder name.
2. `request.url` starts with `http://`, `https://`, or a `{{field}}` that will.
3. Every `{{name}}` in `request`/`auth` exists as a `fields[].key`.
4. `items` is the real path in the API response (check a sample payload).
5. `item.title` is present and renders something for a typical item.
6. Credentials come from `fields` with `"secret": true` — never hardcode a
   token in the manifest.

For a process plugin, also:

7. Every `action` a row points at is declared in `actions`.
8. `card` is present if anything pushes rows, and `startup` exists to push them.
9. The `startup` command is idempotent — it may be started more than once.
10. The script is on disk next to `plugin.json`, and its first argv element is
    an interpreter or binary that exists on the target machine.
11. Rows say what they do: a row with no `action` is a label, not a dead button.
