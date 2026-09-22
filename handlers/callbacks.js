'use strict';

/**
 * Central router for inline-keyboard callbacks and for the text/media replies
 * that multi-step edit flows are waiting on.
 *
 * Every entry point re-checks the caller's numeric Telegram id: no callback
 * can reach admin functionality without passing that gate.
 */

const { parseCallback, cb, button } = require('../utils/keyboard');
const { isAdmin, NON_ADMIN_REPLY, answer, renderPanel, esc } = require('./common');
const startHandler = require('./start');
const groupsHandler = require('./groups');
const campaignsHandler = require('./campaigns');
const settingsHandler = require('./settings');
const sendNowHandler = require('./sendnow');
const statsHandler = require('./stats');
const senderHandler = require('./sender');
const policy = require('../services/policy');
const { parseIntervalInput, formatInterval, parseHHMM } = require('../utils/time');
const { validateUrl } = require('../utils/html');

const SAVE_KEYBOARD = campaignsHandler.SAVE_KEYBOARD;

/** Recomputes a group's next slot after its interval or quiet hours change. */
function rescheduleGroup(ctx, chatId) {
  const group = ctx.q.getGroup(chatId);
  if (!group) return null;
  const timezone = policy.getTimezone(ctx.q, ctx.config);
  const quiet = policy.resolveQuiet(ctx.q, group);
  const interval = policy.resolveIntervalMinutes(ctx.q, ctx.config, group);
  const base = group.last_send_at ? new Date(group.last_send_at) : new Date();
  let next = policy.computeNextSendAt(base, interval, quiet, timezone);
  if (next.getTime() < Date.now()) {
    next = policy.deferPastQuietHours(new Date(), quiet, timezone);
  }
  return ctx.q.updateGroup(chatId, { next_send_at: next.toISOString() });
}

function extractMedia(msg) {
  if (msg.photo && msg.photo.length) {
    return { type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id };
  }
  if (msg.animation) return { type: 'animation', fileId: msg.animation.file_id };
  if (msg.video) return { type: 'video', fileId: msg.video.file_id };
  return null;
}

// ------------------------------------------------------------- group routes

