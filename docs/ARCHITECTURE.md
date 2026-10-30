# Architecture

```text
Telegram private messages  →  Node.js worker  →  GitHub Issues
Telegram photo/file upload →  16 MiB validation  →  files/<issue>/ commits
Telegram chat             ←  new GitHub issue comments/photos
                               ↕
                          SQLite durable state
```

The worker uses Telegram Bot API long polling (`getUpdates`) and REST calls to the one configured `GITHUB_REPO`. No public inbound port or webhook is needed.

**Access:** every update must match the configured *numeric* user ID, private chat ID and Telegram private-chat type. Bot tokens are supplied exclusively through environment variables.

**Outbound:** `/open NUMBER` stores a selected open GitHub issue. Ordinary text and supported attachments are saved locally and posted as a GitHub comment. Attachments are uploaded under `files/NUMBER/` on the configured branch. A comment marker based on Telegram update ID helps prevent duplicate publishing after uncertain network results. Avoid resending on a timeout without checking the destination first.

**Inbound:** approximately every 30 seconds, the worker polls new issues/comments and forwards them to the selected Telegram chat, with thread number/title and author. It recognizes repository-hosted `files/NUMBER/`, GitHub Markdown `user-attachments/files`, and HTML `<img src="...">` links. Private GitHub image 404s may be resolved via the signed URL in GitHub's rendered-comment API. Redirects are constrained; the GitHub PAT is not forwarded to storage CDN hosts. File transfer is limited to 16 MiB; PNG/JPEG photos of up to 10 MiB are sent using Telegram's native `sendPhoto` method.

**Storage:** SQLite holds Telegram message IDs and cursor, selected issue, one-shot mentions, and inbound issue/comment event IDs. The first incoming poll starts from its startup timestamp; it intentionally does not dump old GitHub history. Retain and back up the full data directory (database and WAL files).

**Trust boundaries:** Telegram authentication, input validation, safe file names, capped downloads, carefully scoped GitHub token, parameterized SQLite queries, root-owned source and systemd sandboxing. A personal bridge is **not** a multi-user proxy or generic attachment-fetcher.

**Known trade-offs:** GitHub API polling can hit rate limits on large repositories; a webhook architecture scales better but requires careful authentication. Repeated large file commits grow Git history. A single bot should have only one active long-polling consumer. No full transaction across Telegram, GitHub and SQLite is possible; check destination on uncertain publishing before retrying.
