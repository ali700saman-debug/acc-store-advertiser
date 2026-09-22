'use strict';

/**
 * Group registration and management.
 *
 * A group can only ever receive advertisements after an authorised admin runs
 * /register_group inside it. The bot never discovers, joins or messages any
 * chat on its own.
 */

const { cb, button } = require('../utils/keyboard');
const { renderPanel, isAdmin, esc, paginate, pagerRow, groupLabel, campaignLabel } = require('./common');
const { formatInterval, formatClock, formatDateTime } = require('../utils/time');
const policy = require('../services/policy');

const INTERVAL_PRESETS = [60, 120, 180, 360, 720, 1440, 2880];

/** Only real group chats (and channels when explicitly enabled) may be registered. */
function chatTypeAllowed(type, config) {
  if (type === 'group' || type === 'supergroup') return true;
  if (type === 'channel' && config.allowChannels) return true;
  return false;
}

// ------------------------------------------------------------------- views

async function showGroupList(ctx, { chatId, messageId, page = 0 }) {
  const groups = ctx.q.listGroups();
  if (!groups.length) {
    return renderPanel(ctx, {
      chatId,
      messageId,
      text: ['👥 <b>Groups</b>', '', 'No groups registered yet.', '', 'Add the bot to a group, then send <code>/register_group</code> there.'].join('\n'),
      keyboard: [[button('➕ How to add a group', cb('g', 'add'))], [button('⬅️ Back', cb('home', 'open'))]],
    });
  }

  const pagination = paginate(groups, page, 8);
  const keyboard = pagination.items.map((group) => [button(groupLabel(group), cb('g', 'v', group.chat_id))]);
  const pager = pagerRow(pagination, (p) => cb('g', 'list', p));
  if (pager) keyboard.push(pager);
  keyboard.push([button('➕ Add Group', cb('g', 'add'))]);
  keyboard.push([button('⬅️ Back', cb('home', 'open'))]);

  const text = [
    `👥 <b>Groups</b> (${groups.length})`,
    '',
    `✅ Enabled: ${ctx.q.countEnabledGroups()}   ⛔ Disabled: ${groups.length - ctx.q.countEnabledGroups()}`,
    '',
    'Select a group to manage it.',
  ].join('\n');

  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

function describeGroupCampaign(ctx, group) {
  if (group.rotation_enabled) {
    const ids = ctx.q.getGroupCampaignIds(group.chat_id);
    const names = ids.map((id) => ctx.q.getCampaign(id)).filter(Boolean).map((c) => c.name);
    return names.length ? `🔄 Rotating (${names.length}): ${names.join(' → ')}` : '🔄 Rotating (no campaigns selected)';
  }
  if (group.campaign_id) {
    const campaign = ctx.q.getCampaign(group.campaign_id);
    if (campaign) return campaign.name;
  }
  const defaultId = Number(ctx.q.getSetting('default_campaign_id'));
  const fallback = Number.isFinite(defaultId) ? ctx.q.getCampaign(defaultId) : null;
  return fallback ? `${fallback.name} (global default)` : 'Default campaign';
}

async function showGroupDetail(ctx, { chatId, messageId, targetChatId }) {
  const group = ctx.q.getGroup(targetChatId);
  if (!group) {
    return renderPanel(ctx, { chatId, messageId, text: '⚠️ That group is no longer registered.', keyboard: [[button('⬅️ Back', cb('g', 'list', '0'))]] });
  }

  const timezone = policy.getTimezone(ctx.q, ctx.config);
  const interval = policy.resolveIntervalMinutes(ctx.q, ctx.config, group);
  const quiet = policy.resolveQuiet(ctx.q, group);

  const lines = [
    `👥 <b>${esc(group.title || group.chat_id)}</b>`,
    '',
    `🆔 <code>${group.chat_id}</code>`,
    group.username ? `🔗 @${esc(group.username)}` : null,
    `📊 Status: ${group.enabled ? 'Enabled' : 'Disabled'}`,
    `⏱ Interval: ${formatInterval(interval)}${group.interval_minutes ? '' : ' (default)'}`,
    `🕒 Last post: ${group.last_send_at ? formatClock(group.last_send_at, timezone) : '—'}`,
    `⏭ Next post: ${group.next_send_at ? formatDateTime(group.next_send_at, timezone) : '—'}`,
    `📣 Campaign: ${esc(describeGroupCampaign(ctx, group))}`,
    `🌙 Quiet hours: ${quiet.enabled ? `${quiet.start}–${quiet.end} (${quiet.source})` : 'Off'}`,
    `🗑 Delete previous ad: ${group.delete_previous ? 'On' : 'Off'}`,
  ];
  if (group.delivery_problem) {
    lines.push('', `⚠️ Delivery problem: ${esc(group.last_error || 'unknown')}`);
  }

  const keyboard = [
    [button(group.enabled ? '⛔ Disable' : '✅ Enable', cb('g', 'tog', group.chat_id)), button('⏱ Change Interval', cb('g', 'int', group.chat_id))],
    [button('📣 Select Campaign', cb('g', 'cam', group.chat_id)), button('🚀 Send Test', cb('g', 'test', group.chat_id))],
    [button('🌙 Quiet Hours', cb('g', 'quiet', group.chat_id)), button(group.delete_previous ? '🗑 Delete prev: On' : '🗑 Delete prev: Off', cb('g', 'prev', group.chat_id))],
    [button('🔐 Check Permissions', cb('g', 'perm', group.chat_id)), button('🗑 Remove Group', cb('g', 'rm', group.chat_id))],
    [button('⬅️ Back', cb('g', 'list', '0'))],
  ];

  return renderPanel(ctx, { chatId, messageId, text: lines.filter(Boolean).join('\n'), keyboard });
}

async function showIntervalMenu(ctx, { chatId, messageId, targetChatId }) {
  const group = ctx.q.getGroup(targetChatId);
  if (!group) return showGroupList(ctx, { chatId, messageId });
  const current = policy.resolveIntervalMinutes(ctx.q, ctx.config, group);

  const presetButtons = INTERVAL_PRESETS.map((minutes) =>
    button(`${current === minutes && group.interval_minutes ? '• ' : ''}${formatInterval(minutes)}`, cb('g', 'si', group.chat_id, minutes))
  );
  const keyboard = [];
  for (let i = 0; i < presetButtons.length; i += 2) keyboard.push(presetButtons.slice(i, i + 2));
  keyboard.push([button('✏️ Custom interval', cb('g', 'ic', group.chat_id))]);
  keyboard.push([button('↩️ Use global default', cb('g', 'si', group.chat_id, '0'))]);
  keyboard.push([button('⬅️ Back', cb('g', 'v', group.chat_id))]);

  const text = [
    `⏱ <b>Interval</b> — ${esc(group.title || group.chat_id)}`,
    '',
    `Current: ${formatInterval(current)}${group.interval_minutes ? '' : ' (global default)'}`,
    `Minimum allowed: ${formatInterval(ctx.config.minIntervalMinutes)}`,
  ].join('\n');

  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

async function showCampaignMenu(ctx, { chatId, messageId, targetChatId, page = 0 }) {
  const group = ctx.q.getGroup(targetChatId);
  if (!group) return showGroupList(ctx, { chatId, messageId });
  const campaigns = ctx.q.listCampaigns();
  const rotationIds = ctx.q.getGroupCampaignIds(group.chat_id);

  const pagination = paginate(campaigns, page, 6);
  const keyboard = pagination.items.map((campaign) => {
    if (group.rotation_enabled) {
      const mark = rotationIds.includes(campaign.id) ? '☑️' : '▫️';
      return [button(`${mark} ${campaignLabel(campaign)}`, cb('g', 'rt', group.chat_id, campaign.id))];
    }
    const mark = group.campaign_id === campaign.id ? '• ' : '';
    return [button(`${mark}${campaignLabel(campaign)}`, cb('g', 'sc', group.chat_id, campaign.id))];
  });

  const pager = pagerRow(pagination, (p) => cb('g', 'cam', group.chat_id, p));
  if (pager) keyboard.push(pager);
  if (!group.rotation_enabled) keyboard.push([button('↩️ Use global default campaign', cb('g', 'sc', group.chat_id, '0'))]);
  keyboard.push([button(group.rotation_enabled ? '🔄 Rotation: On' : '🔂 Rotation: Off', cb('g', 'rot', group.chat_id))]);
  keyboard.push([button('⬅️ Back', cb('g', 'v', group.chat_id))]);

  const text = [
    `📣 <b>Campaign</b> — ${esc(group.title || group.chat_id)}`,
    '',
    group.rotation_enabled
      ? 'Rotation is on. Tick the campaigns to cycle through; the bot posts them in order.'
      : 'Pick the single campaign this group receives.',
    '',
    `Current: ${esc(describeGroupCampaign(ctx, group))}`,
  ].join('\n');

  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

async function showQuietMenu(ctx, { chatId, messageId, targetChatId }) {
  const group = ctx.q.getGroup(targetChatId);
  if (!group) return showGroupList(ctx, { chatId, messageId });
  const quiet = policy.resolveQuiet(ctx.q, group);
  const timezone = policy.getTimezone(ctx.q, ctx.config);

  const text = [
    `🌙 <b>Quiet Hours</b> — ${esc(group.title || group.chat_id)}`,
    '',
    `Group override: ${group.quiet_enabled ? `On (${group.quiet_start}–${group.quiet_end})` : 'Off'}`,
    `Effective: ${quiet.enabled ? `${quiet.start}–${quiet.end} (${quiet.source})` : 'No quiet hours'}`,
    `Timezone: ${esc(timezone)}`,
    '',
    'Ads due during quiet hours are delayed to the next allowed time, never skipped.',
  ].join('\n');

  const keyboard = [
    [button(group.quiet_enabled ? '⛔ Disable override' : '✅ Enable override', cb('g', 'qtog', group.chat_id))],
    [button('🕛 Set start', cb('g', 'qs', group.chat_id)), button('🕗 Set end', cb('g', 'qe', group.chat_id))],
    [button('⬅️ Back', cb('g', 'v', group.chat_id))],
  ];
  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

// ---------------------------------------------------------------- commands

async function handleRegisterGroup(ctx, msg) {
  const { bot, q, config } = ctx;
  const chat = msg.chat;

  if (!isAdmin(msg.from?.id, config)) {
    ctx.logger.warn(`ignored /register_group from non-admin in chat ${chat.id}`);
    return;
  }

  if (!chatTypeAllowed(chat.type, config)) {
    await bot.sendMessage(chat.id, '⚠️ Only groups and supergroups can be registered for advertising.');
    return;
  }

  const existing = q.getGroup(chat.id);
  if (existing) {
    await bot.sendMessage(chat.id, 'ℹ️ This group is already registered.');
    return;
  }

  // Confirm the bot can actually post before accepting the registration.
  const permission = await ctx.telegram.checkPostPermission(chat.id, ctx.botInfo?.id);
  if (!permission.ok) {
    await bot.sendMessage(chat.id, `⚠️ Cannot register: ${permission.friendly}.\nGive the bot permission to send messages and try again.`);
    return;
  }

  const timezone = policy.getTimezone(q, config);
  const interval = policy.getDefaultIntervalMinutes(q, config);
  const quiet = policy.resolveQuiet(q, null);
  const firstSend = policy.computeNextSendAt(new Date(), interval, quiet, timezone);

  const { group } = q.registerGroup({
    chat_id: chat.id,
    title: chat.title || '',
    type: chat.type,
    username: chat.username || null,
    registered_by: msg.from.id,
    next_send_at: firstSend.toISOString(),
  });

  q.recordAudit(msg.from.id, 'group.register', String(chat.id), chat.title || '');
  ctx.logger.info(`group registered: ${chat.id} (${chat.type})`);

  await bot.sendMessage(
    chat.id,
    [
      '✅ Group registered successfully.',
      '',
      `Interval: ${formatInterval(interval)}`,
      `First advertisement: ${formatDateTime(group.next_send_at, timezone)}`,
    ].join('\n')
  );
}

async function handleUnregisterGroup(ctx, msg) {
  const { bot, q, config } = ctx;
  if (!isAdmin(msg.from?.id, config)) return;
  const existing = q.getGroup(msg.chat.id);
  if (!existing) {
    await bot.sendMessage(msg.chat.id, 'ℹ️ This group is not registered.');
    return;
  }
  q.removeGroup(msg.chat.id);
  q.recordAudit(msg.from.id, 'group.unregister', String(msg.chat.id), existing.title || '');
  ctx.logger.info(`group unregistered: ${msg.chat.id}`);
  await bot.sendMessage(msg.chat.id, '🗑 Group removed. No further advertisements will be posted here.');
}

function register(ctx) {
  const { bot, config } = ctx;

  bot.onText(/^\/register_group(?:@\w+)?$/, (msg) => handleRegisterGroup(ctx, msg).catch((e) => ctx.logger.error(`register_group: ${e.message}`)));
  bot.onText(/^\/unregister_group(?:@\w+)?$/, (msg) => handleUnregisterGroup(ctx, msg).catch((e) => ctx.logger.error(`unregister_group: ${e.message}`)));

  bot.onText(/^\/groupid(?:@\w+)?$/, async (msg) => {
    if (!isAdmin(msg.from?.id, config)) return;
    await bot.sendMessage(msg.chat.id, `🆔 Chat id: <code>${msg.chat.id}</code>\nType: ${msg.chat.type}`, { parse_mode: 'HTML' });
  });

  // Keep the panel honest when the bot loses access to a group.
  bot.on('my_chat_member', (update) => {
    try {
      const chatId = update?.chat?.id;
      const status = update?.new_chat_member?.status;
      if (!chatId || !ctx.q.getGroup(chatId)) return;
      if (status === 'left' || status === 'kicked') {
        ctx.q.recordGroupError(chatId, { code: 'BOT_REMOVED', message: 'Bot was removed from the group', problem: true });
        ctx.logger.warn(`bot removed from registered group ${chatId}`);
      } else if (status === 'member' || status === 'administrator') {
        ctx.q.clearGroupError(chatId);
      }
    } catch (error) {
      ctx.logger.error(`my_chat_member: ${error.message}`);
    }
  });
}

module.exports = {
  register,
  showGroupList,
  showGroupDetail,
  showIntervalMenu,
  showCampaignMenu,
  showQuietMenu,
  handleRegisterGroup,
  handleUnregisterGroup,
  chatTypeAllowed,
  INTERVAL_PRESETS,
  describeGroupCampaign,
};
