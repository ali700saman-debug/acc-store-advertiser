'use strict';

/**
 * Every advertisement — scheduled, manual or test — is delivered through this
 * module. It owns idempotency, per-group error bookkeeping and rate limiting.
 */

const { makeLogger } = require('../utils/logger');
const { REASONS } = require('./telegram');

const defaultSleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** Deterministic key for a scheduled slot: the same slot can only be claimed once. */
function scheduledKey(chatId, scheduledForIso) {
  return `s:${chatId}:${scheduledForIso}`;
}

function manualKey(chatId, campaignId, token) {
  return `m:${chatId}:${campaignId ?? 'none'}:${token}`;
}

function createBroadcaster({ q, telegram, config, logger = makeLogger('Broadcaster'), sleep = defaultSleep, now = () => new Date() } = {}) {
  const service = {};

  /**
   * Picks the campaign a group should receive next.
   * Order: rotation list -> fixed campaign -> global default -> first enabled.
   */
  service.resolveCampaign = (group) => {
    const enabledById = new Map(q.listEnabledCampaigns().map((c) => [c.id, c]));

    if (group?.rotation_enabled) {
      const rotation = q.getGroupCampaignIds(group.chat_id).filter((id) => enabledById.has(id));
      if (rotation.length) {
        const lastIndex = rotation.indexOf(group.last_campaign_id);
        const nextIndex = lastIndex === -1 ? 0 : (lastIndex + 1) % rotation.length;
        return enabledById.get(rotation[nextIndex]);
      }
    }

    if (group?.campaign_id && enabledById.has(group.campaign_id)) {
      return enabledById.get(group.campaign_id);
    }

    const defaultId = Number(q.getSetting('default_campaign_id'));
    if (Number.isFinite(defaultId) && enabledById.has(defaultId)) {
      return enabledById.get(defaultId);
    }

    const first = enabledById.values().next();
    return first.done ? null : first.value;
  };

  /**
   * Sends one campaign to one registered group.
   *
   * `idempotencyKey` makes the call safe to repeat: if the key was already
   * claimed (restart, duplicate tick, retry) nothing is sent.
   */
  service.deliver = async ({ group, campaign, trigger = 'manual', scheduledFor = null, idempotencyKey, deletePrevious = null }) => {
    if (!group) return { status: 'skipped', reason: 'NO_GROUP' };
    if (!campaign) return { status: 'skipped', reason: 'NO_CAMPAIGN' };

    const key = idempotencyKey
      || (trigger === 'scheduled' && scheduledFor
        ? scheduledKey(group.chat_id, scheduledFor)
        : manualKey(group.chat_id, campaign.id, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));

    const claim = q.claimDelivery({ key, campaignId: campaign.id, chatId: group.chat_id, scheduledFor, trigger });
    if (!claim.claimed) {
      logger.info(`duplicate suppressed for chat ${group.chat_id} (key already claimed)`);
      return { status: 'duplicate', reason: 'ALREADY_CLAIMED', delivery: claim.delivery };
    }

    const deliveryId = claim.delivery.id;
    const shouldDelete = deletePrevious === null ? Boolean(group.delete_previous) : Boolean(deletePrevious);

    // Only ever delete a message this bot recorded as its own previous ad.
    if (shouldDelete && group.last_message_id) {
      await telegram.deleteMessage(group.chat_id, group.last_message_id);
    }

    try {
      const message = await telegram.sendCampaign(group.chat_id, campaign);
      q.markDeliverySent(deliveryId, message?.message_id);
      q.updateGroup(group.chat_id, {
        last_send_at: now().toISOString(),
        last_campaign_id: campaign.id,
        last_message_id: message?.message_id ?? null,
        delivery_problem: 0,
        can_send: 1,
        last_error: null,
        last_error_at: null,
      });
      return { status: 'sent', messageId: message?.message_id ?? null, deliveryId, campaign };
    } catch (error) {
      const info = error.classified || { reason: REASONS.UNKNOWN, friendly: error.message, permanent: false, migrateToChatId: null };

      // A group upgraded to a supergroup keeps its registration under the new id.
      if (info.reason === REASONS.CHAT_MIGRATED && info.migrateToChatId) {
        logger.warn(`chat ${group.chat_id} migrated to ${info.migrateToChatId}`);
        q.markDeliveryFailed(deliveryId, { code: info.reason, message: info.friendly });
        const migrated = q.migrateChatId(group.chat_id, info.migrateToChatId);
        return { status: 'migrated', reason: info.reason, newChatId: info.migrateToChatId, group: migrated, deliveryId };
      }

      q.markDeliveryFailed(deliveryId, { code: info.reason, message: info.description || info.friendly });
      q.recordGroupError(group.chat_id, { code: info.reason, message: info.friendly, problem: info.permanent });
      logger.warn(`send to ${group.chat_id} failed: ${info.reason} (${info.friendly})`);
      return { status: 'failed', reason: info.reason, friendly: info.friendly, permanent: Boolean(info.permanent), deliveryId };
    }
  };

  /**
   * Sequentially delivers to many groups with a delay in between so a large
   * batch never bursts against Telegram's limits.
   */
  service.broadcast = async ({ groups, campaignFor, trigger = 'manual', delayMs = config?.sendDelayMs ?? 3000, onResult = null }) => {
    const results = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const campaign = typeof campaignFor === 'function' ? campaignFor(group) : campaignFor;
      // eslint-disable-next-line no-await-in-loop
      const result = await service.deliver({ group, campaign, trigger });
      results.push({ chatId: group.chat_id, title: group.title, ...result });
      if (onResult) onResult(results[results.length - 1], index, groups.length);
      if (index < groups.length - 1) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(delayMs);
      }
    }
    return results;
  };

  return service;
}

module.exports = { createBroadcaster, scheduledKey, manualKey };
