'use strict';

/**
 * Unicode-safe text handling for anything that reaches the Telegram Bot API.
 *
 * Why this exists: Telegram group titles are arbitrary user content. Slicing
 * one with `String.prototype.slice` cuts by UTF-16 code units, which can land
 * in the middle of a surrogate pair and leave a lone surrogate. A lone
 * surrogate cannot be encoded as UTF-8, so the Bot API rejects the request:
 *
 *   400 Bad Request: inline keyboard button text must be encoded in UTF-8
 *
 * One bad label rejects the ENTIRE keyboard, so a single group with an emoji
 * at the wrong offset took out the whole Import My Groups panel.
 *
 * Everything here is display-only. Stored titles are never modified.
 */

const DEFAULT_FALLBACK = 'Unnamed group';

// C0/C1 control characters. Telegram rejects these and they corrupt layout.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// Whitespace that should collapse into a single space inside a label.
const LINE_BREAKS = new RegExp('[\\r\\n\\t\\u000B\\u000C\\u2028\\u2029]+', 'g');  // built from escapes: U+2028/29 are JS line terminators in source

/**
 * Invisible characters that can garble or spoof a label.
 *
 * Deliberately NOT stripped:
 *   U+200C ZWNJ and U+200D ZWJ  — meaningful in Arabic/Kurdish/Persian text
 *                                 and required for emoji sequences (👨‍👩‍👧)
 *   U+200E LRM  and U+200F RLM  — ordinary bidi marks in Arabic/Kurdish
 */
const INVISIBLE_CHARS = new RegExp('[\\u200B\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]', 'g');

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_LOW_SURROGATE = /(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g;

/** True when the string can be encoded as UTF-8 without loss. */
function isValidUtf8(value) {
  const text = String(value ?? '');
  return Buffer.from(text, 'utf8').toString('utf8') === text;
}

/**
 * Removes anything that cannot survive a UTF-8 round trip, plus control and
 * spoofing characters. Does not truncate.
 */
function sanitizeUnicode(value) {
  let text = String(value ?? '');
  if (!text) return '';

  // Drop unpaired surrogates first; everything else assumes valid pairs.
  text = text.replace(LONE_HIGH_SURROGATE, '');
  text = text.replace(LONE_LOW_SURROGATE, '$1');

  text = text.replace(LINE_BREAKS, ' ');
  text = text.replace(CONTROL_CHARS, '');
  text = text.replace(INVISIBLE_CHARS, '');

  // NFC keeps combining marks attached to their base character, so a later
  // truncation cannot orphan them.
  try {
    text = text.normalize('NFC');
  } catch (_) {
    // Malformed input: keep the stripped version rather than failing.
  }

  // Final guarantee. If anything still cannot round-trip through UTF-8,
  // let Node replace it (U+FFFD) and drop those markers.
  if (!isValidUtf8(text)) {
    text = Buffer.from(text, 'utf8').toString('utf8').replace(/�/g, '');
  }
  return text;
}

/**
 * Splits text into user-perceived characters (grapheme clusters) so a cut
 * never splits an emoji, a flag, a skin-tone sequence or a combining mark.
 * Falls back to code points where Intl.Segmenter is unavailable.
 */
function toGraphemes(text) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(segmenter.segment(text), (s) => s.segment);
    } catch (_) {
      // Fall through to code points.
    }
  }
  // Array.from splits by code point, never by UTF-16 code unit.
  return Array.from(text);
}

/** Counts user-perceived characters. */
function graphemeLength(value) {
  return toGraphemes(String(value ?? '')).length;
}

/**
 * Truncates by grapheme cluster, appending an ellipsis. Never produces a
 * lone surrogate, because it never cuts inside a cluster.
 */
function truncateGraphemes(value, max = 60, ellipsis = '…') {
  const text = String(value ?? '');
  if (max <= 0) return '';
  const graphemes = toGraphemes(text);
  if (graphemes.length <= max) return text;
  const keep = Math.max(0, max - ellipsis.length);
  return `${graphemes.slice(0, keep).join('').trimEnd()}${ellipsis}`;
}

/**
 * Produces a label that the Bot API will always accept as inline keyboard
 * button text, from arbitrary Telegram-supplied content.
 *
 * Display-only: callers keep the original title in the database.
 */
function safeButtonLabel(value, { max = 28, fallback = DEFAULT_FALLBACK } = {}) {
  let text = sanitizeUnicode(value);
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return fallback;

  text = truncateGraphemes(text, max);
  text = text.trim();
  if (!text) return fallback;

  // Belt and braces: if anything above somehow produced invalid UTF-8,
  // never hand it to Telegram.
  if (!isValidUtf8(text)) return fallback;
  return text;
}

/**
 * Sanitizes text destined for a message BODY (not a button). Keeps the full
 * content — only removes what Telegram cannot encode.
 */
function safeMessageText(value) {
  return sanitizeUnicode(value);
}

module.exports = {
  safeButtonLabel,
  safeMessageText,
  sanitizeUnicode,
  truncateGraphemes,
  graphemeLength,
  toGraphemes,
  isValidUtf8,
  DEFAULT_FALLBACK,
};
