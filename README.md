# codex-remote

Local-first browser remote control for Codex.

`codex-remote` starts a local Codex `app-server`, keeps that app-server bound to `127.0.0.1`, and exposes a small token-protected browser UI for the same machine, iPad, or phone on the LAN.

## Current scope

- React + Vite + TypeScript browser UI
- Node/Hono bridge server
- WebSocket bridge to Codex `app-server`
- thread list, new thread, thread resume, rename, archive, compact, fork, and rollback
- prompt sending with streaming assistant output, reasoning summary, plan updates, and diff updates
- approval accept/decline/session flow with command and file-change summaries
- model selector, reasoning effort selector, and access-mode selector
- image attachments and file mentions backed by Codex `localImage` / `mention` inputs
- Skills, plugins, apps, and MCP server inventory in the left sidebar
- responsive left-sidebar layout for desktop, iPad, and mobile

## Quick start

```bash
npm install
npm run build
npm run start
```

The server prints URLs like:

```text
http://127.0.0.1:45214/?token=...
http://192.168.x.x:45214/?token=...
```

Open the LAN URL from your iPad or phone while on the same trusted network.

## Environment

```bash
CODEX_REMOTE_PORT=45214
CODEX_WORKDIR=/path/to/project
CODEX_MODEL=gpt-5.4
CODEX_APP_SERVER_PORT=45213
CODEX_APP_SERVER_URL=ws://127.0.0.1:45213
CODEX_APP_SERVER_SOCK=/path/to/app-server-control.sock
CODEX_REMOTE_TOKEN=choose-your-own-token
```

If `CODEX_APP_SERVER_URL` or `CODEX_APP_SERVER_SOCK` is set, `codex-remote` connects to that existing app-server instead of starting a new one.

## Security model

- Codex `app-server` stays local by default.
- The LAN-facing UI requires a generated token.
- The generated token is stored in `.codex-remote-token` and is ignored by git.
- Use a trusted LAN, SSH forwarding, VPN, or a mesh network for remote access.

Do not bind an unauthenticated Codex app-server directly to a public interface.

## Development

```bash
npm run lint
npm run check
```

`npm run check` runs TypeScript checks and a production Vite build.
