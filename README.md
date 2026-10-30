# Custom GitHub ↔ Telegram Bridge

A self-hosted, two-way Telegram bot for talking to GitHub Issues from your phone. **Public template: no real credentials, accounts, conversations, personal agent handles, hostnames or private repository history.**

**Features:** choose an issue with `/open 1`; send text, images, code or video files to that issue; receive new issues/comments from the whole configured repository (with thread title, author and supported attachments); native Telegram image previews; SQLite message and inbound-event deduplication; private-chat allowlist; optional one-shot GitHub mentions; **16 MiB** file cap. The bot uses Telegram long polling, so **no open inbound port** is required.

## Requirements

- Node.js **22.16+** (uses built-in `node:sqlite`), Git and an Ubuntu/Linux host or local computer
- A Telegram bot created through the verified **@BotFather** using `/newbot`
- A GitHub repository **with Issues enabled**
- A fine-grained GitHub personal access token scoped to **only that repository**, with **Issues: Read and write** and **Contents: Read and write** (Metadata: Read is automatic). Keep it private.

## Quick start

```bash
git clone https://github.com/dirtySnowman-I/custom-github-telegram-bridge.git
cd custom-github-telegram-bridge
cp .env.example .env
# Edit .env locally; never commit or share this file
npm test
npm start
```

Load the local `.env` first (Node's `--env-file=.env` is supported in Node 22): `node --env-file=.env src/index.mjs`. The `npm start` script uses this flag. **Do not paste live bot tokens into screenshots or shell commands.**

Set these values in `.env`:

| Setting | Example | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `PUT_YOUR_BOT_TOKEN_HERE` | BotFather token; secret |
| `TELEGRAM_USER_ID` | `123456789` | Your numeric Telegram account ID |
| `TELEGRAM_CHAT_ID` | `123456789` | Numeric private chat ID (usually same as user ID) |
| `GITHUB_TOKEN` | `PUT_YOUR_GITHUB_TOKEN_HERE` | Fine-grained PAT; secret |
| `GITHUB_REPO` | `your-account/your-repository` | This is the **destination**, not the bridge's code repo |
| `GITHUB_BRANCH` | `main` | Destination repository branch for attachments |
| `DATA_DIR` | `./data` | Absolute path recommended for production |
| `MENTION_ALIASES` | `reviewer:octocat` | Optional: `/reviewer hello` adds `@octocat` to comment |

To learn your numeric ID without exposing the bot token, send the bot a private message, then run `node --env-file=.env scripts/find-chat.mjs`. Enter temporary placeholder numeric IDs in the file while discovering your real IDs; stop any other bot process first because only one long-polling client may receive updates.

## Bot commands

- `/threads` — list up to 20 recent open issues
- `/open 1` — select an open issue; subsequent ordinary messages and file captions post there until changed
- `/who`, `/close`, `/status`, `/last`, `/ping`, `/cancel` — status and control
- Optional `MENTION_ALIASES=reviewer:octocat,team:example-user`: `/reviewer Please review` posts immediately with `@octocat` appended; a bare `/reviewer` tags only your next ordinary message or attachment. Only configure real GitHub handles you **intend** to notify.

The bot sends new GitHub comments from **all issues** to your private Telegram chat with issue number, title, author and source URL. Supported GitHub attachments are delivered as documents; PNG/JPEG images use Telegram's native photo preview. For private issue-editor images, a REST rendered-comment fallback handles short-lived signed URLs. **Old GitHub history is not replayed** when the inbox starts for the first time.

## Install as a Linux systemd service

Use a dedicated service user. From your clean development checkout, run:

```bash
sudo bash scripts/install-service.sh
```

The installer checks Node, creates the service user and protected data directory, copies your local `.env` to `/etc/custom-github-telegram-bridge/env` with root-only permissions, installs source in `/opt/custom-github-telegram-bridge`, and starts only this service. Review the installer before running it. Keep your development checkout separate from the production directory.

For later source updates:

```bash
git pull --ff-only origin main
bash scripts/deploy.sh
```

The deploy script checks for a clean Git checkout and runs `npm test` **before** stopping the service, saves a timestamped backup, updates source, then verifies the service is active. See [deployment and recovery](docs/DEPLOY.md).

## Security and limitations

- The bridge accepts only the configured **numeric Telegram user ID + private chat ID**. Public groups are ignored.
- Never store secrets in Git, logs, screenshots or comments; `.env` is ignored. If a secret has ever been exposed, **rotate it**.
- Only send content you are comfortable placing in the destination GitHub repository. GitHub comment and file history can persist even when a file is removed later.
- File limit is **16 MiB** per attachment. Telegram hosted Bot API receives files up to 20 MB via `getFile`; native `sendPhoto` is more restrictive, so larger supported images are sent as documents.
- The bridge polls GitHub approximately every 30 seconds. First startup begins from current time, not old history; SQLite prevents duplicate notifications across restarts.
- GitHub API rate limits apply; many active issues/comments may need a more scalable webhook architecture. This is a **single-user starter project**, not a multi-tenant service.
- This code writes to **your configured GitHub repository**, never to the source repository. Start with a disposable test issue.
- No source code in this public release contains a live token or the private bridge's repository data or Git history.

## Architecture

```text
Telegram (private chat) ↔ Node.js worker ↔ GitHub Issues
                             ↕
                       SQLite state
```

See [architecture](docs/ARCHITECTURE.md), [deployment](docs/DEPLOY.md), and [security guidance](SECURITY.md).

Based on a real personal automation project; published as an **independent, configurable public edition**, not a mirror of its private repository.
