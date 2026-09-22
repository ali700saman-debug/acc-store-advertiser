'use strict';

/**
 * Campaign management: create, edit (text / media / button / language),
 * preview and enable/disable — all from inside Telegram, no redeploy needed.
 */

const { cb, button } = require('../utils/keyboard');
const { renderPanel, esc, paginate, pagerRow, campaignLabel } = require('./common');
const { validateTelegramHtml, lengthLimitFor, truncate, validateUrl } = require('../utils/html');
const { formatDateTime } = require('../utils/time');
const policy = require('../services/policy');

const LANGUAGES = ['en', 'ar', 'vi', 'es', 'ckb', 'mixed'];

/** Fields that go through the "send value -> preview -> save" flow. */
const EDIT_FIELDS = {
  name: { session: 'c_name', column: 'name', prompt: 'Send me the new campaign name.', preview: false },
  text: { session: 'c_text', column: 'text', prompt: 'Send me the new advertisement text.\n\nHTML formatting is supported: <b>bold</b>, <i>italic</i>, <a href="https://example.com">link</a>.', preview: true },
  btxt: { session: 'c_btxt', column: 'button_text', prompt: 'Send me the new button text.', preview: true },
  burl: { session: 'c_burl', column: 'button_url', prompt: 'Send me the new button URL (must start with https:// or tg://).', preview: true },
};

function mediaSummary(campaign) {
  if (!campaign.media_file_id) return 'None';
  const label = { photo: '🖼 Photo', video: '🎬 Video', animation: '🎞 GIF' }[campaign.media_type] || campaign.media_type;
  return `${label} (<code>${esc(truncate(campaign.media_file_id, 18))}</code>)`;
}

// ------------------------------------------------------------------- views

