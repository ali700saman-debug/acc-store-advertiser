'use strict';

/** Shared helpers for every admin handler. */

const { esc, truncate } = require('../utils/html');
const { button, backRow, markup } = require('../utils/keyboard');

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

async function answer(ctx, callbackQueryId, text = '', showAlert = false) {
  if (!callbackQueryId) return;
  try {
    await ctx.bot.answerCallbackQuery(callbackQueryId, { text, show_alert: showAlert });
  } catch (error) {
    ctx.logger.warn(`answerCallbackQuery failed: ${error.message}`);
  }
}

function statusDot(enabled) {
  return enabled ? '✅' : '⛔';
}

function groupLabel(group) {
  const title = truncate(group.title || String(group.chat_id), 28);
  return `${statusDot(group.enabled)} ${title}`;
}

function campaignLabel(campaign) {
  return `${statusDot(campaign.enabled)} ${truncate(campaign.name, 28)}`;
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

module.exports = { isAdmin, NON_ADMIN_REPLY, renderPanel, answer, statusDot, groupLabel, campaignLabel, paginate, pagerRow, esc, button, backRow };