async function routeGroups(ctx, { query, chatId, messageId, action, args, userId }) {
  const { q } = ctx;
  const targetId = args[0] ? Number(args[0]) : null;

  switch (action) {
    case 'list':
      return groupsHandler.showGroupList(ctx, { chatId, messageId, page: Number(args[0] || 0) });

    case 'add':
      return renderPanel(ctx, {
        chatId,
        messageId,
        text: [
          '➕ <b>Add a group</b>',
          '',
          '<b>Preferred — user account</b>',
          '1. Join the group yourself in the official Telegram app,',
          '   using the advertising account.',
          '2. Open ⚙️ Sender Account → 👥 Import My Groups.',
          '3. Tick the group and press Add Selected.',
          '',
          '<b>Legacy — bot delivery</b>',
          'Add this bot to the group, give it permission to send messages,',
          'then send <code>/register_group</code> there.',
          '',
          '<i>Only groups you explicitly add here are ever advertised in. Nothing is joined automatically, and belonging to a group is never enough on its own.</i>',
        ].join('\n'),
        keyboard: [
          [button('👥 Import My Groups', cb('sndr', 'imp', '0'))],
          [button('⬅️ Back', cb('g', 'list', '0'))],
        ],
      });

    case 'v':
      return groupsHandler.showGroupDetail(ctx, { chatId, messageId, targetChatId: targetId });

    case 'tog': {
      const group = q.getGroup(targetId);
      if (!group) return groupsHandler.showGroupList(ctx, { chatId, messageId });
      const next = group.enabled ? 0 : 1;
      q.updateGroup(targetId, { enabled: next });
      if (next) rescheduleGroup(ctx, targetId);
      q.recordAudit(userId, 'group.enabled', String(targetId), next ? 'enabled' : 'disabled');
      await answer(ctx, query.id, next ? '✅ Enabled' : '⛔ Disabled');
      return groupsHandler.showGroupDetail(ctx, { chatId, messageId, targetChatId: targetId });
    }

    case 'int':
      return groupsHandler.showIntervalMenu(ctx, { chatId, messageId, targetChatId: targetId });

    case 'si': {
      const minutes = Number(args[1]);
      const value = minutes === 0 ? null : policy.clampInterval(minutes, ctx.config);
      q.updateGroup(targetId, { interval_minutes: value });
      rescheduleGroup(ctx, targetId);
      q.recordAudit(userId, 'group.interval', String(targetId), value ? `${value}m` : 'default');
      await answer(ctx, query.id, value ? `⏱ ${formatInterval(value)}` : '⏱ Using global default');
      return groupsHandler.showGroupDetail(ctx, { chatId, messageId, targetChatId: targetId });
    }

    case 'ic':
      ctx.sessions.set(userId, { type: 'g_interval', chatId: targetId, panelChatId: chatId });
      return ctx.bot.sendMessage(
        chatId,
        [
          '✏️ Send the custom interval.',
          '',
          'Examples: <code>90</code> (minutes), <code>4h</code>, <code>2d</code>',
          `Minimum: ${formatInterval(ctx.config.minIntervalMinutes)}`,
        ].join('\n'),
        { parse_mode: 'HTML' }
      );

    case 'cam':
      return groupsHandler.showCampaignMenu(ctx, { chatId, messageId, targetChatId: targetId, page: Number(args[1] || 0) });

    case 'sc': {
      const campaignId = Number(args[1]);
      q.updateGroup(targetId, { campaign_id: campaignId === 0 ? null : campaignId, rotation_enabled: 0 });
      q.recordAudit(userId, 'group.campaign', String(targetId), campaignId ? String(campaignId) : 'default');
      await answer(ctx, query.id, '📣 Campaign updated');
      return groupsHandler.showGroupDetail(ctx, { chatId, messageId, targetChatId: targetId });
    }

    case 'rot': {
      const group = q.getGroup(targetId);
      if (!group) return groupsHandler.showGroupList(ctx, { chatId, messageId });
      q.updateGroup(targetId, { rotation_enabled: group.rotation_enabled ? 0 : 1 });
      q.recordAudit(userId, 'group.rotation', String(targetId), group.rotation_enabled ? 'off' : 'on');
      return groupsHandler.showCampaignMenu(ctx, { chatId, messageId, targetChatId: targetId });
    }

    case 'rt': {
      q.toggleGroupCampaign(targetId, Number(args[1]));
      return groupsHandler.showCampaignMenu(ctx, { chatId, messageId, targetChatId: targetId });
    }

    case 'test': {
      const group = q.getGroup(targetId);
      if (!group) return groupsHandler.showGroupList(ctx, { chatId, messageId });
      const campaign = ctx.broadcaster.resolveCampaign(group);
      if (!campaign) {
        await answer(ctx, query.id, '⚠️ No enabled campaign to send.', true);
        return null;
      }
      await answer(ctx, query.id, '🚀 Sending test…');
      const result = await ctx.broadcaster.deliver({ group, campaign, trigger: 'test' });
      q.recordAudit(userId, 'group.test_send', String(targetId), campaign.name);
      await ctx.bot.sendMessage(
        chatId,
        result.status === 'sent'
          ? `✅ Test sent to <b>${esc(group.title || group.chat_id)}</b>.`
          : `❌ Test failed: ${esc(result.friendly || result.reason || 'unknown error')}`,
        { parse_mode: 'HTML' }
      );
      return groupsHandler.showGroupDetail(ctx, { chatId, messageId, targetChatId: targetId });
    }

    case 'perm': {
      const group = q.getGroup(targetId);
      if (!group) return groupsHandler.showGroupList(ctx, { chatId, messageId });
      await answer(ctx, query.id, '🔐 Checking…');
      const permission = await ctx.telegram.checkPostPermission(group.chat_id, ctx.botInfo?.id);
      if (permission.ok) q.clearGroupError(group.chat_id);
      else q.recordGroupError(group.chat_id, { code: permission.reason, message: permission.friendly, problem: true });
      await ctx.bot.sendMessage(chatId, `${permission.ok ? '✅' : '⚠️'} ${esc(permission.friendly)}`, { parse_mode: 'HTML' });
      return groupsHandler.showGroupDetail(ctx, { chatId, messageId, targetChatId: targetId });
    }

    case 'prev': {
      const group = q.getGroup(targetId);
      if (!group) return groupsHandler.showGroupList(ctx, { chatId, messageId });
      q.updateGroup(targetId, { delete_previous: group.delete_previous ? 0 : 1 });
      q.recordAudit(userId, 'group.delete_previous', String(targetId), group.delete_previous ? 'off' : 'on');
      return groupsHandler.showGroupDetail(ctx, { chatId, messageId, targetChatId: targetId });
    }

    case 'quiet':
      return groupsHandler.showQuietMenu(ctx, { chatId, messageId, targetChatId: targetId });

    case 'qtog': {
      const group = q.getGroup(targetId);
      if (!group) return groupsHandler.showGroupList(ctx, { chatId, messageId });
      q.updateGroup(targetId, { quiet_enabled: group.quiet_enabled ? 0 : 1 });
      rescheduleGroup(ctx, targetId);
      q.recordAudit(userId, 'group.quiet', String(targetId), group.quiet_enabled ? 'off' : 'on');
      return groupsHandler.showQuietMenu(ctx, { chatId, messageId, targetChatId: targetId });
    }

    case 'qs':
    case 'qe':
      ctx.sessions.set(userId, { type: action === 'qs' ? 'g_quiet_start' : 'g_quiet_end', chatId: targetId, panelChatId: chatId });
      return ctx.bot.sendMessage(chatId, `🕒 Send the quiet-hours ${action === 'qs' ? 'start' : 'end'} time as <code>HH:MM</code> (24h).`, { parse_mode: 'HTML' });

    case 'rm': {
      const group = q.getGroup(targetId);
      if (!group) return groupsHandler.showGroupList(ctx, { chatId, messageId });
      return renderPanel(ctx, {
        chatId,
        messageId,
        text: `⚠️ Remove <b>${esc(group.title || group.chat_id)}</b>?\n\nAdvertising in this group stops immediately.`,
        keyboard: [[button('✅ Confirm', cb('g', 'rmc', targetId)), button('❌ Cancel', cb('g', 'v', targetId))]],
      });
    }

    case 'rmc': {
      const group = q.getGroup(targetId);
      q.removeGroup(targetId);
      q.recordAudit(userId, 'group.remove', String(targetId), group?.title || '');
      await answer(ctx, query.id, '🗑 Group removed');
      return groupsHandler.showGroupList(ctx, { chatId, messageId });
    }

    default:
      return groupsHandler.showGroupList(ctx, { chatId, messageId });
  }
}

