import { boundedBytes } from './transport.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

export function createTelegram(token, {
  fetchImpl = fetch,
  apiOrigin = process.env.TELEGRAM_API_ORIGIN || 'https://api.telegram.org',
  localFileRoot = process.env.TELEGRAM_LOCAL_FILE_ROOT || ''
} = {}) {
  const origin = new URL(apiOrigin);
  if (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))
    throw new Error('Telegram API origin must be HTTPS or loopback HTTP');
  const local = origin.protocol === 'http:';
  const base = `${origin.origin}/bot${token}/`;
  const fileBase = `${origin.origin}/file/bot${token}/`;
  async function request(method, body) {
    // Never print request URLs; they contain the bot token.
    const res = await fetchImpl(`${base}${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(65000)
    });
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status} (${method})`);
    const result = await res.json();
    if (!result.ok) throw new Error(`Telegram API error (${method})`);
    return result.result;
  }
  return {
    async getUpdates(offset) { return request('getUpdates', { offset, timeout: 30, limit: 50, allowed_updates: ['message', 'callback_query'] }); },
    async sendMessage(chatId, text, extra = {}) { return request('sendMessage', { chat_id: chatId, text, ...extra }); },
    async sendFile(chatId, bytes, filename, { caption = '' } = {}) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16 * 1024 * 1024)
        throw new Error('File exceeds bridge limit');
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', String(caption).slice(0, 1024));
      form.append('document', new Blob([bytes]), String(filename || 'file.bin').replace(/[^a-zA-Z0-9._-]/g, '_'));
      const res = await fetchImpl(`${base}sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`Telegram HTTP ${res.status} (sendDocument)`);
      const data = await res.json();
      if (!data.ok) throw new Error('Telegram document upload rejected');
      return data.result;
    },
    async sendPhoto(chatId, bytes, filename = 'image.jpg', { caption = '' } = {}) {
      // Hosted Telegram Bot API: multipart sendPhoto supports up to 10 MB.
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 10 * 1024 * 1024)
        throw new Error('Photo exceeds Telegram photo limit');
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', String(caption).slice(0, 1024));
      form.append('photo', new Blob([bytes], { type: /\.png$/i.test(filename) ? 'image/png' : 'image/jpeg' }), String(filename).replace(/[^a-zA-Z0-9._-]/g, '_'));
      const res = await fetchImpl(`${base}sendPhoto`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(120000)
      });
      if (!res.ok) throw new Error(`Telegram HTTP ${res.status} (sendPhoto)`);
      const data = await res.json();
      if (!data.ok) throw new Error('Telegram photo upload rejected');
      return data.result;
    },
    async answerCallbackQuery(id, text) { return request('answerCallbackQuery', { callback_query_id: id, text }); },
    async setMyCommands(chatId, commands = []) {
      return request('setMyCommands', { commands, scope: { type: 'chat', chat_id: chatId } });
    },
    async fetchFile(id, max, expectedSize = null) {
      if (!local && expectedSize !== null && expectedSize > 20 * 1024 * 1024)
        throw new Error('Telegram cloud download limited to 20 MB; configure local API');
      const meta = await request('getFile', { file_id: id });
      const p = meta.file_path;
      if (typeof p !== 'string') throw new Error('Unsafe Telegram path');
      if (path.isAbsolute(p)) {
        if (!local || !localFileRoot) throw new Error('Local Telegram file root not configured');
        const allowedRoot = await fs.realpath(localFileRoot);
        const target = await fs.realpath(p);
        if (!target.startsWith(allowedRoot + path.sep))
          throw new Error('Telegram local file outside allowed root');
        const size = (await fs.stat(target)).size;
        if (size > max) throw new Error('File too large');
        return fs.readFile(target);
      }
      // Hosted Telegram Bot API can only download incoming files up to 20 MiB.
      if (!local && (meta.file_size ?? 0) > 20 * 1024 * 1024)
        throw new Error('Telegram cloud download limited to 20 MB; configure local API');
      if (!/^[a-zA-Z0-9/_ .-]+$/.test(p)
          || p.split('/').includes('..') || p.startsWith('/')) throw new Error('Unsafe Telegram path');
      const res = await fetchImpl(`${fileBase}${p}`, { signal: AbortSignal.timeout(180000) });
      return boundedBytes(res, local ? max : Math.min(max, 20 * 1024 * 1024));
    }
  };
}
