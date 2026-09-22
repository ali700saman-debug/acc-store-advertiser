'use strict';

/**
 * Thin, testable wrapper around node-telegram-bot-api.
 *
 * Responsibilities:
 *  - render a campaign row into the right Telegram send call
 *  - classify Telegram errors into stable, actionable reason codes
 *  - honour 429 retry_after without ever looping forever
 */

const { makeLogger } = require('../utils/logger');
const { lengthLimitFor } = require('../utils/html');

const REASONS = {
  BOT_REMOVED: 'BOT_REMOVED',
  NO_PERMISSION: 'NO_PERMISSION',
  CHAT_NOT_FOUND: 'CHAT_NOT_FOUND',
  CHAT_MIGRATED: 'CHAT_MIGRATED',
  RATE_LIMITED: 'RATE_LIMITED',
  MEDIA_INVALID: 'MEDIA_INVALID',
  PARSE_ERROR: 'PARSE_ERROR',
  EMPTY_CAMPAIGN: 'EMPTY_CAMPAIGN',
  NETWORK: 'NETWORK',
  UNKNOWN: 'UNKNOWN',
};

const FRIENDLY = {
  [REASONS.BOT_REMOVED]: 'Bot was removed from the group',
  [REASONS.NO_PERMISSION]: 'Bot has no permission to send messages',
  [REASONS.CHAT_NOT_FOUND]: 'Chat not found',
  [REASONS.CHAT_MIGRATED]: 'Group was upgraded to a supergroup',
  [REASONS.RATE_LIMITED]: 'Rate limited by Telegram',
  [REASONS.MEDIA_INVALID]: 'Media file is no longer valid',
  [REASONS.PARSE_ERROR]: 'Message formatting (HTML) is invalid',
  [REASONS.EMPTY_CAMPAIGN]: 'Campaign has neither text nor media',
  [REASONS.NETWORK]: 'Network error contacting Telegram',
  [REASONS.UNKNOWN]: 'Unknown Telegram error',
};

/** Reasons where retrying the same group later is pointless until fixed. */
const PERMANENT = new Set([
  REASONS.BOT_REMOVED,
  REASONS.NO_PERMISSION,
  REASONS.CHAT_NOT_FOUND,
  REASONS.MEDIA_INVALID,
  REASONS.PARSE_ERROR,
  REASONS.EMPTY_CAMPAIGN,
]);

function responseBody(error) {
  return (error && error.response && error.response.body) || {};
}

