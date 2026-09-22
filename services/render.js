'use strict';

/**
 * Renders a campaign for a specific delivery channel.
 *
 * The bot and the MTProto user account are not equivalent:
 *
 *  - A BOT may attach an inline keyboard (`reply_markup`) to a message, so the
 *    campaign button renders as a real tappable button.
 *  - A normal USER ACCOUNT may not. In MTProto, `reply_markup` on
 *    messages.sendMessage is only honoured for bot accounts; the server
 *    rejects or ignores it for regular users. There is no legitimate way to
 *    fake a bot-style button from a user account, so instead the campaign's
 *    link is appended to the message body as visible, auto-linked text.
 *
 * The admin preview uses this same function, so what the admin sees is exactly
 * what the target group receives.
 */

const { escapeHtml, lengthLimitFor } = require('../utils/html');

const SENDER_BOT = 'bot';
const SENDER_USER = 'user';

const DEFAULT_LINK_LABEL = '🛒 Buy here:';

/** True when this campaign has a usable button definition. */
function hasButton(campaign) {
  return Boolean(campaign?.button_text && campaign?.button_url);
}

/**
 * The visible link block appended for user-account sends.
 * Label is escaped (it is admin-authored); the URL is left raw so Telegram
 * auto-links it.
 */
function buildLinkSuffix(campaign, { storeUrl = null, parseMode = 'HTML' } = {}) {
  const url = campaign?.button_url || storeUrl;
  if (!url) return '';
  const rawLabel = campaign?.button_text || DEFAULT_LINK_LABEL;
  const label = parseMode === 'HTML' ? escapeHtml(rawLabel) : rawLabel;
  const separator = label.trim().endsWith(':') ? '\n' : ':\n';
  return `\n\n${label}${separator}${url}`;
}

/**
 * Fits body + suffix inside Telegram's limit by trimming the BODY only —
 * the link is the point of the advertisement and is never truncated.
 */
function fitWithinLimit(body, suffix, limit) {
  if (body.length + suffix.length <= limit) return `${body}${suffix}`;
  const room = limit - suffix.length;
  if (room <= 0) return suffix.trimStart().slice(0, limit);
  // Trim to the last whitespace so a tag or word is not cut mid-way.
  let trimmed = body.slice(0, room);
  const lastBreak = trimmed.lastIndexOf('\n');
  const lastSpace = trimmed.lastIndexOf(' ');
  const cut = Math.max(lastBreak, lastSpace);
  if (cut > room * 0.6) trimmed = trimmed.slice(0, cut);
  return `${trimmed.trimEnd()}${suffix}`;
}

/**
 * Builds the delivery plan for a campaign.
 *
 * Returns { ok, error } on failure, otherwise:
 *   { ok, senderKind, mediaType, mediaFileId, mediaLocalPath,
 *     text, parseMode, buttons, linkAppended }
 */
function renderCampaign(campaign, { senderKind = SENDER_BOT, storeUrl = null } = {}) {
  const body = String(campaign?.text ?? '');
  const mediaType = campaign?.media_file_id || campaign?.media_local_path ? campaign.media_type : null;

  if (!body.trim() && !mediaType) {
    return { ok: false, error: 'EMPTY_CAMPAIGN' };
  }

  const parseMode = campaign?.parse_mode || 'HTML';
  const limit = lengthLimitFor(mediaType);
  const asUser = senderKind === SENDER_USER;

  // A user account cannot render an inline button, so the link goes inline
  // in the text instead. A bot keeps the real button and needs no suffix.
  const suffix = asUser ? buildLinkSuffix(campaign, { storeUrl, parseMode }) : '';
  const text = suffix ? fitWithinLimit(body, suffix, limit) : body.slice(0, limit);

  return {
    ok: true,
    senderKind,
    mediaType,
    mediaFileId: campaign?.media_file_id || null,
    mediaLocalPath: campaign?.media_local_path || null,
    text,
    parseMode,
    buttons: !asUser && hasButton(campaign)
      ? [[{ text: String(campaign.button_text), url: String(campaign.button_url) }]]
      : null,
    linkAppended: Boolean(suffix),
  };
}

/** Human-readable note for the admin preview screen. */
function previewNote(senderKind) {
  return senderKind === SENDER_USER
    ? 'Sent by the USER ACCOUNT. Normal Telegram accounts cannot attach inline buttons, so the link is appended as visible text.'
    : 'Sent by the BOT. Inline button is supported.';
}

module.exports = { renderCampaign, buildLinkSuffix, fitWithinLimit, hasButton, previewNote, SENDER_BOT, SENDER_USER, DEFAULT_LINK_LABEL };