async function showCampaignList(ctx, { chatId, messageId, page = 0 }) {
  const campaigns = ctx.q.listCampaigns();
  const defaultId = Number(ctx.q.getSetting('default_campaign_id'));

  if (!campaigns.length) {
    return renderPanel(ctx, {
      chatId,
      messageId,
      text: ['📣 <b>Campaigns</b>', '', 'No campaigns yet.'].join('\n'),
      keyboard: [[button('➕ Create Campaign', cb('c', 'new'))], [button('⬅️ Back', cb('home', 'open'))]],
    });
  }

  const pagination = paginate(campaigns, page, 8);
  const keyboard = pagination.items.map((campaign) => [
    button(`${campaign.id === defaultId ? '⭐ ' : ''}${campaignLabel(campaign)}`, cb('c', 'v', campaign.id)),
  ]);
  const pager = pagerRow(pagination, (p) => cb('c', 'list', p));
  if (pager) keyboard.push(pager);
  keyboard.push([button('➕ Create Campaign', cb('c', 'new'))]);
  keyboard.push([button('⬅️ Back', cb('home', 'open'))]);

  const text = [
    `📣 <b>Campaigns</b> (${campaigns.length})`,
    '',
    `✅ Active: ${ctx.q.countEnabledCampaigns()}`,
    '⭐ marks the global default campaign.',
  ].join('\n');

  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

async function showCampaignDetail(ctx, { chatId, messageId, campaignId }) {
  const campaign = ctx.q.getCampaign(campaignId);
  if (!campaign) {
    return renderPanel(ctx, { chatId, messageId, text: '⚠️ Campaign not found.', keyboard: [[button('⬅️ Back', cb('c', 'list', '0'))]] });
  }
  const timezone = policy.getTimezone(ctx.q, ctx.config);
  const isDefault = String(campaign.id) === String(ctx.q.getSetting('default_campaign_id'));

  const text = [
    `📣 <b>${esc(campaign.name)}</b>${isDefault ? ' ⭐' : ''}`,
    '',
    `📊 Status: ${campaign.enabled ? 'Enabled' : 'Disabled'}`,
    `🌐 Language label: ${esc(campaign.language)}`,
    `🖼 Media: ${mediaSummary(campaign)}`,
    `🔘 Button: ${campaign.button_text ? `${esc(campaign.button_text)} → ${esc(truncate(campaign.button_url || '', 40))}` : 'None'}`,
    `✏️ Text length: ${campaign.text.length}/${lengthLimitFor(campaign.media_file_id ? campaign.media_type : null)}`,
    `🕒 Updated: ${formatDateTime(campaign.updated_at, timezone)}`,
  ].join('\n');

  const keyboard = [
    [button('📝 Edit Text', cb('c', 'edit', campaign.id, 'text')), button('🏷 Rename', cb('c', 'edit', campaign.id, 'name'))],
    [button('🖼 Change Media', cb('c', 'media', campaign.id)), button('🔘 Change Button', cb('c', 'btn', campaign.id))],
    [button('👁 Preview', cb('c', 'prev', campaign.id)), button('🚀 Send Now', cb('n', 'c', campaign.id))],
    [button(campaign.enabled ? '⛔ Disable' : '✅ Enable', cb('c', 'tog', campaign.id)), button('🌐 Language', cb('c', 'lang', campaign.id))],
    [button(isDefault ? '⭐ Default campaign' : '☆ Make default', cb('c', 'def', campaign.id)), button('🗑 Delete', cb('c', 'rm', campaign.id))],
    [button('⬅️ Back', cb('c', 'list', '0'))],
  ];

  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

async function showMediaMenu(ctx, { chatId, messageId, campaignId }) {
  const campaign = ctx.q.getCampaign(campaignId);
  if (!campaign) return showCampaignList(ctx, { chatId, messageId });
  const text = [
    `🖼 <b>Media</b> — ${esc(campaign.name)}`,
    '',
    `Current: ${mediaSummary(campaign)}`,
    '',
    'Send a photo, video or GIF to attach it. The Telegram file_id is stored and reused — nothing is downloaded or re-uploaded.',
    '',
    `⚠️ With media attached the caption limit is ${lengthLimitFor('photo')} characters.`,
  ].join('\n');
  const keyboard = [
    [button('📤 Send new media', cb('c', 'setmedia', campaign.id))],
    campaign.media_file_id ? [button('🚫 Remove media', cb('c', 'clrmedia', campaign.id))] : null,
    [button('⬅️ Back', cb('c', 'v', campaign.id))],
  ].filter(Boolean);
  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

async function showButtonMenu(ctx, { chatId, messageId, campaignId }) {
  const campaign = ctx.q.getCampaign(campaignId);
  if (!campaign) return showCampaignList(ctx, { chatId, messageId });
  const text = [
    `🔘 <b>Button</b> — ${esc(campaign.name)}`,
    '',
    `Text: ${campaign.button_text ? esc(campaign.button_text) : '—'}`,
    `URL: ${campaign.button_url ? esc(campaign.button_url) : '—'}`,
    '',
    'Both must be set for the button to appear.',
  ].join('\n');
  const keyboard = [
    [button('✏️ Button text', cb('c', 'edit', campaign.id, 'btxt')), button('🔗 Button URL', cb('c', 'edit', campaign.id, 'burl'))],
    [button('🏪 Use main store URL', cb('c', 'storeurl', campaign.id))],
    campaign.button_text || campaign.button_url ? [button('🚫 Remove button', cb('c', 'clrbtn', campaign.id))] : null,
    [button('⬅️ Back', cb('c', 'v', campaign.id))],
  ].filter(Boolean);
  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

async function showLanguageMenu(ctx, { chatId, messageId, campaignId }) {
  const campaign = ctx.q.getCampaign(campaignId);
  if (!campaign) return showCampaignList(ctx, { chatId, messageId });
  const buttons = LANGUAGES.map((code) => button(`${campaign.language === code ? '• ' : ''}${code}`, cb('c', 'setlang', campaign.id, code)));
  const keyboard = [buttons.slice(0, 3), buttons.slice(3), [button('⬅️ Back', cb('c', 'v', campaign.id))]];
  const text = [
    `🌐 <b>Language label</b> — ${esc(campaign.name)}`,
    '',
    'This is only a label for your own organisation. Your advertisement text is never translated automatically.',
  ].join('\n');
  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

/**
 * Renders the campaign exactly as groups will see it, through the same send
 * path used for real broadcasts.
 */
async function sendPreview(ctx, { chatId, campaign, header = '👁 <b>Preview</b>' }) {
  await ctx.bot.sendMessage(chatId, header, { parse_mode: 'HTML' });
  try {
    await ctx.telegram.sendCampaign(chatId, campaign);
    return { ok: true };
  } catch (error) {
    const info = error.classified || {};
    await ctx.bot.sendMessage(chatId, `⚠️ Preview failed: ${esc(info.friendly || error.message)}`, { parse_mode: 'HTML' });
    return { ok: false, error: info };
  }
}

/** Validates an incoming value for a campaign field. */
function validateFieldValue(field, value, campaign) {
  if (field === 'name') {
    const name = String(value).trim();
    if (!name) return { ok: false, error: 'Name cannot be empty.' };
    if (name.length > 64) return { ok: false, error: 'Name must be 64 characters or fewer.' };
    return { ok: true, value: name };
  }
  if (field === 'text') {
    const text = String(value);
    const limit = lengthLimitFor(campaign?.media_file_id ? campaign.media_type : null);
    if (text.length > limit) return { ok: false, error: `Too long: ${text.length}/${limit} characters.` };
    const html = validateTelegramHtml(text);
    if (!html.ok) return { ok: false, error: html.error };
    return { ok: true, value: text };
  }
  if (field === 'btxt') {
    const text = String(value).trim();
    if (!text) return { ok: false, error: 'Button text cannot be empty.' };
    if (text.length > 64) return { ok: false, error: 'Button text must be 64 characters or fewer.' };
    return { ok: true, value: text };
  }
  if (field === 'burl') {
    const url = validateUrl(value);
    if (!url.ok) return { ok: false, error: url.error };
    return { ok: true, value: url.url };
  }
  return { ok: false, error: 'Unknown field.' };
}

/** Campaign row with a pending edit applied, for previewing before saving. */
function withPending(campaign, field, value) {
  const copy = { ...campaign };
  if (field === 'text') copy.text = value;
  else if (field === 'name') copy.name = value;
  else if (field === 'btxt') copy.button_text = value;
  else if (field === 'burl') copy.button_url = value;
  else if (field === 'media') {
    copy.media_type = value.type;
    copy.media_file_id = value.fileId;
  }
  return copy;
}

const SAVE_KEYBOARD = [[button('✅ Save', cb('c', 'save')), button('❌ Cancel', cb('c', 'cancel'))]];

module.exports = {
  showCampaignList,
  showCampaignDetail,
  showMediaMenu,
  showButtonMenu,
  showLanguageMenu,
  sendPreview,
  validateFieldValue,
  withPending,
  mediaSummary,
  EDIT_FIELDS,
  LANGUAGES,
  SAVE_KEYBOARD,
};