/** Maps any thrown value into { reason, code, description, retryAfter, ... }. */
function classifyError(error) {
  const body = responseBody(error);
  const code = body.error_code ?? error?.code ?? null;
  const description = String(body.description || error?.message || 'Unknown error');
  const params = body.parameters || {};
  const lower = description.toLowerCase();

  const base = {
    code: code === null ? null : String(code),
    description,
    retryAfter: Number.isFinite(params.retry_after) ? Number(params.retry_after) : null,
    migrateToChatId: Number.isFinite(params.migrate_to_chat_id) ? Number(params.migrate_to_chat_id) : null,
  };

  let reason = REASONS.UNKNOWN;
  if (base.migrateToChatId) reason = REASONS.CHAT_MIGRATED;
  else if (code === 429 || base.retryAfter !== null) reason = REASONS.RATE_LIMITED;
  else if (/bot was kicked|bot is not a member|bot was blocked|chat member status is|user is deactivated|group chat was deactivated|bot can't initiate/.test(lower)) reason = REASONS.BOT_REMOVED;
  else if (/not enough rights|have no rights|chat_write_forbidden|not allowed to send|restricted|chat_send_.*_forbidden|topic_closed/.test(lower)) reason = REASONS.NO_PERMISSION;
  else if (/chat not found|peer_id_invalid|chat_id is empty/.test(lower)) reason = REASONS.CHAT_NOT_FOUND;
  else if (/wrong file identifier|wrong remote file|file_id|wrong type of the web page content|failed to get http url content/.test(lower)) reason = REASONS.MEDIA_INVALID;
  else if (/can't parse entities|unsupported start tag|unclosed start tag|can't find end tag/.test(lower)) reason = REASONS.PARSE_ERROR;
  else if (/etimedout|econnreset|enotfound|socket hang up|network|eai_again/.test(lower)) reason = REASONS.NETWORK;
  else if (code === 403) reason = REASONS.BOT_REMOVED;

  return { ...base, reason, permanent: PERMANENT.has(reason), friendly: FRIENDLY[reason] || FRIENDLY[REASONS.UNKNOWN] };
}

/** Builds the exact Telegram call for a campaign row. */
function buildCampaignMessage(campaign, { forcePlain = false } = {}) {
  const text = String(campaign?.text ?? '');
  const mediaType = campaign?.media_file_id ? campaign.media_type : null;
  if (!text.trim() && !mediaType) {
    return { error: REASONS.EMPTY_CAMPAIGN };
  }

  const options = {
    parse_mode: forcePlain ? undefined : campaign?.parse_mode || 'HTML',
  };

  if (campaign?.button_text && campaign?.button_url) {
    options.reply_markup = {
      inline_keyboard: [[{ text: String(campaign.button_text), url: String(campaign.button_url) }]],
    };
  }

  const limit = lengthLimitFor(mediaType);
  const body = text.length > limit ? text.slice(0, limit) : text;

  if (mediaType === 'photo') return { method: 'sendPhoto', fileId: campaign.media_file_id, options: { ...options, caption: body } };
  if (mediaType === 'video') return { method: 'sendVideo', fileId: campaign.media_file_id, options: { ...options, caption: body } };
  if (mediaType === 'animation') return { method: 'sendAnimation', fileId: campaign.media_file_id, options: { ...options, caption: body } };
  return { method: 'sendMessage', text: body, options: { ...options, disable_web_page_preview: true } };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createTelegramService({ bot, logger = makeLogger('Telegram'), sleep = defaultSleep, maxRetryAttempts = 2, maxRetryWaitSeconds = 60 } = {}) {
  const service = {};

  /**
   * Runs a Telegram call, retrying only on 429 (respecting retry_after) and
   * transient network errors. Attempts are hard-capped, so no infinite loops.
   */
  service.call = async (fn, { label = 'call' } = {}) => {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (error) {
        const info = classifyError(error);
        const retryable = info.reason === REASONS.RATE_LIMITED || info.reason === REASONS.NETWORK;
        if (!retryable || attempt >= maxRetryAttempts) {
          throw Object.assign(error, { classified: info });
        }
        const waitSeconds = Math.min(info.retryAfter ?? 2 ** attempt, maxRetryWaitSeconds);
        attempt += 1;
        logger.warn(`${label}: ${info.reason}, retrying in ${waitSeconds}s (attempt ${attempt}/${maxRetryAttempts})`);
        await sleep(waitSeconds * 1000);
      }
    }
  };

  /** Sends one campaign to one chat. Returns the Telegram message object. */
  service.sendCampaign = async (chatId, campaign) => {
    const plan = buildCampaignMessage(campaign);
    if (plan.error) {
      const error = new Error(FRIENDLY[plan.error]);
      error.classified = { reason: plan.error, code: null, description: FRIENDLY[plan.error], permanent: true, friendly: FRIENDLY[plan.error], retryAfter: null, migrateToChatId: null };
      throw error;
    }
    return service.call(
      () =>
        plan.method === 'sendMessage'
          ? bot.sendMessage(chatId, plan.text, plan.options)
          : bot[plan.method](chatId, plan.fileId, plan.options),
      { label: `${plan.method}->${chatId}` }
    );
  };

  /** Best-effort delete of our own previous advertisement. Never throws. */
  service.deleteMessage = async (chatId, messageId) => {
    if (!messageId) return false;
    try {
      await bot.deleteMessage(chatId, messageId);
      return true;
    } catch (error) {
      logger.warn(`deleteMessage ${chatId}/${messageId}: ${classifyError(error).friendly}`);
      return false;
    }
  };

  /**
   * Checks whether the bot may post in a chat. Returns
   * { ok, reason, friendly, chat }. Never throws.
   */
  service.checkPostPermission = async (chatId, botId) => {
    try {
      const chat = await service.call(() => bot.getChat(chatId), { label: `getChat->${chatId}` });
      if (!botId) return { ok: true, chat, reason: null, friendly: 'Permission unknown (bot id unavailable)' };
      const member = await service.call(() => bot.getChatMember(chatId, botId), { label: `getChatMember->${chatId}` });
      const status = member?.status;
      if (status === 'left' || status === 'kicked') {
        return { ok: false, chat, reason: REASONS.BOT_REMOVED, friendly: FRIENDLY[REASONS.BOT_REMOVED] };
      }
      if (status === 'restricted' && member.can_send_messages === false) {
        return { ok: false, chat, reason: REASONS.NO_PERMISSION, friendly: FRIENDLY[REASONS.NO_PERMISSION] };
      }
      return { ok: true, chat, reason: null, friendly: 'Can send messages' };
    } catch (error) {
      const info = classifyError(error);
      return { ok: false, chat: null, reason: info.reason, friendly: info.friendly };
    }
  };

  return service;
}

module.exports = { createTelegramService, classifyError, buildCampaignMessage, REASONS, FRIENDLY, PERMANENT };