// ---------------------------------------------------------- campaign routes

async function routeCampaigns(ctx, { query, chatId, messageId, action, args, userId }) {
  const { q } = ctx;
  const campaignId = args[0] ? Number(args[0]) : null;

  switch (action) {
    case 'list':
      return campaignsHandler.showCampaignList(ctx, { chatId, messageId, page: Number(args[0] || 0) });

    case 'v':
      return campaignsHandler.showCampaignDetail(ctx, { chatId, messageId, campaignId });

    case 'default': {
      const { ensureDefaultCampaign } = require('../database/seed');
      const { campaign } = ensureDefaultCampaign(q, ctx.config, { logger: ctx.logger });
      return campaignsHandler.showCampaignDetail(ctx, { chatId, messageId, campaignId: campaign.id });
    }

    case 'new':
      ctx.sessions.set(userId, { type: 'c_new', panelChatId: chatId });
      return ctx.bot.sendMessage(chatId, '➕ Send a name for the new campaign.');

    case 'edit': {
      const field = args[1];
      const spec = campaignsHandler.EDIT_FIELDS[field];
      if (!spec) return campaignsHandler.showCampaignDetail(ctx, { chatId, messageId, campaignId });
      ctx.sessions.set(userId, { type: spec.session, campaignId, field, panelChatId: chatId });
      return ctx.bot.sendMessage(chatId, spec.prompt, { parse_mode: 'HTML', disable_web_page_preview: true });
    }

    case 'media':
      return campaignsHandler.showMediaMenu(ctx, { chatId, messageId, campaignId });

    case 'setmedia':
      ctx.sessions.set(userId, { type: 'c_media', campaignId, field: 'media', panelChatId: chatId });
      return ctx.bot.sendMessage(chatId, '📤 Send me a photo, video or GIF now. Its Telegram file_id will be stored and reused.');

    case 'clrmedia':
      q.updateCampaign(campaignId, { media_type: null, media_file_id: null });
      q.recordAudit(userId, 'campaign.media_cleared', String(campaignId));
      await answer(ctx, query.id, '🚫 Media removed');
      return campaignsHandler.showCampaignDetail(ctx, { chatId, messageId, campaignId });

    case 'btn':
      return campaignsHandler.showButtonMenu(ctx, { chatId, messageId, campaignId });

    case 'clrbtn':
      q.updateCampaign(campaignId, { button_text: null, button_url: null });
      q.recordAudit(userId, 'campaign.button_cleared', String(campaignId));
      await answer(ctx, query.id, '🚫 Button removed');
      return campaignsHandler.showCampaignDetail(ctx, { chatId, messageId, campaignId });

    case 'storeurl': {
      const { resolveStoreUrl } = require('../database/seed');
      const url = resolveStoreUrl(q, ctx.config);
      if (!url) {
        await answer(ctx, query.id, '⚠️ MAIN_STORE_BOT_URL is not configured.', true);
        return null;
      }
      q.updateCampaign(campaignId, { button_url: url, button_text: q.getCampaign(campaignId)?.button_text || '🛒 Open ACC STORE' });
      q.recordAudit(userId, 'campaign.button_url', String(campaignId), url);
      await answer(ctx, query.id, '🔗 Store URL applied');
      return campaignsHandler.showButtonMenu(ctx, { chatId, messageId, campaignId });
    }

    case 'lang':
      return campaignsHandler.showLanguageMenu(ctx, { chatId, messageId, campaignId });

    case 'setlang':
      q.updateCampaign(campaignId, { language: args[1] });
      q.recordAudit(userId, 'campaign.language', String(campaignId), args[1]);
      return campaignsHandler.showCampaignDetail(ctx, { chatId, messageId, campaignId });

    case 'prev': {
      const campaign = q.getCampaign(campaignId);
      if (!campaign) return campaignsHandler.showCampaignList(ctx, { chatId, messageId });
      await answer(ctx, query.id, '👁 Preview below');
      await campaignsHandler.sendPreview(ctx, { chatId, campaign, senderKind: args[1] || null });
      return null;
    }

    case 'tog': {
      const campaign = q.getCampaign(campaignId);
      if (!campaign) return campaignsHandler.showCampaignList(ctx, { chatId, messageId });
      q.updateCampaign(campaignId, { enabled: campaign.enabled ? 0 : 1 });
      q.recordAudit(userId, 'campaign.enabled', String(campaignId), campaign.enabled ? 'disabled' : 'enabled');
      return campaignsHandler.showCampaignDetail(ctx, { chatId, messageId, campaignId });
    }

    case 'def':
      q.setSetting('default_campaign_id', campaignId);
      q.recordAudit(userId, 'settings.default_campaign', String(campaignId));
      await answer(ctx, query.id, '⭐ Set as default');
      return campaignsHandler.showCampaignDetail(ctx, { chatId, messageId, campaignId });

    case 'rm': {
      const campaign = q.getCampaign(campaignId);
      if (!campaign) return campaignsHandler.showCampaignList(ctx, { chatId, messageId });
      return renderPanel(ctx, {
        chatId,
        messageId,
        text: `⚠️ Delete campaign <b>${esc(campaign.name)}</b>?\n\nGroups using it fall back to the default campaign.`,
        keyboard: [[button('✅ Confirm', cb('c', 'rmc', campaignId)), button('❌ Cancel', cb('c', 'v', campaignId))]],
      });
    }

    case 'rmc': {
      const campaign = q.getCampaign(campaignId);
      q.deleteCampaign(campaignId);
      q.recordAudit(userId, 'campaign.delete', String(campaignId), campaign?.name || '');
      await answer(ctx, query.id, '🗑 Campaign deleted');
      return campaignsHandler.showCampaignList(ctx, { chatId, messageId });
    }

    case 'save': {
      const session = ctx.sessions.get(userId);
      if (!session || !session.pending) {
        await answer(ctx, query.id, 'Nothing to save.', true);
        return null;
      }
      const { field, value, column } = session.pending;
      const fields = field === 'media' ? { media_type: value.type, media_file_id: value.fileId } : { [column]: value };
      q.updateCampaign(session.campaignId, fields);
      q.recordAudit(userId, `campaign.${field}`, String(session.campaignId));
      ctx.sessions.clear(userId);
      await answer(ctx, query.id, '✅ Saved');
      return campaignsHandler.showCampaignDetail(ctx, { chatId, messageId, campaignId: session.campaignId });
    }

    case 'cancel': {
      const session = ctx.sessions.get(userId);
      ctx.sessions.clear(userId);
      await answer(ctx, query.id, '❌ Cancelled');
      if (session?.campaignId) return campaignsHandler.showCampaignDetail(ctx, { chatId, messageId, campaignId: session.campaignId });
      return campaignsHandler.showCampaignList(ctx, { chatId, messageId });
    }

    default:
      return campaignsHandler.showCampaignList(ctx, { chatId, messageId });
  }
}

