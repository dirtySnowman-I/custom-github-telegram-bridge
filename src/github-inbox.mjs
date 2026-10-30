// Repo-wide GitHub inbox. No webhook, no extra ports, no historical replay on first boot.
import { MAX_GITHUB_ATTACHMENT_BYTES } from './github-publisher.mjs';

import { githubConfig } from './config.mjs';
const {repo: REPO, branch: BRANCH} = githubConfig();
export const INBOX_POLL_MS = 30000;
const knownPath = (url, issue) => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'github.com' ||
      !u.pathname.startsWith('/' + REPO + '/blob/' + BRANCH + '/files/' + issue + '/'))
      return null;
    const p = decodeURIComponent(u.pathname.split('/blob/' + BRANCH + '/')[1]);
    if (!p || p.includes('..')) return null;
    return p;
  } catch { return null; }
};
function uploadedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
    if (!(/^\/user-attachments\/assets\/[0-9a-f-]{36}$/i.test(url.pathname) ||
      /^\/user-attachments\/files\/\d+\/[^/]+$/i.test(url.pathname))) return null;
    return url.href;
  } catch { return null; }
}
function isPhotoName(name) { return /\.(png|jpe?g|gif|webp)$/i.test(name); }
export function extractAttachments(body, issue) {
  const files = [], seen = new Set();
  function add(value, label, isImage = false) {
    const repoPath = knownPath(value, issue);
    const upload = repoPath ? null : uploadedUrl(value);
    if (!repoPath && !upload) return;
    const key = repoPath || upload;
    if (seen.has(key) || files.length >= 8) return;
    seen.add(key);
    const name = repoPath ? repoPath.split('/').at(-1) :
      upload.includes('/files/') ? decodeURIComponent(new URL(upload).pathname.split('/').at(-1)) :
      (isImage ? 'image.jpg' : 'attachment.bin');
    files.push({
      name: name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'attachment.bin',
      ...(repoPath ? { path: repoPath } : { url: upload }),
      kind: isImage || isPhotoName(name) ? 'photo' : 'document'
    });
  }
  const text = String(body || '');
  // GitHub's issue editor emits markdown images/files and sometimes HTML <img>.
  for (const m of text.matchAll(/(!?)\[([^\]]+)\]\((https:\/\/github\.com\/[^\s)]+)\)/g))
    add(m[3], m[2], m[1] === '!');
  for (const m of text.matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])(https:\/\/[^"']+)\1[^>]*>/gi))
    add(m[2], 'image', true);
  return files;
}
export function parseAuthor(body, fallback = 'GitHub') {
  const found = String(body || '').match(/^\*\*Message from ([^*\r\n]{1,90})\*\*/m);
  return found?.[1] || fallback;
}
function issueNumberFromUrl(value) {
  const found = String(value || '').match(/\/issues\/(\d+)$/);
  return found ? Number(found[1]) : 0;
}
function cleanBody(body) {
  return String(body || '').replace(/<!--\s*telegram-github-bridge:[\s\S]*?-->/g, '')
    .replace(/^\*\*Message from [^\r\n]*\*\*\s*/m, '')
    .replace(/<img\b[^>]*>/gi, '[Image attached]')
    .trim();
}

export function createGithubInbox({ github, api, store, chatId, clock = () => new Date() }) {
  if (!github || !api || !store || !chatId) throw new Error('Missing inbox dependency');
  async function sendLong(text) {
    const value = String(text || '');
    for (let i = 0; i < value.length; i += 3300) await api.sendMessage(chatId, value.slice(i, i + 3300));
  }
  async function deliver(event, issue, title, url, body, fallback) {
    if (store.hasInboxEvent(event)) return false;
    // Outbound Telegram messages are already acknowledged with comment URLs.
    if (String(body).includes('<!-- telegram-github-bridge:update-id=')) {
      store.markInboxEvent(event); return false;
    }
    const author = parseAuthor(body, fallback);
    const files = extractAttachments(body, issue);
    const header = `[GitHub #${issue} — ${title}]\nFrom: ${author}\n`;
    await sendLong(`${header}\n${cleanBody(body).slice(0, 11000) || '(attachment or empty message)'}\n\n${url}`);
    let uploadedImageIndex = 0;
    for (const file of files) {
      try {
        const isPrivateImage = file.kind === 'photo' && typeof file.url === 'string'
          && file.url.includes('/user-attachments/assets/');
        const context = {
          issueNumber: issue,
          ...(event.startsWith('comment:') ? { commentId: Number(event.slice(8)) } : {}),
          imageIndex: isPrivateImage ? uploadedImageIndex++ : 0
        };
        const bytes = file.url
          ? await github.getUserAttachment(file.url, context)
          : await github.getAttachment(issue, file.path);
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_GITHUB_ATTACHMENT_BYTES)
          throw new Error('Attachment outside supported size');
        const header = `GitHub #${issue}: ${file.name}`.slice(0, 1000);
        // Telegram's hosted Bot API sends actual photos up to 10 MiB; above that,
        // retain all bytes as a document up to our bridge-wide 16 MiB cap.
        const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if (file.kind === 'photo' && (png || jpeg) && bytes.length <= 10 * 1024 * 1024 && api.sendPhoto) {
          const name = png ? 'image.png' : 'image.jpg';
          try { await api.sendPhoto(chatId, bytes, name, { caption: header }); }
          catch (error) {
            // Only a definite Telegram rejection permits fallback; timeouts may
            // already have delivered the photo and must not create duplicates.
            if (!/Telegram HTTP (?:400|413) \(sendPhoto\)|photo upload rejected/.test(error.message || ''))
              throw error;
            await api.sendFile(chatId, bytes, name, { caption: header });
          }
        } else {
          await api.sendFile(chatId, bytes, file.name, { caption: header });
        }
      } catch (error) {
        // Only a bounded, stable code is shown; no token, image or signed URL is logged.
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{3,48}$/.test(error.code)
          ? error.code : 'TRANSFER_FAILED';
        console.error('GitHub attachment transfer failed:', code);
        await api.sendMessage(chatId,
          `GitHub #${issue}: ${file.name} was not transferred (${code}). Original link above.`);
      }
    }
    store.markInboxEvent(event);
    return true;
  }
  async function poll() {
    if (!store.getInboxCursor()) {
      // First activation begins from now; don't flood Telegram with old history.
      store.setInboxCursor(clock().toISOString());
      return { initialized: true, delivered: 0 };
    }
    const start = store.getInboxCursor();
    const since = new Date(Math.max(0, Date.parse(start) - 20000)).toISOString();
    const cutoff = clock().toISOString();
    const issues = await github.listIssues();
    const titles = new Map(issues.map(x => [x.number, x.title || 'Untitled']));
    let delivered = 0;
    for (const issue of [...issues].reverse()) {
      if (issue.pull_request || !issue.created_at || issue.created_at < start) continue;
      if (await deliver(`issue:${issue.number}`, issue.number, issue.title,
        issue.html_url || `https://github.com/${REPO}/issues/${issue.number}`,
        issue.body || '', 'New thread')) delivered++;
    }
    const comments = await github.listCommentsSince(since);
    for (const c of comments.sort((a,b) => (a.created_at || '').localeCompare(b.created_at || '') || a.id-b.id)) {
      const n = issueNumberFromUrl(c.issue_url);
      if (!Number.isSafeInteger(n) || n < 1 || !c.id || !c.created_at || c.created_at < start) continue;
      if (await deliver(`comment:${c.id}`, n, titles.get(n) || 'Thread',
        c.html_url || `https://github.com/${REPO}/issues/${n}`,
        c.body || '', c.user?.login || 'GitHub')) delivered++;
    }
    store.setInboxCursor(cutoff);
    return { initialized: false, delivered };
  }
  return { poll };
}
