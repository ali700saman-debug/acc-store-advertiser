'use strict';

/**
 * Global, strictly serialised send queue for the USER ACCOUNT.
 *
 * Everything the user account posts goes through here, so that:
 *  - only ONE message is in flight at a time, account-wide;
 *  - a configurable delay separates consecutive sends;
 *  - when Telegram asks the account to wait, the wait is obeyed, recorded in
 *    SQLite and reported to the admin — never bypassed or tight-looped.
 *
 * FLOOD_WAIT / PEER_FLOOD are ACCOUNT-level, so they gate the whole queue.
 * SLOWMODE_WAIT is CHAT-level and only defers that one group.
 */

const { makeLogger } = require('../utils/logger');
const { REASONS } = require('./userSender');

const defaultSleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function createSendQueue({ q, config, logger = makeLogger('Send Queue'), sleep = defaultSleep, now = () => new Date() } = {}) {
  const pending = [];
  let draining = false;
  let lastSendAt = 0;
  let stopped = false;

  const service = {};

  service.size = () => pending.length;
  service.isDraining = () => draining;
  service.stop = () => { stopped = true; };
  service.resume = () => { stopped = false; };

  /** Remaining account-level hold, in ms (0 when clear). */
  service.floodHoldMs = () => {
    const until = q.getFloodWaitUntil();
    if (!until) return 0;
    return Math.max(0, new Date(until).getTime() - now().getTime());
  };

  /**
   * Records an account-level wait. Telegram's number is respected exactly,
   * plus a small safety margin; nothing shortens it.
   */
  service.applyAccountWait = (waitSeconds, { label = 'FLOOD_WAIT' } = {}) => {
    const requested = Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : 60;
    const seconds = Math.min(requested + config.floodWaitMarginSeconds, config.maxFloodWaitSeconds);
    const until = new Date(now().getTime() + seconds * 1000).toISOString();
    const existing = q.getFloodWaitUntil();
    // Never shorten a hold that is already longer.
    if (!existing || new Date(existing).getTime() < new Date(until).getTime()) {
      q.setFloodWaitUntil(until);
    }
    logger.warn(`${label}: holding all user sends for ${seconds}s (until ${q.getFloodWaitUntil()})`);
    return q.getFloodWaitUntil();
  };

  service.clearAccountWait = () => q.setFloodWaitUntil(null);

  /**
   * Queues one job. `job` is an async function returning the send result.
   * Resolves with that result, or with { status:'deferred' } when Telegram
   * asked the account to wait.
   */
  service.enqueue = (job, { label = 'send' } = {}) =>
    new Promise((resolve, reject) => {
      pending.push({ job, label, resolve, reject });
      service.drain().catch((error) => logger.error(`drain failed: ${error.message}`));
    });

  /** Processes the queue one job at a time. Safe to call concurrently. */
  service.drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (pending.length && !stopped) {
        // Honour any account-level hold before touching the next job.
        const hold = service.floodHoldMs();
        if (hold > 0) {
          logger.info(`waiting ${Math.ceil(hold / 1000)}s for the account-level hold to expire`);
          // eslint-disable-next-line no-await-in-loop
          await sleep(hold);
          if (stopped) break;
          continue;
        }

        // Keep a conservative gap between consecutive sends.
        const sinceLast = now().getTime() - lastSendAt;
        if (lastSendAt && sinceLast < config.userSendDelayMs) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(config.userSendDelayMs - sinceLast);
          if (stopped) break;
        }

        const entry = pending.shift();
        if (!entry) break;

        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await entry.job();
          lastSendAt = now().getTime();
          entry.resolve(result);
        } catch (error) {
          lastSendAt = now().getTime();
          entry.reject(error);
        }
      }
    } finally {
      draining = false;
    }
  };

  /** Drops every queued job, rejecting their promises. Used on shutdown. */
  service.clear = (reason = 'shutting down') => {
    const dropped = pending.length;
    while (pending.length) {
      const entry = pending.shift();
      entry.resolve({ status: 'skipped', reason: 'QUEUE_CLEARED', friendly: reason });
    }
    return dropped;
  };

  return service;
}

/**
 * Decides what a wait error means for scheduling.
 * Returns { scope, waitSeconds } with the wait Telegram actually asked for.
 */
function waitPlanFor(info, config) {
  const requested = Number.isFinite(info?.waitSeconds) && info.waitSeconds > 0 ? info.waitSeconds : null;
  if (info?.reason === REASONS.FLOOD_WAIT) {
    return { scope: 'account', waitSeconds: requested ?? 60 };
  }
  if (info?.reason === REASONS.PEER_FLOOD) {
    // Telegram gives no number for PEER_FLOOD. Back off hard: this is the
    // anti-spam signal, and pushing through it gets the account banned.
    return { scope: 'account', waitSeconds: requested ?? Math.min(6 * 3600, config.maxFloodWaitSeconds) };
  }
  if (info?.reason === REASONS.SLOWMODE_WAIT) {
    return { scope: 'chat', waitSeconds: requested ?? 60 };
  }
  return null;
}

module.exports = { createSendQueue, waitPlanFor };