// ---------------------------------------------------------- settings routes

async function routeSettings(ctx, { query, chatId, messageId, action, args, userId }) {
  const { q } = ctx;

  switch (action) {
    case 'home':
      return settingsHandler.showSettings(ctx, { chatId, messageId });

    case 'interval':
      return settingsHandler.showDefaultIntervalMenu(ctx, { chatId, messageId });

    case 'si': {
      const value = policy.clampInterval(Number(args[0]), ctx.config);
      q.setSetting('default_interval_minutes', value);
      q.recordAudit(userId, 'settings.default_interval', null, `${value}m`);
      await answer(ctx, query.id, `⏱ ${formatInterval(value)}`);
      return settingsHandler.showDefaultIntervalMenu(ctx, { chatId, messageId });
    }

    case 'ic':
      ctx.sessions.set(userId, { type: 's_interval', panelChatId: chatId });
      return ctx.bot.sendMessage(chatId, `✏️ Send the default interval (e.g. <code>90</code>, <code>4h</code>, <code>2d</code>).\nMinimum: ${formatInterval(ctx.config.minIntervalMinutes)}`, { parse_mode: 'HTML' });

    case 'quiet':
      return settingsHandler.showQuietMenu(ctx, { chatId, messageId });

    case 'qtog': {
      const enabled = q.getSetting('quiet_enabled', '0') === '1';
      q.setSetting('quiet_enabled', enabled ? '0' : '1');
      q.recordAudit(userId, 'settings.quiet', null, enabled ? 'off' : 'on');
      return settingsHandler.showQuietMenu(ctx, { chatId, messageId });
    }

    case 'qs':
    case 'qe':
      ctx.sessions.set(userId, { type: action === 'qs' ? 's_quiet_start' : 's_quiet_end', panelChatId: chatId });
      return ctx.bot.sendMessage(chatId, `🕒 Send the global quiet-hours ${action === 'qs' ? 'start' : 'end'} time as <code>HH:MM</code> (24h).`, { parse_mode: 'HTML' });

    case 'tz':
      ctx.sessions.set(userId, { type: 's_tz', panelChatId: chatId });
      return ctx.bot.sendMessage(chatId, '🌐 Send the timezone name, e.g. <code>Asia/Baghdad</code>.', { parse_mode: 'HTML' });

    case 'url':
      ctx.sessions.set(userId, { type: 's_url', panelChatId: chatId });
      return ctx.bot.sendMessage(chatId, '🤖 Send the main ACC STORE bot URL, e.g. <code>https://t.me/YourStoreBot</code>.', { parse_mode: 'HTML' });

    case 'defcam':
      return settingsHandler.showDefaultCampaignMenu(ctx, { chatId, messageId, page: Number(args[0] || 0) });

    case 'sdc':
      q.setSetting('default_campaign_id', Number(args[0]));
      q.recordAudit(userId, 'settings.default_campaign', args[0]);
      await answer(ctx, query.id, '⭐ Default campaign set');
      return settingsHandler.showDefaultCampaignMenu(ctx, { chatId, messageId });

    case 'pause': {
      const paused = q.isPaused();
      q.setPaused(!paused);
      q.recordAudit(userId, 'settings.pause', null, paused ? 'resumed' : 'paused');
      await answer(ctx, query.id, paused ? '▶️ Advertising resumed' : '⏸ Advertising paused');
      return settingsHandler.showSettings(ctx, { chatId, messageId });
    }

    case 'audit':
      return settingsHandler.showAuditLog(ctx, { chatId, messageId });

    default:
      return settingsHandler.showSettings(ctx, { chatId, messageId });
  }
}

