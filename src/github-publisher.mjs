import { createHash } from 'node:crypto';
import { safeName, boundedBytes } from './transport.mjs';

export const MAX_GITHUB_ATTACHMENT_BYTES = 16 * 1024 * 1024;
import { githubConfig, mentionAliases } from './config.mjs';
const {repo: GITHUB_REPO, branch: GITHUB_BRANCH} = githubConfig();
export const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;
export const GITHUB_WEB = `https://github.com/${GITHUB_REPO}`;
const headersFor = token => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'public-github-telegram-bridge'
});
const validIssue = n => Number.isSafeInteger(n) && n > 0;

export function createGithubPublisher(token, { fetchImpl = fetch } = {}) {
  if (!token || typeof token !== 'string') throw new Error('GITHUB_TOKEN missing');
  const headers = headersFor(token);
  async function request(method, url, body, timeout = 45000) {
    const res = await fetchImpl(url, {
      method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout)
    });
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status} (${method})`);
    return res.json();
  }
  async function pages(resource, { maxPages = 20 } = {}) {
    const result = [];
    for (let p = 1; p <= maxPages; p++) {
      const sep = resource.includes('?') ? '&' : '?';
      const chunk = await request('GET', `${GITHUB_API}${resource}${sep}per_page=100&page=${p}`);
      if (!Array.isArray(chunk)) throw new Error('Unexpected GitHub list response');
      result.push(...chunk);
      if (chunk.length < 100) return result;
    }
    throw new Error('GitHub result too large for bounded inbox scan');
  }
  function attachmentPath(issue, updateId, filename) {
    return `files/${issue}/tg-${updateId}-${safeName(filename)}`;
  }
  async function getIssue(number) {
    if (!validIssue(number)) throw new Error('Invalid issue number');
    const issue = await request('GET', `${GITHUB_API}/issues/${number}`);
    if (issue?.number !== number || issue.pull_request || issue.state !== 'open')
      throw new Error('Issue is unavailable or closed');
    return { number, title: String(issue.title || 'Untitled').slice(0, 150),
      url: `${GITHUB_WEB}/issues/${number}` };
  }
  async function findExisting(issue, marker) {
    const comments = await pages(`/issues/${issue}/comments`, { maxPages: 20 });
    const found = comments.find(c => typeof c.body === 'string' && c.body.includes(marker));
    return found?.html_url || null;
  }
  async function saveAttachment(issue, updateId, attachment) {
    const { bytes, name } = attachment;
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_GITHUB_ATTACHMENT_BYTES)
      throw new Error('Attachment size outside supported range');
    const p = attachmentPath(issue, updateId, name);
    const encoded = p.split('/').map(encodeURIComponent).join('/');
    const url = `${GITHUB_API}/contents/${encoded}`;
    const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const existing = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(20000) });
    if (existing.status === 200) {
      const found = await existing.json();
      if (found.sha !== hash) throw new Error('Different attachment already at path');
    } else if (existing.status === 404) {
      await request('PUT', url, {
        message: `attachment: Telegram update ${updateId} for GitHub #${issue}`,
        content: bytes.toString('base64'), branch: GITHUB_BRANCH
      }, 180000);
    } else throw new Error(`GitHub HTTP ${existing.status} (check attachment)`);
    return `${GITHUB_WEB}/blob/${GITHUB_BRANCH}/${encoded}?raw=1`;
  }
  function mediaError(code, message) {
    const err = new Error(message);
    err.code = code; // Intentionally only a safe diagnostic code; no signed URLs or tokens.
    return err;
  }
  function approvedUserAttachment(value) {
    let u;
    try { u = new URL(value); } catch { return null; }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com' ||
      !(/^\/user-attachments\/assets\/[0-9a-f-]{36}$/i.test(u.pathname) ||
        /^\/user-attachments\/files\/\d+\/[^/]+$/i.test(u.pathname))) return null;
    return u;
  }
  function approvedDownloadHost(url) {
    if (url.protocol !== 'https:') return false;
    if (approvedUserAttachment(url.href)) return true;
    return ['objects.githubusercontent.com', 'private-user-images.githubusercontent.com',
      'user-images.githubusercontent.com'].includes(url.hostname) ||
      /^github-production-user-asset-[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(url.hostname);
  }
  async function fetchAttachmentBytes(value) {
    let current = new URL(value);
    for (let hop = 0; hop < 6; hop++) {
      if (!approvedDownloadHost(current))
        throw mediaError('UNSAFE_MEDIA_URL', 'Unsafe GitHub attachment redirect');
      const res = await fetchImpl(current.href, {
        method: 'GET', redirect: 'manual',
        // GitHub PAT is never forwarded to storage/CDN redirects.
        headers: current.hostname === 'github.com'
          ? headers : { 'User-Agent': 'public-github-telegram-bridge' },
        signal: AbortSignal.timeout(120000)
      });
      if ([301,302,303,307,308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) throw mediaError('REDIRECT_MISSING', 'GitHub attachment redirect missing');
        current = new URL(location, current);
        continue;
      }
      if (!res.ok) throw mediaError('MEDIA_HTTP_' + res.status,
        'GitHub attachment HTTP ' + res.status);
      if (/text\/html/i.test(res.headers.get('content-type') || ''))
        throw mediaError('MEDIA_NOT_BINARY', 'GitHub attachment is not a file');
      return boundedBytes(res, MAX_GITHUB_ATTACHMENT_BYTES);
    }
    throw mediaError('MEDIA_REDIRECT_LIMIT','Too many GitHub attachment redirects');
  }
  async function signedImageFromRenderedComment(stable, { commentId, issueNumber, imageIndex }) {
    if ((!Number.isSafeInteger(commentId) || commentId <= 0) &&
        (!Number.isSafeInteger(issueNumber) || issueNumber <= 0))
      throw mediaError('IMAGE_CONTEXT_MISSING','Private GitHub image requires its issue/comment ID');
    const route = Number.isSafeInteger(commentId) && commentId > 0
      ? '/issues/comments/' + commentId : '/issues/' + issueNumber;
    const response = await fetchImpl(GITHUB_API + route, {
      method:'GET',
      headers: { ...headers, Accept: 'application/vnd.github.full+json' },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw mediaError('RENDER_HTTP_' + response.status,
      'GitHub rendered comment unavailable');
    const rendered = await response.json();
    const html = String(rendered.body_html || '');
    // GitHub may substitute short-lived JWT URLs in the *rendered* HTML,
    // whereas the raw comment contains stable private /user-attachments/assets UUIDs.
    const signed = [];
    const tags = html.match(/<img\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const src = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (!src) continue;
      let candidate;
      try { candidate = new URL(src.replace(/&amp;/gi,'&')); }
      catch { continue; }
      if (candidate.protocol !== 'https:' ||
        !['private-user-images.githubusercontent.com','user-images.githubusercontent.com'].includes(candidate.hostname) ||
        !candidate.searchParams.has('jwt')) continue;
      const canonical = tag.match(/\bdata-canonical-src\s*=\s*(["'])(.*?)\1/i)?.[2];
      signed.push({ url: candidate.href, canonical: canonical?.replace(/&amp;/gi,'&') });
    }
    // Some GitHub render variants place the signed URL on the enclosing
    // anchor href rather than the img src. Accept only signed image hosts.
    if (!signed.length) {
      for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
        let candidate;
        try { candidate = new URL(m[2].replace(/&amp;/gi, '&')); }
        catch { continue; }
        if (candidate.protocol === 'https:' &&
          ['private-user-images.githubusercontent.com','user-images.githubusercontent.com'].includes(candidate.hostname) &&
          candidate.searchParams.has('jwt') &&
          !signed.some(x => x.url === candidate.href))
          signed.push({ url: candidate.href, canonical: null });
      }
    }
    // Prefer GitHub's canonical-src pairing; otherwise match in image order
    // within this single exact issue/comment (never an unrelated thread).
    const matched = signed.find(x => x.canonical === stable) ||
      (Number.isSafeInteger(imageIndex) && imageIndex >= 0 ? signed[imageIndex] : null);
    if (!matched) throw mediaError('SIGNED_IMAGE_MISSING',
      'Private GitHub image signed URL not present in rendered comment');
    return matched.url;
  }
  async function getUserAttachment(value, context = {}) {
    const original = approvedUserAttachment(value);
    if (!original) throw new Error('Unapproved GitHub attachment URL');
    try {
      return await fetchAttachmentBytes(original.href);
    } catch (error) {
      // Fine-grained PATs often get 404 for private /user-attachments/assets
      // although they can read the corresponding issue/comment through REST.
      if (error.code !== 'MEDIA_HTTP_404' ||
          !original.pathname.startsWith('/user-attachments/assets/')) throw error;
      const signed = await signedImageFromRenderedComment(original.href, context);
      return fetchAttachmentBytes(signed);
    }
  }

  return {
    getIssue,
    getUserAttachment,
    async listIssues() {
      const issues = await pages('/issues?state=all&sort=updated&direction=desc', { maxPages: 10 });
      return issues.filter(x => !x.pull_request).map(x => ({
        number: x.number, title: x.title, state: x.state, created_at: x.created_at,
        body: x.body || '', html_url: x.html_url
      }));
    },
    async listCommentsSince(iso) {
      return pages(`/issues/comments?sort=updated&direction=asc&since=${encodeURIComponent(iso)}`);
    },
    async getAttachment(issueNumber, pathValue) {
      if (!validIssue(issueNumber) || typeof pathValue !== 'string' ||
        !pathValue.startsWith(`files/${issueNumber}/`) || pathValue.includes('..'))
        throw new Error('Unsafe GitHub attachment path');
      const encoded = pathValue.split('/').map(encodeURIComponent).join('/');
      const url = `${GITHUB_API}/contents/${encoded}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
      const res = await fetchImpl(url, { method: 'GET',
        headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
        signal: AbortSignal.timeout(120000) });
      return boundedBytes(res, MAX_GITHUB_ATTACHMENT_BYTES);
    },
    async publish({ issueNumber, updateId, text = '', attachment = null, mention = null }) {
      if (!validIssue(issueNumber) || !Number.isSafeInteger(updateId) || updateId < 1)
        throw new Error('Invalid issue or Telegram update ID');
      if (typeof text !== 'string' || text.length > 10000) throw new Error('Message too long');
      if (!text.trim() && !attachment) throw new Error('Empty message');
      if (text.includes('@') || text.includes('<!--') || text.includes('-->'))
        throw new Error('Explicit slash commands required for agent mentions');
      if (mention !== null && !Object.values(mentionAliases()).includes(mention))
        throw new Error('Unknown agent tag');
      await getIssue(issueNumber);
      const marker = `<!-- telegram-github-bridge:update-id=${updateId} -->`;
      const existing = await findExisting(issueNumber, marker);
      if (existing) return { status: 'already-posted', url: existing };
      let body = text.trim();
      if (attachment) {
        const link = await saveAttachment(issueNumber, updateId, attachment);
        const label = safeName(attachment.name);
        const image = attachment.kind === 'photo' || /\.(png|jpe?g|gif|webp)$/i.test(label);
        const md = `${image ? '!' : ''}[${label}](${link})`;
        body = body ? body + '\n\n' + md : md;
      }
      if (mention) body += `\n\n@${mention}`;
      const comment = `<!-- telegram-github-bridge:source=telegram -->\n**Message from Telegram**\n\n${body}\n\n${marker}`;
      const result = await request('POST', `${GITHUB_API}/issues/${issueNumber}/comments`, { body: comment }, 60000);
      if (typeof result?.html_url !== 'string') throw new Error('GitHub comment status uncertain');
      return { status: 'posted', url: result.html_url };
    }
  };
}
