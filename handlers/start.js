'use strict';

/** Admin home dashboard, /status and the non-admin fallback reply. */

const { cb, button } = require('../utils/keyboard');
const { renderPanel, isAdmin, NON_ADMIN_REPLY, esc } = require('./common');
const { formatInterval } = require('../utils/time');
const policy = require('../services/policy');

function homeKeyboard() {
  return [
    [button('📣 Campaigns', cb('c', 'list', '0')), button('👥 Groups', cb('g', 'list', '0'))],
    [button('➕ Add Group', cb('g', 'add')), button('📝 Default Advertisement', cb('c', 'default'))],
    [button('⏱ Schedule', cb('s', 'interval')), button('🚀 Send Now', cb('n', 'home'))],
    [button('📊 Statistics', cb('st', 'home')), button('⚙️ Settings', cb('s', 'home'))],
    [button('⚙️ Sender Account', cb('sndr', 'home'))],
  ];
}

function buildDashboardText(ctx) {
  const { q, config } = ctx;
  const groups = q.countGroups();
  const enabled = q.countEnabledGroups();
  const campaigns = q.countCampaigns();
  const paused = q.isPaused();
  const interval = policy.getDefaultIntervalMinutes(q, config);
  const timezone = policy.getTimezone(q, config);
  const problems = q.countProblemGroups();

  const senderStatus = ctx.userSender ? ctx.userSender.getStatus() : null;
  const senderLine = senderStatus
    ? (senderStatus.connected
      ? `🟢 Connected${senderStatus.account?.username ? ` (@${esc(senderStatus.account.username)})` : ''}`
      : '🔴 Unavailable')
    : '⚙️ Not configured';

  const lines = [
    '📢 <b>ACC STORE Advertiser</b>',
    '',
    `📊 Status: ${paused ? '⏸ Paused' : '🟢 Running'}`,
    `👤 User sender: ${senderLine}`,
    `👥 Groups: ${groups} (${enabled} enabled)`,
    `📣 Campaigns: ${campaigns}`,
    `⏱ Default interval: ${formatInterval(interval)}`,
    `🌐 Timezone: ${esc(timezone)}`,
  ];
  if (problems > 0) lines.push(`⚠️ Groups with delivery problems: ${problems}`);
  return lines.join('\n');
}

async function showHome(ctx, { chatId, messageId = null }) {
  return renderPanel(ctx, { chatId, messageId, text: buildDashboardText(ctx), keyboard: homeKeyboard() });
}

function buildStatusText(ctx) {
  const { q, config, scheduler, dbInfo } = ctx;
  const paused = q.isPaused();
  const schedulerStatus = scheduler ? scheduler.status() : { running: false };
  const senderStatus = ctx.userSender ? ctx.userSender.getStatus() : null;
  // Deliberately no session, api hash or phone number here.
  const senderLine = senderStatus
    ? (senderStatus.connected
      ? `🟢 Connected${senderStatus.account?.username ? ` (@${esc(senderStatus.account.username)})` : ''}`
      : `🔴 ${esc(senderStatus.reason || 'Unavailable')}`)
    : '⚙️ Not configured';
  const floodUntil = q.getFloodWaitUntil();

  return [
    '🤖 <b>Advertiser Status</b>',
    '',
    '🟢 Bot: Running',
    `👤 User sender: ${senderLine}`,
    `📢 Auto Ads: ${paused ? '⏸ Paused' : '✅ Enabled'}`,
    `👥 Groups: ${q.countGroups()} (${q.countEnabledGroups()} enabled)`,
    `📣 Campaigns: ${q.countCampaigns()} (${q.countEnabledCampaigns()} active)`,
    `⏱ Default: ${formatInterval(policy.getDefaultIntervalMinutes(q, config))}`,
    `🌐 Timezone: ${esc(policy.getTimezone(q, config))}`,
    `🗄 Database: ${dbInfo?.persistent ? 'Persistent' : 'Ephemeral (no volume detected)'}`,
    `🕒 Scheduler: ${schedulerStatus.running ? 'Running' : 'Stopped'}`,
    floodUntil && new Date(floodUntil) > new Date() ? `⏳ Rate limit hold until: ${esc(floodUntil)}` : null,
  ].filter(Boolean).join('\n');
}

function register(ctx) {
  const { bot, config } = ctx;

  bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
    // Admin panel is private-chat only; /start in a group is ignored.
    if (msg.chat.type !== 'private') return;
    if (!isAdmin(msg.from?.id, config)) {
      await bot.sendMessage(msg.chat.id, NON_ADMIN_REPLY);
      return;
    }
    ctx.sessions.clear(msg.from.id);
    await showHome(ctx, { chatId: msg.chat.id });
  });

  bot.onText(/^\/status(?:@\w+)?$/, async (msg) => {
    if (!isAdmin(msg.from?.id, config)) {
      if (msg.chat.type === 'private') await bot.sendMessage(msg.chat.id, NON_ADMIN_REPLY);
      return;
    }
    await bot.sendMessage(msg.chat.id, buildStatusText(ctx), { parse_mode: 'HTML' });
  });

  bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
    if (!isAdmin(msg.from?.id, config)) {
      if (msg.chat.type === 'private') await bot.sendMessage(msg.chat.id, NON_ADMIN_REPLY);
      return;
    }
    await bot.sendMessage(
      msg.chat.id,
      [
        '📖 <b>Admin commands</b>',
        '',
        '/start — open the admin panel',
        '/status — current bot status',
        '/cancel — cancel the current edit',
        '',
        '<b>Inside a group</b>',
        '/register_group — register the group for advertising',
        '/unregister_group — stop advertising in the group',
        '/groupid — show the chat id',
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  });

  bot.onText(/^\/cancel(?:@\w+)?$/, async (msg) => {
    if (msg.chat.type !== 'private' || !isAdmin(msg.from?.id, config)) return;
    ctx.sessions.clear(msg.from.id);
    await bot.sendMessage(msg.chat.id, '❌ Cancelled.');
    await showHome(ctx, { chatId: msg.chat.id });
  });
}

module.exports = { register, showHome, homeKeyboard, buildDashboardText, buildStatusText };