// ---------------------------------------------------------- send-now routes

async function routeSendNow(ctx, { query, chatId, messageId, action, args, userId }) {
  const { q } = ctx;
  const campaignId = args[0] ? Number(args[0]) : null;

  switch (action) {
    case 'home':
      ctx.sessions.clear(userId);
      return sendNowHandler.showCampaignPicker(ctx, { chatId, messageId, page: Number(args[0] || 0) });

    case 'c':
      return sendNowHandler.showTargetMenu(ctx, { chatId, messageId, campaignId });

    case 'one':
      return sendNowHandler.showGroupPicker(ctx, { chatId, messageId, campaignId, page: Number(args[1] || 0) });

    case 'og': {
      const group = q.getGroup(Number(args[1]));
      const campaign = q.getCampaign(campaignId);
      if (!group || !campaign) {
        await answer(ctx, query.id, '⚠️ Group or campaign missing.', true);
        return sendNowHandler.showTargetMenu(ctx, { chatId, messageId, campaignId });
      }
      await answer(ctx, query.id, '🚀 Sending…');
      const result = await ctx.broadcaster.deliver({ group, campaign, trigger: 'manual' });
      q.recordAudit(userId, 'broadcast.one', String(group.chat_id), campaign.name);
      await ctx.bot.sendMessage(
        chatId,
        result.status === 'sent'
          ? `✅ Sent to <b>${esc(group.title || group.chat_id)}</b>.`
          : `❌ Failed: ${esc(result.friendly || result.reason || 'unknown error')}`,
        { parse_mode: 'HTML' }
      );
      return sendNowHandler.showTargetMenu(ctx, { chatId, messageId, campaignId });
    }

    case 'sel': {
      const session = ctx.sessions.get(userId);
      const selected = session?.type === 'n_select' && session.campaignId === campaignId ? session.selected : [];
      ctx.sessions.set(userId, { type: 'n_select', campaignId, selected, panelChatId: chatId });
      return sendNowHandler.showMultiSelect(ctx, { chatId, messageId, campaignId, page: Number(args[1] || 0), selected });
    }

    case 'tg': {
      const session = ctx.sessions.get(userId);
      const current = session?.type === 'n_select' ? session.selected : [];
      const target = Number(args[1]);
      const selected = current.includes(target) ? current.filter((id) => id !== target) : [...current, target];
      ctx.sessions.set(userId, { type: 'n_select', campaignId, selected, panelChatId: chatId });
      return sendNowHandler.showMultiSelect(ctx, { chatId, messageId, campaignId, selected });
    }

    case 'seld': {
      const session = ctx.sessions.get(userId);
      const selected = session?.type === 'n_select' ? session.selected : [];
      if (!selected.length) {
        await answer(ctx, query.id, '⚠️ Select at least one group.', true);
        return null;
      }
      const targets = selected.map((id) => q.getGroup(id)).filter(Boolean);
      return sendNowHandler.showConfirm(ctx, { chatId, messageId, campaignId, targets, mode: 'sel' });
    }

    case 'all': {
      const targets = q.listEnabledGroups();
      if (!targets.length) {
        await answer(ctx, query.id, '⚠️ No enabled groups.', true);
        return null;
      }
      return sendNowHandler.showConfirm(ctx, { chatId, messageId, campaignId, targets, mode: 'all' });
    }

    case 'go': {
      const mode = args[1];
      const campaign = q.getCampaign(campaignId);
      if (!campaign) {
        await answer(ctx, query.id, '⚠️ Campaign missing.', true);
        return sendNowHandler.showCampaignPicker(ctx, { chatId, messageId });
      }
      let targets;
      if (mode === 'all') {
        targets = q.listEnabledGroups();
      } else {
        const session = ctx.sessions.get(userId);
        targets = (session?.type === 'n_select' ? session.selected : []).map((id) => q.getGroup(id)).filter(Boolean);
      }
      if (!targets.length) {
        await answer(ctx, query.id, '⚠️ No target groups.', true);
        return null;
      }

      await answer(ctx, query.id, `🚀 Sending to ${targets.length} groups…`);
      const progress = await ctx.bot.sendMessage(chatId, `📤 Sending to ${targets.length} groups…`);
      const results = await ctx.broadcaster.broadcast({ groups: targets, campaignFor: campaign, trigger: 'manual' });
      ctx.sessions.clear(userId);
      q.recordAudit(userId, `broadcast.${mode}`, `${targets.length} groups`, campaign.name);

      await ctx.bot.editMessageText(sendNowHandler.formatResults(results), {
        chat_id: chatId,
        message_id: progress.message_id,
        parse_mode: 'HTML',
      }).catch(() => ctx.bot.sendMessage(chatId, sendNowHandler.formatResults(results), { parse_mode: 'HTML' }));

      return sendNowHandler.showTargetMenu(ctx, { chatId, messageId, campaignId });
    }

    default:
      return sendNowHandler.showCampaignPicker(ctx, { chatId, messageId });
  }
}

