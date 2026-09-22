'use strict';

/**
 * Every advertisement — scheduled, manual or test — is delivered through this
 * module. It owns idempotency, per-group error bookkeeping and routing to the
 * correct Telegram client.
 *
 * Routing is per group:
 *   sender_kind = 'user' -> MTProto USER ACCOUNT, via the global send queue
 *   sender_kind = 'bot'  -> the admin BOT (original behaviour, still supported)
 */

const { makeLogger } = require('../utils/logger');
const { REASONS: BOT_REASONS } = require('./telegram');
const { REASONS: USER_REASONS, classifyUserError } = require('./userSender');
const { renderCampaign, SENDER_USER, SENDER_BOT } = require('./render');
const { waitPlanFor } = require('./sendQueue');
const { resolveStoreUrl } = require('../database/seed');

const defaultSleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** Deterministic key for a scheduled slot: one slot can only be claimed once. */
function scheduledKey(chatId, scheduledForIso) {
  return `s:${chatId}:${scheduledForIso}`;
}

function manualKey(chatId, campaignId, token) {
  return `m:${chatId}:${campaignId ?? 'none'}:${token}`;
}

function senderKindOf(group) {
  return group?.sender_kind === SENDER_USER ? SENDER_USER : SENDER_BOT;
}

function createBroadcaster({
  q, telegram, userSender = null, sendQueue = null, mediaStore = null,
  config, logger = makeLogger('Broadcaster'), sleep = defaultSleep, now = () => new Date(),
} = {}) {
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

  /** Renders a campaign exactly as the given group will receive it. */
  service.renderFor = (group, campaign) =>
    renderCampaign(campaign, {
      senderKind: senderKindOf(group),
      storeUrl: resolveStoreUrl(q, config),
    });

  /**
   * Makes sure media is available in the form the target sender needs.
   * The user account cannot use a Bot API file_id, so a local copy is made.
   */
  service.prepareMedia = async (campaign, senderKind) => {
    if (senderKind !== SENDER_USER) return { ok: true };
    if (!campaign?.media_type || !campaign?.media_file_id) return { ok: true };
    if (!mediaStore) return { ok: false, reason: USER_REASONS.MEDIA_UNAVAILABLE };
    const result = await mediaStore.ensureLocalCopy(campaign);
    return result.ok ? { ok: true, path: result.path } : { ok: false, reason: USER_REASONS.MEDIA_UNAVAILABLE };
  };

  /** Uploads campaign media once so a whole batch can reuse it. */
  service.prepareBatchUpload = async (campaign, groups) => {
    if (!userSender || !userSender.isConnected()) return null;
    if (!campaign?.media_type || !campaign?.media_file_id) return null;
    const userGroups = groups.filter((g) => senderKindOf(g) === SENDER_USER);
    if (userGroups.length < 2) return null;
    const prepared = await service.prepareMedia(campaign, SENDER_USER);
    if (!prepared.ok) return null;
    try {
      const uploaded = await userSender.uploadMedia(prepared.path);
      logger.info(`media uploaded once for ${userGroups.length} groups`);
      return uploaded;
    } catch (error) {
      logger.warn(`batch upload failed, falling back to per-send upload: ${classifyUserError(error).reason}`);
      return null;
    }
  };

  /** Records a chat-level or account-level wait without losing the ad. */
  function recordDeferral(group, deliveryId, info, waitPlan) {
    // The slot was never sent, so free it for a later retry.
    q.releaseDelivery(deliveryId);
    const seconds = waitPlan.waitSeconds;
    const until = new Date(now().getTime() + seconds * 1000).toISOString();

    if (waitPlan.scope === 'account' && sendQueue) {
      sendQueue.applyAccountWait(seconds, { label: info.reason });
    }

    q.updateGroup(group.chat_id, {
      next_send_at: until,
      last_error: `${info.reason}: waiting ${seconds}s`,
      last_error_at: now().toISOString(),
      // A rate limit is not a broken group, so it is not flagged as a problem.
      delivery_problem: 0,
    });

    logger.info(`deferred ${group.chat_id} for ${seconds}s (${info.reason}, ${waitPlan.scope})`);
    return { status: 'deferred', reason: info.reason, scope: waitPlan.scope, waitSeconds: seconds, deferUntil: until, friendly: info.friendly };
  }

  /**
   * Sends one campaign to one registered group.
   *
   * `idempotencyKey` makes the call safe to repeat: if the key was already
   * claimed (restart, duplicate tick, retry) nothing is sent.
   */
  service.deliver = async ({ group, campaign, trigger = 'manual', scheduledFor = null, idempotencyKey, deletePrevious = null, uploadedFile = null }) => {
    if (!group) return { status: 'skipped', reason: 'NO_GROUP' };
    if (!campaign) return { status: 'skipped', reason: 'NO_CAMPAIGN' };

    const senderKind = senderKindOf(group);
    const plan = service.renderFor(group, campaign);
    if (!plan.ok) {
      return { status: 'failed', reason: BOT_REASONS.EMPTY_CAMPAIGN, friendly: 'Campaign has neither text nor media', permanent: true };
    }

    // Refuse early, before claiming a slot, if the user account cannot send.
    if (senderKind === SENDER_USER && (!userSender || !userSender.isConnected())) {
      const friendly = userSender ? (userSender.getStatus().reason || 'User sender is not connected') : 'User sender is not configured';
      q.recordGroupError(group.chat_id, { message: friendly, problem: false });
      return { status: 'failed', reason: USER_REASONS.SENDER_UNAVAILABLE, friendly, permanent: false };
    }

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

    try {
      if (senderKind === SENDER_USER) {
        const prepared = await service.prepareMedia(campaign, SENDER_USER);
        if (!prepared.ok) {
          q.markDeliveryFailed(deliveryId, { code: prepared.reason, message: 'Campaign media is not available for MTProto sending' });
          q.recordGroupError(group.chat_id, { message: 'Campaign media unavailable', problem: true });
          return { status: 'failed', reason: prepared.reason, friendly: 'Campaign media is not available for MTProto sending', permanent: true };
        }
        if (prepared.path) plan.mediaLocalPath = prepared.path;

        // Only ever delete a message this account recorded as its own.
        if (shouldDelete && group.last_message_id) {
          await userSender.deleteMessage(group, group.last_message_id);
        }

        // Serialised through the global queue: one send at a time, spaced out.
        const sent = await sendQueue.enqueue(() => userSender.send(group, plan, { uploadedFile }), { label: `user->${group.chat_id}` });
        q.markDeliverySent(deliveryId, sent.messageId);
        q.updateGroup(group.chat_id, {
          last_send_at: now().toISOString(),
          last_campaign_id: campaign.id,
          last_message_id: sent.messageId ?? null,
          delivery_problem: 0,
          can_send: 1,
          last_error: null,
          last_error_at: null,
          peer_checked_at: now().toISOString(),
        });
        return { status: 'sent', messageId: sent.messageId ?? null, deliveryId, campaign, senderKind };
      }

      // ---- bot delivery (original path, unchanged behaviour) ----
      if (shouldDelete && group.last_message_id) {
        await telegram.deleteMessage(group.chat_id, group.last_message_id);
      }
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
      return { status: 'sent', messageId: message?.message_id ?? null, deliveryId, campaign, senderKind };
    } catch (error) {
      if (senderKind === SENDER_USER) {
        const info = classifyUserError(error);

        // Telegram asked us to wait: obey it, keep the ad, never bypass.
        const waitPlan = waitPlanFor(info, config);
        if (waitPlan) {
          return recordDeferral(group, deliveryId, info, waitPlan);
        }

        if (info.reason === USER_REASONS.SESSION_INVALID) {
          logger.error('user session became invalid — regenerate it with npm run login:user');
        }
        q.markDeliveryFailed(deliveryId, { code: info.reason, message: info.friendly });
        q.recordGroupError(group.chat_id, { message: info.friendly, problem: info.permanent });
        logger.warn(`user send to ${group.chat_id} failed: ${info.reason}`);
        return { status: 'failed', reason: info.reason, friendly: info.friendly, permanent: Boolean(info.permanent), deliveryId };
      }

      const info = error.classified || { reason: BOT_REASONS.UNKNOWN, friendly: error.message, permanent: false, migrateToChatId: null };

      // A group upgraded to a supergroup keeps its registration under the new id.
      if (info.reason === BOT_REASONS.CHAT_MIGRATED && info.migrateToChatId) {
        logger.warn(`chat ${group.chat_id} migrated to ${info.migrateToChatId}`);
        q.markDeliveryFailed(deliveryId, { code: info.reason, message: info.friendly });
        const migrated = q.migrateChatId(group.chat_id, info.migrateToChatId);
        return { status: 'migrated', reason: info.reason, newChatId: info.migrateToChatId, group: migrated, deliveryId };
      }

      q.markDeliveryFailed(deliveryId, { code: info.reason, message: info.description || info.friendly });
      q.recordGroupError(group.chat_id, { message: info.friendly, problem: info.permanent });
      logger.warn(`bot send to ${group.chat_id} failed: ${info.reason} (${info.friendly})`);
      return { status: 'failed', reason: info.reason, friendly: info.friendly, permanent: Boolean(info.permanent), deliveryId };
    }
  };

  /**
   * Delivers to many groups. User-account sends are additionally serialised by
   * the global queue, so nothing is ever blasted out in parallel.
   */
  service.broadcast = async ({ groups, campaignFor, trigger = 'manual', delayMs = config?.sendDelayMs ?? 3000, onResult = null }) => {
    const results = [];
    const single = typeof campaignFor === 'function' ? null : campaignFor;
    const uploadedFile = single ? await service.prepareBatchUpload(single, groups) : null;

    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const campaign = single || campaignFor(group);
      // eslint-disable-next-line no-await-in-loop
      const result = await service.deliver({ group, campaign, trigger, uploadedFile });
      results.push({ chatId: group.chat_id, title: group.title, senderKind: senderKindOf(group), ...result });
      if (onResult) onResult(results[results.length - 1], index, groups.length);

      // The queue already spaces user sends; only bot sends need this delay.
      if (index < groups.length - 1 && senderKindOf(group) === SENDER_BOT) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(delayMs);
      }
    }
    return results;
  };

  return service;
}

module.exports = { createBroadcaster, scheduledKey, manualKey, senderKindOf };
