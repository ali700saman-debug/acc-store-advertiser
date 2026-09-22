'use strict';

/**
 * The scheduler wakes up once a minute only to CHECK which registered groups
 * are due. Sending happens strictly per group interval, and every scheduling
 * decision is persisted in SQLite so a restart resumes exactly where it left
 * off without resending anything.
 */

const { makeLogger } = require('../utils/logger');
const policy = require('./policy');
const { senderKindOf } = require('./broadcaster');
const { SENDER_USER } = require('./render');

const defaultSleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** Transient failures retry sooner than a full interval, but never hot-loop. */
const TRANSIENT_RETRY_MINUTES = 15;

function createScheduler({ q, broadcaster, config, logger = makeLogger('Scheduler'), now = () => new Date(), sleep = defaultSleep } = {}) {
  let timer = null;
  let running = false;
  let stopping = false;
  let lastTickAt = null;

  const service = {};

  /** One scheduling pass. Safe to call directly from tests. */
  service.tick = async () => {
    if (running) return { skipped: true, reason: 'TICK_IN_PROGRESS' };
    running = true;
    const summary = {
      checked: 0, sent: 0, duplicate: 0, failed: 0, deferred: 0,
      rateLimited: 0, floodHeld: 0, noCampaign: 0, paused: false,
    };

    try {
      lastTickAt = now();
      if (q.isPaused()) {
        summary.paused = true;
        return summary;
      }

      const timezone = policy.getTimezone(q, config);
      const due = q.dueGroups(now().toISOString(), config.maxSendsPerTick);
      summary.checked = due.length;

      // Telegram asked the user ACCOUNT to wait: hold every user-account send
      // until it expires. Bot-delivered groups are unaffected.
      const accountHeld = q.isFloodGated(now());

      for (let index = 0; index < due.length; index += 1) {
        if (stopping) break;
        const group = due[index];

        if (accountHeld && senderKindOf(group) === SENDER_USER) {
          // Leave next_send_at alone: the queue's hold governs when it resumes.
          summary.floodHeld += 1;
          continue;
        }

        const quiet = policy.resolveQuiet(q, group);
        const at = now();

        // Quiet hours: postpone the slot instead of discarding the ad.
        if (policy.inQuietHours(at, quiet, timezone)) {
          const deferred = policy.deferPastQuietHours(at, quiet, timezone);
          q.updateGroup(group.chat_id, { next_send_at: deferred.toISOString() });
          summary.deferred += 1;
          continue;
        }

        const campaign = broadcaster.resolveCampaign(group);
        if (!campaign) {
          summary.noCampaign += 1;
          continue;
        }

        const intervalMinutes = policy.resolveIntervalMinutes(q, config, group);
        const scheduledFor = group.next_send_at;

        // eslint-disable-next-line no-await-in-loop
        const result = await broadcaster.deliver({ group, campaign, trigger: 'scheduled', scheduledFor });

        if (result.status === 'deferred') {
          // next_send_at was already set to exactly the wait Telegram asked
          // for. Do not shorten or overwrite it.
          summary.rateLimited += 1;
        } else if (result.status === 'migrated') {
          const target = result.group;
          if (target) {
            q.updateGroup(target.chat_id, {
              next_send_at: policy.computeNextSendAt(now(), intervalMinutes, quiet, timezone).toISOString(),
            });
          }
          summary.failed += 1;
        } else if (result.status === 'failed' && !result.permanent) {
          // Retry a transient problem sooner than a whole interval.
          const retryMinutes = Math.min(TRANSIENT_RETRY_MINUTES, intervalMinutes);
          q.updateGroup(group.chat_id, {
            next_send_at: policy.computeNextSendAt(now(), retryMinutes, quiet, timezone).toISOString(),
          });
          summary.failed += 1;
        } else {
          // Sent, duplicate-suppressed or permanently failed: move to the next slot.
          q.updateGroup(group.chat_id, {
            next_send_at: policy.computeNextSendAt(now(), intervalMinutes, quiet, timezone).toISOString(),
          });
          if (result.status === 'sent') summary.sent += 1;
          else if (result.status === 'duplicate') summary.duplicate += 1;
          else summary.failed += 1;
        }

        if (index < due.length - 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(config.sendDelayMs);
        }
      }

      if (summary.sent || summary.failed || summary.deferred || summary.rateLimited || summary.floodHeld) {
        logger.info(
          `tick: sent=${summary.sent} failed=${summary.failed} quiet-deferred=${summary.deferred}`
          + ` rate-limited=${summary.rateLimited} flood-held=${summary.floodHeld} duplicate=${summary.duplicate}`
        );
      }
      return summary;
    } finally {
      running = false;
    }
  };

  service.start = () => {
    if (timer) return service;
    stopping = false;
    timer = setInterval(() => {
      service.tick().catch((error) => logger.error(`tick failed: ${error.message}`));
    }, config.schedulerTickMs);
    if (typeof timer.unref === 'function') timer.unref();
    logger.info(`enabled (checking every ${Math.round(config.schedulerTickMs / 1000)}s)`);
    return service;
  };

  service.stop = () => {
    stopping = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return service;
  };

  service.status = () => ({ running: Boolean(timer), busy: running, lastTickAt });

  return service;
}

module.exports = { createScheduler, TRANSIENT_RETRY_MINUTES };