// ------------------------------------------------------- sender/import routes

async function routeSender(ctx, { query, chatId, messageId, action, args, userId }) {
  switch (action) {
    case 'home':
      return senderHandler.showSenderPanel(ctx, { chatId, messageId });

    case 'rc': {
      if (!ctx.userSender) {
        await answer(ctx, query.id, '⚠️ User sender is not configured.', true);
        return null;
      }
      await answer(ctx, query.id, '🔄 Reconnecting…');
      const status = await ctx.userSender.reconnect();
      ctx.q.recordAudit(userId, 'sender.reconnect', null, status.status);
      return senderHandler.showSenderPanel(ctx, {
        chatId,
        messageId,
        note: status.connected ? '✅ Reconnected.' : `⚠️ ${esc(status.reason || 'Could not connect.')}`,
      });
    }

    case 'cs': {
      if (!ctx.userSender) {
        await answer(ctx, query.id, '⚠️ User sender is not configured.', true);
        return null;
      }
      await answer(ctx, query.id, '🔐 Checking…');
      const result = await ctx.userSender.checkSession();
      // Refresh the joined-group count while we are connected anyway.
      if (result.ok) {
        const groups = await ctx.userSender.listGroups({ limit: 300 });
        if (groups.ok) {
          ctx.senderCache = { ...(ctx.senderCache || {}), joinedGroups: groups.groups.length + groups.hidden, fetchedAt: new Date().toISOString() };
        }
      }
      ctx.q.recordAudit(userId, 'sender.check_session', null, result.ok ? 'ok' : 'failed');
      return senderHandler.showSenderPanel(ctx, {
        chatId,
        messageId,
        note: result.ok ? '✅ Session is valid.' : `⚠️ ${esc(result.reason || 'Session check failed.')}`,
      });
    }

    case 'imp':
      return senderHandler.showImportList(ctx, { chatId, messageId, userId, page: Number(args[0] || 0) });

    case 'ref':
      await answer(ctx, query.id, '🔄 Refreshing…');
      return senderHandler.showImportList(ctx, { chatId, messageId, userId, page: 0, force: true });

    case 't': {
      const page = Number(args[0] || 0);
      const index = Number(args[1]);
      const session = ctx.sessions.get(userId);
      if (!session || session.type !== senderHandler.SESSION_TYPE) {
        return senderHandler.showImportList(ctx, { chatId, messageId, userId, page });
      }
      const dialog = session.dialogs[index];
      // Already-registered groups are shown as done and are not selectable.
      if (dialog && ctx.q.getGroup(dialog.chatId)) {
        await answer(ctx, query.id, 'Already registered.');
        return null;
      }
      const selected = session.selected || [];
      const next = selected.includes(index) ? selected.filter((i) => i !== index) : [...selected, index];
      ctx.sessions.patch(userId, { selected: next });
      return senderHandler.showImportList(ctx, { chatId, messageId, userId, page });
    }

    case 'clr':
      ctx.sessions.patch(userId, { selected: [] });
      return senderHandler.showImportList(ctx, { chatId, messageId, userId, page: 0 });

    case 'add': {
      await answer(ctx, query.id, '⏳ Verifying and adding…');
      const result = await senderHandler.addSelectedGroups(ctx, userId);
      return senderHandler.showSenderPanel(ctx, { chatId, messageId, note: result.note });
    }

    default:
      return senderHandler.showSenderPanel(ctx, { chatId, messageId });
  }
}

