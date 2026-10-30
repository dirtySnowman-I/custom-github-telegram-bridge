# Deploy and operate

## One-time VPS installation

Use a Linux host with Git, Node.js 22.16+ and a `sudo`-enabled administrator. Do not paste secrets into the terminal command line.

1. Clone this **public code** repository and run `cp .env.example .env`.
2. Create a bot using @BotFather `/newbot`. Store its token in your local `.env`. Configure user/chat IDs and the destination `GITHUB_REPO`.
3. Create a **fine-grained PAT** with only the destination repository selected and Issues Read/Write + Contents Read/Write. Store the token in your `.env`.
4. Run `npm test`. Inspect `scripts/install-service.sh` before running `sudo bash scripts/install-service.sh`.
5. Verify `sudo systemctl is-active custom-github-telegram-bridge.service`, and check safe logs using `sudo journalctl -u custom-github-telegram-bridge.service -n 30 --no-pager`. Logs intentionally do not contain tokens.

The installer sets root-only environment permissions, dedicated service user, root-owned code, writable state directory and systemd sandbox options. It copies the Node executable from the system's available `node` into the production app's private bin directory. It does **not** run your bot against any repository without configured credentials.

## Safe updates

In the developer checkout (not `/opt`):

```bash
git pull --ff-only origin main
bash scripts/deploy.sh
```

Before touching production, the deploy script checks the Git worktree and runs the test suite. It backs up the source and package manifest, stops only this bot, updates source and restarts the service. On an error it attempts to restore the previous source. Saved data and credentials are **never overwritten by updates**.

## Smoke tests

1. `/ping` replies. `/threads` shows destination issues.
2. `/open 1` selects a disposable open GitHub issue. Send a plain message. Check the correct issue comment, with `Message from Telegram` heading.
3. Upload a small PNG and a source file. Verify the comment, links and committed `files/1/` attachments.
4. Add a comment and photo **on GitHub** and confirm the bot receives the labeled comment and a native Telegram image preview.
5. Restart the service and verify no duplicate comments arrive. Do not use production repositories for first tests.

## Rollback and diagnosis

`sudo systemctl stop custom-github-telegram-bridge.service` stops only this bot. The deploy script prints the timestamped rollback folder inside `/opt/custom-github-telegram-bridge`. If required, restore that backup's `src` directory and `package.json`, then start the service. Preserve `/var/lib/custom-github-telegram-bridge` and its SQLite DB/WAL; never delete it to fix a polling error.

If you used an exposed bot token or GitHub PAT, rotate it in the respective provider dashboard and update `/etc/custom-github-telegram-bridge/env` (root-owned), then restart the service. Do not copy credentials into GitHub Issues or bug reports.
