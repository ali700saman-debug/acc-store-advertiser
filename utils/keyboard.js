'use strict';

/**
 * Inline keyboard builders.
 *
 * Callback data always uses stable internal identifiers (never the visible
 * label) so renaming a button can never break routing. Format:
 *   "<namespace>:<action>[:<arg>...]"
 */

const SEP = ':';

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

function button(text, data) {
  return { text, callback_data: data };
}

function urlButton(text, url) {
  return { text, url };
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

module.exports = { SEP, cb, parseCallback, button, urlButton, rows, markup, grid, backRow, confirmRow };
