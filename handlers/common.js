'use strict';

/** Shared helpers for every admin handler. */

const { esc, truncate } = require('../utils/html');
const { safeButtonLabel } = require('../utils/text');
const { button, backRow, markup } = require('../utils/keyboard');

/**
 * Callback query ids already acknowledged.
 *
 * Telegram allows exactly one answerCallbackQuery per query, and the query
 * expires after a few seconds. Answering twice returns
 * "query ID is invalid", and answering late returns "query is too old" —
 * neither is an error worth surfacing, so both are swallowed and the id is
 * remembered so a second attempt is skipped entirely.
 */
const answeredQueries = new Map();
const ANSWERED_HISTORY = 500;

const EXPIRED_QUERY = /query is too old|query ID is invalid|QUERY_ID_INVALID/i;

/** Authentication is by numeric Telegram user id only — never by username. */
function isAdmin(userId, config) {
  return Boolean(userId) && config.adminIds.includes(Number(userId));
}

const NON_ADMIN_REPLY = 'This bot is for ACC STORE administration.';

/** Replaces the current panel in place; falls back to a new message. */
async function renderPanel(ctx, { chatId, messageId, text, keyboard }) {
  const options = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? markup(keyboard) : {}),
  };
  if (messageId) {
    try {
      return await ctx.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    } catch (error) {
      // "message is not modified" and expired messages are not real failures.
      if (!/message is not modified/i.test(error?.message || '')) {
        ctx.logger.warn(`panel edit failed: ${error.message}`);
      } else {
        return null;
      }
    }
  }
  return ctx.bot.sendMessage(chatId, text, options);
}

/**
 * Acknowledges a callback query at most once. Never throws.
 *
 * Returns true when this call actually delivered the acknowledgement.
 */
async function answer(ctx, callbackQueryId, text = '', showAlert = false) {
  if (!callbackQueryId) return false;
  if (answeredQueries.has(callbackQueryId)) return false;

  answeredQueries.set(callbackQueryId, Date.now());
  // Keep the map bounded; ids are only useful for a few seconds.
  while (answeredQueries.size > ANSWERED_HISTORY) {
    const oldest = answeredQueries.keys().next().value;
    answeredQueries.delete(oldest);
  }

  try {
    await ctx.bot.answerCallbackQuery(callbackQueryId, { text, show_alert: showAlert });
    return true;
  } catch (error) {
    const message = error?.message || '';
    if (EXPIRED_QUERY.test(message)) {
      // The spinner has already timed out on the client. Harmless.
      ctx.logger.info('callback acknowledgement skipped (query expired)');
      return false;
    }
    ctx.logger.warn(`answerCallbackQuery failed: ${message}`);
    return false;
  }
}

/** Test/maintenance seam: forget acknowledged ids. */
function resetAnsweredQueries() {
  answeredQueries.clear();
}

function statusDot(enabled) {
  return enabled ? '✅' : '⛔';
}

function groupLabel(group) {
  // Group titles are arbitrary Telegram content: always sanitize for buttons.
  const title = safeButtonLabel(group.title || String(group.chat_id), { max: 28 });
  return `${statusDot(group.enabled)} ${title}`;
}

function campaignLabel(campaign) {
  return `${statusDot(campaign.enabled)} ${safeButtonLabel(campaign.name, { max: 28, fallback: 'Untitled campaign' })}`;
}

/** Pagination for long lists so keyboards stay within Telegram limits. */
function paginate(items, page = 0, perPage = 8) {
  const total = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(Math.max(0, Number(page) || 0), total - 1);
  return {
    page: current,
    totalPages: total,
    items: items.slice(current * perPage, current * perPage + perPage),
    hasPrev: current > 0,
    hasNext: current < total - 1,
  };
}

function pagerRow(pagination, makeData) {
  if (pagination.totalPages <= 1) return null;
  const row = [];
  if (pagination.hasPrev) row.push(button('◀️', makeData(pagination.page - 1)));
  row.push(button(`${pagination.page + 1}/${pagination.totalPages}`, 'noop'));
  if (pagination.hasNext) row.push(button('▶️', makeData(pagination.page + 1)));
  return row;
}

module.exports = {
  isAdmin, NON_ADMIN_REPLY, renderPanel, answer, resetAnsweredQueries,
  statusDot, groupLabel, campaignLabel, paginate, pagerRow, esc, button, backRow,
};
