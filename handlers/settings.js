'use strict';

/** Global settings panel. */

const { cb, button } = require('../utils/keyboard');
const { renderPanel, esc, paginate, pagerRow, campaignLabel } = require('./common');
const { formatInterval } = require('../utils/time');
const { truncate } = require('../utils/html');
const policy = require('../services/policy');
const { INTERVAL_PRESETS } = require('./groups');

async function showSettings(ctx, { chatId, messageId }) {
  const { q, config } = ctx;
  const paused = q.isPaused();
  const defaultCampaignId = Number(q.getSetting('default_campaign_id'));
  const defaultCampaign = Number.isFinite(defaultCampaignId) ? q.getCampaign(defaultCampaignId) : null;
  const quiet = policy.resolveQuiet(q, null);
  const storeUrl = q.getSetting('main_store_bot_url') || config.mainStoreBotUrl || '—';

  const text = [
    '⚙️ <b>Settings</b>',
    '',
    `⏱ Default interval: ${formatInterval(policy.getDefaultIntervalMinutes(q, config))}`,
    `🌙 Quiet hours: ${quiet.enabled ? `${quiet.start}–${quiet.end}` : 'Off'}`,
    `🌐 Timezone: ${esc(policy.getTimezone(q, config))}`,
    `🤖 Main store bot: ${esc(truncate(storeUrl, 44))}`,
    `📣 Default campaign: ${defaultCampaign ? esc(defaultCampaign.name) : '—'}`,
    `📢 Auto advertising: ${paused ? '⏸ Paused' : '▶️ Running'}`,
  ].join('\n');

  const keyboard = [
    [button('⏱ Default Interval', cb('s', 'interval')), button('🌙 Quiet Hours', cb('s', 'quiet'))],
    [button('🌐 Timezone', cb('s', 'tz')), button('🤖 Main Store Bot URL', cb('s', 'url'))],
    [button('📣 Default Campaign', cb('s', 'defcam', '0'))],
    [button(paused ? '▶️ Resume Advertising' : '⏸ Pause All Advertising', cb('s', 'pause'))],
    [button('🗒 Audit Log', cb('s', 'audit')), button('⬅️ Back', cb('home', 'open'))],
  ];

  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

async function showDefaultIntervalMenu(ctx, { chatId, messageId }) {
  const current = policy.getDefaultIntervalMinutes(ctx.q, ctx.config);
  const buttons = INTERVAL_PRESETS.map((minutes) => button(`${current === minutes ? '• ' : ''}${formatInterval(minutes)}`, cb('s', 'si', minutes)));
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) keyboard.push(buttons.slice(i, i + 2));
  keyboard.push([button('✏️ Custom interval', cb('s', 'ic'))]);
  keyboard.push([button('⬅️ Back', cb('s', 'home'))]);

  const text = [
    '⏱ <b>Default Interval</b>',
    '',
    `Current: ${formatInterval(current)}`,
    `Minimum allowed: ${formatInterval(ctx.config.minIntervalMinutes)}`,
    '',
    'Groups without their own interval use this value.',
  ].join('\n');

  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

async function showQuietMenu(ctx, { chatId, messageId }) {
  const { q } = ctx;
  const enabled = q.getSetting('quiet_enabled', '0') === '1';
  const text = [
    '🌙 <b>Global Quiet Hours</b>',
    '',
    `Status: ${enabled ? 'On' : 'Off'}`,
    `Window: ${q.getSetting('quiet_start', '00:00')} – ${q.getSetting('quiet_end', '08:00')}`,
    `Timezone: ${esc(policy.getTimezone(q, ctx.config))}`,
    '',
    'Ads due inside the window are delayed to the next allowed time, never dropped. Individual groups can override this.',
  ].join('\n');
  const keyboard = [
    [button(enabled ? '⛔ Disable' : '✅ Enable', cb('s', 'qtog'))],
    [button('🕛 Set start', cb('s', 'qs')), button('🕗 Set end', cb('s', 'qe'))],
    [button('⬅️ Back', cb('s', 'home'))],
  ];
  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

async function showDefaultCampaignMenu(ctx, { chatId, messageId, page = 0 }) {
  const campaigns = ctx.q.listCampaigns();
  const currentId = Number(ctx.q.getSetting('default_campaign_id'));
  if (!campaigns.length) {
    return renderPanel(ctx, { chatId, messageId, text: '📣 No campaigns exist yet.', keyboard: [[button('⬅️ Back', cb('s', 'home'))]] });
  }
  const pagination = paginate(campaigns, page, 8);
  const keyboard = pagination.items.map((campaign) => [
    button(`${campaign.id === currentId ? '⭐ ' : ''}${campaignLabel(campaign)}`, cb('s', 'sdc', campaign.id)),
  ]);
  const pager = pagerRow(pagination, (p) => cb('s', 'defcam', p));
  if (pager) keyboard.push(pager);
  keyboard.push([button('⬅️ Back', cb('s', 'home'))]);
  const text = ['📣 <b>Default Campaign</b>', '', 'Used by every group that has not picked its own campaign.'].join('\n');
  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

async function showAuditLog(ctx, { chatId, messageId }) {
  const entries = ctx.q.listAudit(15);
  const timezone = policy.getTimezone(ctx.q, ctx.config);
  const { formatDateTime } = require('../utils/time');
  const lines = entries.length
    ? entries.map((e) => `• ${formatDateTime(e.created_at, timezone)} — <code>${e.admin_id}</code> ${esc(e.action)}${e.target ? ` (${esc(truncate(e.target, 24))})` : ''}`)
    : ['No admin actions recorded yet.'];
  return renderPanel(ctx, {
    chatId,
    messageId,
    text: ['🗒 <b>Audit Log</b> — last 15 actions', '', ...lines].join('\n'),
    keyboard: [[button('⬅️ Back', cb('s', 'home'))]],
  });
}

module.exports = { showSettings, showDefaultIntervalMenu, showQuietMenu, showDefaultCampaignMenu, showAuditLog };
