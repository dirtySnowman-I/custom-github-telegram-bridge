# Security and responsible reporting

**Do not publish actual Telegram bot tokens, GitHub PATs, numeric account IDs, personal chat screenshots, private issue contents or signed GitHub asset URLs.** Use local `.env`, which is gitignored. For deployment, the installer copies credentials into root-only `/etc/custom-github-telegram-bridge/env`.

Treat the configured GitHub repository as the **data destination**. The PAT should be fine-grained, restricted to only that repository, with Issues and Contents read/write. You can use a test repository with no private history while learning.

The bridge is limited to one authorized Telegram user/private chat. Use an independent bot, not an existing shared bot token. Keep `DATA_DIR` private and back up the SQLite database with its WAL files. This sample does not implement multi-user permissions, queue workers, rate-limit backoff for all GitHub endpoints or attachment virus scanning.

GitHub comments and file commits are persisted in the destination repository history. Deleting a comment or current file does not guarantee erasure from history. Do not send secrets through the bot.

For security issues, use GitHub's private vulnerability reporting if enabled, or a private contact channel, **not** a public issue with sensitive details. No secret scanners can guarantee every secret has been caught; review changes before publication.
