'use strict';

/**
 * Manual "Send Now" flows: one group, a hand-picked selection, or every
 * enabled group. Broadcasting to more than one group always asks for
 * confirmation first.
 */

const { cb, button } = require('../utils/keyboard');
const { renderPanel, esc, paginate, pagerRow, groupLabel, campaignLabel } = require('./common');

async function showCampaignPicker(ctx, { chatId, messageId, page = 0 }) {
  const campaigns = ctx.q.listCampaigns().filter((c) => c.enabled);
  if (!campaigns.length) {
    return renderPanel(ctx, {
      chatId,
      messageId,
      text: ['🚀 <b>Send Now</b>', '', 'No enabled campaigns available.'].join('\n'),
      keyboard: [[button('📣 Campaigns', cb('c', 'list', '0'))], [button('⬅️ Back', cb('home', 'open'))]],
    });
  }
  const pagination = paginate(campaigns, page, 8);
  const keyboard = pagination.items.map((campaign) => [button(campaignLabel(campaign), cb('n', 'c', campaign.id))]);
  const pager = pagerRow(pagination, (p) => cb('n', 'home', p));
  if (pager) keyboard.push(pager);
  keyboard.push([button('⬅️ Back', cb('home', 'open'))]);
  return renderPanel(ctx, { chatId, messageId, text: ['🚀 <b>Send Now</b>', '', 'Which campaign do you want to send?'].join('\n'), keyboard });
}

async function showTargetMenu(ctx, { chatId, messageId, campaignId }) {
  const campaign = ctx.q.getCampaign(campaignId);
  if (!campaign) return showCampaignPicker(ctx, { chatId, messageId });
  const enabledCount = ctx.q.countEnabledGroups();
  const text = [
    '🚀 <b>Send Now</b>',
    '',
    `Campaign: <b>${esc(campaign.name)}</b>`,
    `Enabled groups: ${enabledCount}`,
    '',
    'Choose where to send it.',
  ].join('\n');
  const keyboard = [
    [button('1️⃣ Send to one group', cb('n', 'one', campaign.id, '0'))],
    [button('☑️ Send to selected groups', cb('n', 'sel', campaign.id, '0'))],
    [button(`📢 Send to all enabled (${enabledCount})`, cb('n', 'all', campaign.id))],
    [button('👁 Preview first', cb('c', 'prev', campaign.id))],
    [button('⬅️ Back', cb('n', 'home', '0'))],
  ];
  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

async function showGroupPicker(ctx, { chatId, messageId, campaignId, page = 0 }) {
  const groups = ctx.q.listGroups();
  if (!groups.length) {
    return renderPanel(ctx, { chatId, messageId, text: '👥 No groups registered.', keyboard: [[button('⬅️ Back', cb('n', 'c', campaignId))]] });
  }
  const pagination = paginate(groups, page, 8);
  const keyboard = pagination.items.map((group) => [button(groupLabel(group), cb('n', 'og', campaignId, group.chat_id))]);
  const pager = pagerRow(pagination, (p) => cb('n', 'one', campaignId, p));
  if (pager) keyboard.push(pager);
  keyboard.push([button('⬅️ Back', cb('n', 'c', campaignId))]);
  return renderPanel(ctx, { chatId, messageId, text: ['1️⃣ <b>Send to one group</b>', '', 'Pick the destination group.'].join('\n'), keyboard });
}

async function showMultiSelect(ctx, { chatId, messageId, campaignId, page = 0, selected = [] }) {
  const groups = ctx.q.listGroups();
  if (!groups.length) {
    return renderPanel(ctx, { chatId, messageId, text: '👥 No groups registered.', keyboard: [[button('⬅️ Back', cb('n', 'c', campaignId))]] });
  }
  const chosen = new Set(selected.map(Number));
  const pagination = paginate(groups, page, 8);
  const keyboard = pagination.items.map((group) => [
    button(`${chosen.has(group.chat_id) ? '☑️' : '▫️'} ${groupLabel(group)}`, cb('n', 'tg', campaignId, group.chat_id)),
  ]);
  const pager = pagerRow(pagination, (p) => cb('n', 'sel', campaignId, p));
  if (pager) keyboard.push(pager);
  keyboard.push([button(`✅ Continue (${chosen.size})`, cb('n', 'seld', campaignId)), button('⬅️ Back', cb('n', 'c', campaignId))]);
  const text = ['☑️ <b>Select groups</b>', '', `Selected: ${chosen.size}`, '', 'Tap groups to select or deselect them.'].join('\n');
  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

/** Confirmation screen shown before any multi-group broadcast. */
async function showConfirm(ctx, { chatId, messageId, campaignId, targets, mode }) {
  const campaign = ctx.q.getCampaign(campaignId);
  if (!campaign) return showCampaignPicker(ctx, { chatId, messageId });
  const paused = ctx.q.isPaused();

  const text = [
    `⚠️ Send this campaign to ${targets.length} group${targets.length === 1 ? '' : 's'}?`,
    '',
    'Campaign:',
    `<b>${esc(campaign.name)}</b>`,
    '',
    ...targets.slice(0, 10).map((g) => `• ${esc(g.title || g.chat_id)}`),
    targets.length > 10 ? `… and ${targets.length - 10} more` : null,
    paused ? '\n⏸ Auto advertising is paused. Confirming sends this batch anyway (manual override).' : null,
  ]
    .filter(Boolean)
    .join('\n');

  const keyboard = [
    [button(paused ? '✅ Confirm (bypass pause)' : '✅ Confirm', cb('n', 'go', campaignId, mode))],
    [button('❌ Cancel', cb('n', 'c', campaignId))],
  ];
  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

/** Formats the per-group outcome of a manual broadcast. */
function formatResults(results) {
  const sent = results.filter((r) => r.status === 'sent').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const other = results.length - sent - failed;
  const lines = [
    '📤 <b>Broadcast finished</b>',
    '',
    `✅ Sent: ${sent}`,
    failed ? `❌ Failed: ${failed}` : null,
    other ? `➖ Skipped: ${other}` : null,
    '',
    ...results.slice(0, 15).map((r) => {
      const icon = r.status === 'sent' ? '✅' : r.status === 'failed' ? '❌' : '➖';
      const detail = r.status === 'sent' ? '' : ` — ${esc(r.friendly || r.reason || '')}`;
      return `${icon} ${esc(r.title || r.chatId)}${detail}`;
    }),
    results.length > 15 ? `… and ${results.length - 15} more` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

module.exports = { showCampaignPicker, showTargetMenu, showGroupPicker, showMultiSelect, showConfirm, formatResults };
