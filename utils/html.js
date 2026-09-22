'use strict';

/** Helpers for Telegram's restricted HTML parse mode. */

// Tags Telegram accepts in parse_mode=HTML.
const { sanitizeUnicode, truncateGraphemes } = require('./text');

const ALLOWED_TAGS = [
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'span', 'tg-spoiler', 'a', 'code', 'pre', 'blockquote',
];

/**
 * Escapes HTML AND removes anything Telegram cannot encode as UTF-8.
 *
 * Message bodies carry group titles too, so a lone surrogate here would be
 * rejected just like one in a button label.
 */
function escapeHtml(value) {
  return sanitizeUnicode(value)
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

/**
 * Truncates by grapheme cluster, never by UTF-16 code unit.
 *
 * The previous implementation used slice(), which could cut an emoji in half
 * and leave a lone surrogate that the Bot API rejects.
 */
function truncate(value, max = 60) {
  return truncateGraphemes(value, max);
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