// ----------------------------------------------------------- input handling

/** Handles the admin's reply to a pending "send me a value" prompt. */
async function handleSessionInput(ctx, msg, session) {
  const { q } = ctx;
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text ?? msg.caption ?? '';

  const fail = (message) => ctx.bot.sendMessage(chatId, `⚠️ ${message}\n\nSend a new value or /cancel.`);

  switch (session.type) {
    case 'c_new': {
      const check = campaignsHandler.validateFieldValue('name', text);
      if (!check.ok) return fail(check.error);
      const campaign = q.createCampaign({ name: check.value, text: '', enabled: 0 });
      q.recordAudit(userId, 'campaign.create', String(campaign.id), check.value);
      ctx.sessions.clear(userId);
      await ctx.bot.sendMessage(chatId, `✅ Campaign <b>${esc(check.value)}</b> created (disabled until you add content).`, { parse_mode: 'HTML' });
      return campaignsHandler.showCampaignDetail(ctx, { chatId, campaignId: campaign.id });
    }

    case 'c_name':
    case 'c_text':
    case 'c_btxt':
    case 'c_burl': {
      const field = session.field;
      const campaign = q.getCampaign(session.campaignId);
      if (!campaign) {
        ctx.sessions.clear(userId);
        return fail('That campaign no longer exists.');
      }
      const check = campaignsHandler.validateFieldValue(field, text, campaign);
      if (!check.ok) return fail(check.error);

      const spec = campaignsHandler.EDIT_FIELDS[field];
      ctx.sessions.patch(userId, { pending: { field, value: check.value, column: spec.column } });

      if (!spec.preview) {
        return ctx.bot.sendMessage(chatId, `New value:\n<b>${esc(check.value)}</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: SAVE_KEYBOARD } });
      }
      const preview = campaignsHandler.withPending(campaign, field, check.value);
      await campaignsHandler.sendPreview(ctx, { chatId, campaign: preview, header: '👁 <b>Preview</b> (not saved yet)' });
      return ctx.bot.sendMessage(chatId, 'Save this change?', { reply_markup: { inline_keyboard: SAVE_KEYBOARD } });
    }

    case 'c_media': {
      const media = extractMedia(msg);
      if (!media) return fail('That is not a photo, video or GIF.');
      const campaign = q.getCampaign(session.campaignId);
      if (!campaign) {
        ctx.sessions.clear(userId);
        return fail('That campaign no longer exists.');
      }
      ctx.sessions.patch(userId, { pending: { field: 'media', value: media, column: null } });
      const preview = campaignsHandler.withPending(campaign, 'media', media);
      await campaignsHandler.sendPreview(ctx, { chatId, campaign: preview, header: '👁 <b>Preview</b> (not saved yet)' });
      return ctx.bot.sendMessage(chatId, 'Save this media?', { reply_markup: { inline_keyboard: SAVE_KEYBOARD } });
    }

    case 'g_interval': {
      const minutes = parseIntervalInput(text);
      if (!minutes) return fail('Could not read that interval. Try 90, 4h or 2d.');
      if (minutes < ctx.config.minIntervalMinutes) return fail(`Minimum interval is ${formatInterval(ctx.config.minIntervalMinutes)}.`);
      q.updateGroup(session.chatId, { interval_minutes: minutes });
      rescheduleGroup(ctx, session.chatId);
      q.recordAudit(userId, 'group.interval', String(session.chatId), `${minutes}m`);
      ctx.sessions.clear(userId);
      await ctx.bot.sendMessage(chatId, `✅ Interval set to ${formatInterval(minutes)}.`);
      return groupsHandler.showGroupDetail(ctx, { chatId, targetChatId: session.chatId });
    }

    case 'g_quiet_start':
    case 'g_quiet_end': {
      if (parseHHMM(text) === null) return fail('Use 24-hour HH:MM, e.g. 08:30.');
      const column = session.type === 'g_quiet_start' ? 'quiet_start' : 'quiet_end';
      q.updateGroup(session.chatId, { [column]: text.trim() });
      rescheduleGroup(ctx, session.chatId);
      q.recordAudit(userId, 'group.quiet_hours', String(session.chatId), `${column}=${text.trim()}`);
      ctx.sessions.clear(userId);
      return groupsHandler.showQuietMenu(ctx, { chatId, targetChatId: session.chatId });
    }

    case 's_interval': {
      const minutes = parseIntervalInput(text);
      if (!minutes) return fail('Could not read that interval. Try 90, 4h or 2d.');
      if (minutes < ctx.config.minIntervalMinutes) return fail(`Minimum interval is ${formatInterval(ctx.config.minIntervalMinutes)}.`);
      q.setSetting('default_interval_minutes', minutes);
      q.recordAudit(userId, 'settings.default_interval', null, `${minutes}m`);
      ctx.sessions.clear(userId);
      await ctx.bot.sendMessage(chatId, `✅ Default interval set to ${formatInterval(minutes)}.`);
      return settingsHandler.showSettings(ctx, { chatId });
    }

    case 's_quiet_start':
    case 's_quiet_end': {
      if (parseHHMM(text) === null) return fail('Use 24-hour HH:MM, e.g. 08:30.');
      q.setSetting(session.type === 's_quiet_start' ? 'quiet_start' : 'quiet_end', text.trim());
      q.recordAudit(userId, 'settings.quiet_hours', null, text.trim());
      ctx.sessions.clear(userId);
      return settingsHandler.showQuietMenu(ctx, { chatId });
    }

    case 's_tz': {
      const timezone = text.trim();
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
      } catch (_) {
        return fail('Unknown timezone. Use an IANA name such as Asia/Baghdad.');
      }
      q.setSetting('timezone', timezone);
      q.recordAudit(userId, 'settings.timezone', null, timezone);
      ctx.sessions.clear(userId);
      await ctx.bot.sendMessage(chatId, `✅ Timezone set to ${esc(timezone)}.`, { parse_mode: 'HTML' });
      return settingsHandler.showSettings(ctx, { chatId });
    }

    case 's_url': {
      const url = validateUrl(text);
      if (!url.ok) return fail(url.error);
      q.setSetting('main_store_bot_url', url.url);
      q.recordAudit(userId, 'settings.store_url', null, url.url);
      ctx.sessions.clear(userId);
      await ctx.bot.sendMessage(chatId, '✅ Main store bot URL updated.');
      return settingsHandler.showSettings(ctx, { chatId });
    }

    default:
      ctx.sessions.clear(userId);
      return null;
  }
}

// -------------------------------------------------------------- registration

async function routeCallback(ctx, query) {
  const userId = query.from?.id;
  if (!isAdmin(userId, ctx.config)) {
    await answer(ctx, query.id, NON_ADMIN_REPLY, true);
    return null;
  }
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const { namespace, action, args } = parseCallback(query.data);
  const params = { query, chatId, messageId, action, args, userId };

  switch (namespace) {
    case 'home':
      await answer(ctx, query.id);
      return startHandler.showHome(ctx, { chatId, messageId });
    case 'g': {
      const result = await routeGroups(ctx, params);
      await answer(ctx, query.id);
      return result;
    }
    case 'c': {
      const result = await routeCampaigns(ctx, params);
      await answer(ctx, query.id);
      return result;
    }
    case 's': {
      const result = await routeSettings(ctx, params);
      await answer(ctx, query.id);
      return result;
    }
    case 'n': {
      const result = await routeSendNow(ctx, params);
      await answer(ctx, query.id);
      return result;
    }
    case 'sndr': {
      const result = await routeSender(ctx, params);
      await answer(ctx, query.id);
      return result;
    }
    case 'st': {
      await answer(ctx, query.id);
      return action === 'recent' ? statsHandler.showRecent(ctx, { chatId, messageId }) : statsHandler.showStats(ctx, { chatId, messageId });
    }
    default:
      await answer(ctx, query.id);
      return null;
  }
}

function register(ctx) {
  const { bot } = ctx;

  // The promise is returned (not just fired) so callers can await completion.
  bot.on('callback_query', (query) =>
    routeCallback(ctx, query).catch((error) => {
      ctx.logger.error(`callback "${query?.data}" failed: ${error.message}`);
      return answer(ctx, query.id, '⚠️ Something went wrong.', true).catch(() => {});
    })
  );

  bot.on('message', (msg) => {
    // Admin input flows are private-chat only and never touch group traffic.
    if (msg.chat?.type !== 'private') return;
    if (!isAdmin(msg.from?.id, ctx.config)) return;
    if (typeof msg.text === 'string' && msg.text.startsWith('/')) return;

    const session = ctx.sessions.get(msg.from.id);
    if (!session || session.type === 'n_select' || session.type === senderHandler.SESSION_TYPE) return;

    return handleSessionInput(ctx, msg, session).catch((error) => {
      ctx.logger.error(`input (${session.type}) failed: ${error.message}`);
      return ctx.bot.sendMessage(msg.chat.id, '⚠️ Could not process that input.').catch(() => {});
    });
  });

  // Anyone who is not an admin gets one neutral line and nothing else.
  bot.on('message', (msg) => {
    if (msg.chat?.type !== 'private') return;
    if (isAdmin(msg.from?.id, ctx.config)) return;
    if (typeof msg.text === 'string' && /^\/(start|status|help)/.test(msg.text)) return;
    return ctx.bot.sendMessage(msg.chat.id, NON_ADMIN_REPLY).catch(() => {});
  });
}

module.exports = { register, routeCallback, handleSessionInput, rescheduleGroup, extractMedia };
