# Pi Chat

A minimal, local-first browser interface for [Pi coding agent](https://github.com/earendil-works/pi). The browser presents Pi's messages; Pi owns models, tools, skills, extensions and session persistence.

**Tags / GitHub topics:** `pi`, `pi-coding-agent`, `web-ui`, `local-first`, `typescript`.

## Run

Requires Node.js 22+, npm, and a configured `pi` CLI available on PATH. Tested locally with Pi 0.87.1. The CLI must support RPC `agent_settled` and `get_available_thinking_levels`.

```sh
npm ci
npm run check
npm start
# http://localhost:8791
```

The working directory defaults to the directory from which the server is started. To use another project:

```sh
PI_CHAT_CWD=/absolute/path/to/project npm start
```

Optional environment variables: `PI_CHAT_PORT` (8791), `PI_CHAT_BIN` (pi). Only one server process should use this checkout's state directory at a time. Stop the foreground server with Ctrl+C.

## Current functionality

- Real RPC streaming, Markdown, fenced code, tables and KaTeX (`$$…$$`, `\[…\]`, `\(…\)`). Raw output is sanitized; remote Markdown images are disabled.
- Thinking and tool arguments/results collapsed by default.
- Send/stop, real model and supported thinking-level selection.
- New/switch/search app-owned sessions. Pi JSONL files live in ignored `state/sessions/`; no terminal or Feishu sessions are imported automatically.
- Browser reconnects from server-owned state without re-sending prompts. On server restart, the latest persisted session is resumed, not its interrupted operation.
- Discovered skill/template/extension command suggestions. TUI-only slash commands are not forwarded as if they were supported.
- Extension confirmation/select/input/editor dialogs; notify messages. Never automatically approves a dialog.

## Deliberate limits

One active Pi subprocess/workspace per server. Browser tabs share its active session. History selectors only list sessions created by this app. No attachment upload, file browser, document preview, branch navigation or steering/follow-up UI yet. No custom terminal extension widgets; RPC itself cannot reproduce TUI custom components. Extension status/widgets/title hooks aren't rendered yet. This is an early implementation, not a claim of full Pi UI compatibility.

## Security

Loopback only, strict Host/Origin checks including WebSocket upgrades, bounded WebSocket commands, an explicit action allowlist, sanitized Markdown and CSP. No arbitrary HTTP filesystem endpoint or direct shell-execution endpoint.

**This is not a sandbox.** Prompts can cause Pi to read/write files and execute tools using the OS user's permissions. Anyone with access to this local endpoint can control the agent. Do not expose it through a public tunnel or reverse proxy. Pi still loads its existing global configuration, credentials, skills and extensions normally; installing trusted extensions remains the user's responsibility.

`state/`, dependencies, logs and environment files are excluded from Git. Never commit credentials or conversation history. Markdown links may lead to external sites when clicked.

## Structure

```text
server.ts             HTTP + WebSocket + Pi JSONL bridge
public/index.html     Minimal shell
public/style.css      UI styles
public/app.js         Presentation and interaction
state/                Local sessions/registry (not committed)
```

No database, model API wrapper or duplicate tool executor. The initial browser UI remains plain JavaScript; the bridge is TypeScript. `npm run check` checks the bridge, not browser JS.

## GitHub

Repository: https://github.com/Zhangbo-cn/pi-chat

Topics are GitHub repository metadata, not Git release tags. This project uses the topics listed above; no release tag is created for unfinished code.

## Pi package status

A lightweight Pi extension exposes `/pi-chat` and `/pi-chat stop` in the terminal UI. It starts a separate local RPC server for the current working directory; it does not mirror the terminal conversation. Exiting/reloading Pi stops the owned server. It does not automatically open a browser or start on extension load.

```sh
pi install git:github.com/Zhangbo-cn/pi-chat
# Restart Pi, then run /pi-chat
# Visit http://localhost:8791
```

The extension and `pi-chat-local` executable store state under `~/.pi/pi-chat/<workspace-hash>/`, outside the package installation. Override with `PI_CHAT_STATE_DIR`. Only one server may use a state directory; use a different port and state directory for concurrent servers. The existing `npm start` workflow keeps checkout-local `state/` unless overridden. A busy port fails without taking over or stopping an existing server. Extension startup logs are in the state directory's `server.log`.

The package includes an explicit Pi manifest, a publish-file allowlist and the `pi-package` keyword. npm authentication/publication and [gallery](https://pi.dev/packages) discovery remain pending. After npm publication, installation will also be available with `pi install npm:pi-chat-local`.

## License

MIT; see [LICENSE](LICENSE).
