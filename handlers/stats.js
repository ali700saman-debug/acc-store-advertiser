'use strict';

/** Statistics panel: counts plus the most recent deliveries. */

const { cb, button } = require('../utils/keyboard');
const { renderPanel, esc } = require('./common');
const { zonedParts, zonedTimeToUtc, formatClock } = require('../utils/time');
const { truncate } = require('../utils/html');
const policy = require('../services/policy');

/** Local midnight and "7 days ago" boundaries, as UTC instants. */
function boundaries(now, timezone) {
  const parts = zonedParts(now, timezone);
  const todayStart = zonedTimeToUtc({ year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0 }, timezone);
  const weekStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { todayStart: todayStart.toISOString(), weekStart: weekStart.toISOString() };
}

async function showStats(ctx, { chatId, messageId }) {
  const timezone = policy.getTimezone(ctx.q, ctx.config);
  const stats = ctx.q.deliveryStats(boundaries(new Date(), timezone));
  const total = ctx.q.countGroups();
  const enabled = ctx.q.countEnabledGroups();

  const text = [
    '📊 <b>Statistics</b>',
    '',
    `👥 Registered groups: ${total}`,
    `✅ Enabled groups: ${enabled}`,
    `⛔ Disabled groups: ${total - enabled}`,
    `⚠️ Groups with delivery problems: ${ctx.q.countProblemGroups()}`,
    '',
    `📤 Ads sent today: ${stats.sentToday}`,
    `📤 Ads sent last 7 days: ${stats.sentWeek}`,
    `📤 Ads sent total: ${stats.sentTotal}`,
    '',
    `❌ Failed deliveries (total): ${stats.failedTotal}`,
    `❌ Failed deliveries (7 days): ${stats.failedWeek}`,
  ].join('\n');

  const keyboard = [
    [button('🕒 Recent deliveries', cb('st', 'recent'))],
    [button('⬅️ Back', cb('home', 'open'))],
  ];
  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

async function showRecent(ctx, { chatId, messageId }) {
  const timezone = policy.getTimezone(ctx.q, ctx.config);
  const rows = ctx.q.recentDeliveries(15);
  const lines = rows.length
    ? rows.map((row) => {
        const when = row.sent_at || row.created_at;
        const label = esc(truncate(row.group_title || String(row.chat_id), 24));
        if (row.status === 'sent') return `✅ ${label} — ${formatClock(when, timezone)}`;
        return `❌ ${label} — ${esc(truncate(row.error_message || row.error_code || 'failed', 40))}`;
      })
    : ['No deliveries recorded yet.'];

  return renderPanel(ctx, {
    chatId,
    messageId,
    text: ['🕒 <b>Recent deliveries</b>', '', ...lines].join('\n'),
    keyboard: [[button('⬅️ Back', cb('st', 'home'))]],
  });
}

module.exports = { showStats, showRecent, boundaries };
