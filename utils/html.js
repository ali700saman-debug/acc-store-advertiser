'use strict';

/** Helpers for Telegram's restricted HTML parse mode. */

// Tags Telegram accepts in parse_mode=HTML.
const ALLOWED_TAGS = [
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'span', 'tg-spoiler', 'a', 'code', 'pre', 'blockquote',
];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escapes text that will be shown inside our own admin UI messages. */
function esc(value) {
  return escapeHtml(value);
}

/**
 * Best-effort validation of admin-authored campaign HTML so a typo does not
 * make every future send fail with "can't parse entities".
 * Returns { ok, error }.
 */
function validateTelegramHtml(text) {
  if (typeof text !== 'string') return { ok: false, error: 'Text must be a string.' };
  const stack = [];
  const tagPattern = /<\/?([a-zA-Z0-9-]+)(\s[^>]*)?>/g;
  let match;
  while ((match = tagPattern.exec(text)) !== null) {
    const raw = match[0];
    const name = match[1].toLowerCase();
    if (!ALLOWED_TAGS.includes(name)) {
      return { ok: false, error: `Unsupported HTML tag: <${name}>. Allowed: ${ALLOWED_TAGS.join(', ')}` };
    }
    if (raw.startsWith('</')) {
      const open = stack.pop();
      if (open !== name) {
        return { ok: false, error: `Mismatched closing tag </${name}>.` };
      }
    } else if (!raw.endsWith('/>')) {
      stack.push(name);
    }
  }
  if (stack.length) {
    return { ok: false, error: `Unclosed HTML tag: <${stack[stack.length - 1]}>` };
  }
  return { ok: true };
}

/** Telegram limits: 4096 for text messages, 1024 for media captions. */
function lengthLimitFor(mediaType) {
  return mediaType ? 1024 : 4096;
}

function truncate(value, max = 60) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Only http(s) and tg:// links are accepted for campaign buttons. */
function validateUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return { ok: false, error: 'URL is empty.' };
  if (!/^(https?:\/\/|tg:\/\/)/i.test(text)) {
    return { ok: false, error: 'URL must start with https://, http:// or tg://' };
  }
  if (/\s/.test(text)) return { ok: false, error: 'URL must not contain spaces.' };
  return { ok: true, url: text };
}

module.exports = {
  ALLOWED_TAGS,
  escapeHtml,
  esc,
  validateTelegramHtml,
  lengthLimitFor,
  truncate,
  validateUrl,
};
