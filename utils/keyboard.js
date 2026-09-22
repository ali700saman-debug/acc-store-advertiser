'use strict';

/**
 * Inline keyboard builders.
 *
 * Callback data always uses stable internal identifiers (never the visible
 * label) so renaming a button can never break routing. Format:
 *   "<namespace>:<action>[:<arg>...]"
 */

const { safeButtonLabel } = require('./text');

const SEP = ':';

// Telegram has no documented hard limit on button text, but long labels wrap
// badly. This is a safety net for static labels; call sites use tighter values.
const MAX_BUTTON_LABEL = 64;

function cb(namespace, action, ...args) {
  const data = [namespace, action, ...args.filter((a) => a !== undefined && a !== null)].join(SEP);
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error(`Callback data too long (>64 bytes): ${data}`);
  }
  return data;
}

function parseCallback(data) {
  const parts = String(data ?? '').split(SEP);
  return { namespace: parts[0] || '', action: parts[1] || '', args: parts.slice(2) };
}

/**
 * Every button goes through the sanitizer.
 *
 * This is the single chokepoint that guarantees the Bot API can never reject
 * a keyboard with "inline keyboard button text must be encoded in UTF-8" —
 * one invalid label rejects the whole keyboard, so a group title with an
 * emoji at the wrong offset used to break an entire panel.
 */
function button(text, data) {
  return { text: safeButtonLabel(text, { max: MAX_BUTTON_LABEL, fallback: '-' }), callback_data: data };
}

function urlButton(text, url) {
  return { text: safeButtonLabel(text, { max: MAX_BUTTON_LABEL, fallback: '-' }), url };
}

function rows(...list) {
  return { reply_markup: { inline_keyboard: list.filter(Boolean) } };
}

function markup(inlineKeyboard) {
  return { reply_markup: { inline_keyboard: inlineKeyboard } };
}

/** Splits buttons into rows of `perRow`. */
function grid(buttons, perRow = 2) {
  const out = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    out.push(buttons.slice(i, i + perRow));
  }
  return out;
}

function backRow(data, label = '⬅️ Back') {
  return [button(label, data)];
}

/** Standard confirm/cancel pair. */
function confirmRow(confirmData, cancelData, confirmLabel = '✅ Confirm', cancelLabel = '❌ Cancel') {
  return [button(confirmLabel, confirmData), button(cancelLabel, cancelData)];
}

module.exports = { SEP, cb, parseCallback, button, urlButton, rows, markup, grid, backRow, confirmRow, MAX_BUTTON_LABEL };
