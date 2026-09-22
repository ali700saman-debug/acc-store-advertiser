'use strict';

/**
 * Graceful shutdown. Railway sends SIGTERM on every deploy, so stopping
 * cleanly — scheduler first, then polling, then the database — is what keeps
 * delivery state from being corrupted mid-write.
 */

const { closeDatabase } = require('../database/db');
const { makeLogger } = require('../utils/logger');

function createShutdown({ scheduler, bot, userSender = null, sendQueue = null, dbInfo, logger = makeLogger('Advertiser'), exit = (code) => process.exit(code) } = {}) {
  let shuttingDown = false;

  return async function shutdown(signal) {
    if (shuttingDown) return false;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);

    // 1. Stop starting new work.
    try {
      if (scheduler) scheduler.stop();
    } catch (error) {
      logger.error(`scheduler stop failed: ${error.message}`);
    }

    // 2. Drop anything still queued rather than sending it mid-shutdown.
    try {
      if (sendQueue) {
        sendQueue.stop();
        const dropped = sendQueue.clear('shutting down');
        if (dropped) logger.info(`dropped ${dropped} queued send(s)`);
      }
    } catch (error) {
      logger.error(`send queue stop failed: ${error.message}`);
    }

    // 3. Stop accepting new updates.
    try {
      if (bot && typeof bot.stopPolling === 'function') await bot.stopPolling({ cancel: true });
    } catch (error) {
      logger.error(`polling stop failed: ${error.message}`);
    }

    // 4. Close the MTProto connection cleanly.
    try {
      if (userSender) {
        await userSender.disconnect();
        logger.info('user sender disconnected');
      }
    } catch (error) {
      logger.error(`user sender disconnect failed: ${error.message}`);
    }

    // 5. Flush and close the database last, so in-flight writes land.
    try {
      if (dbInfo?.db) closeDatabase(dbInfo.db);
      logger.info('database closed cleanly');
    } catch (error) {
      logger.error(`database close failed: ${error.message}`);
    }

    exit(0);
    return true;
  };
}

/** Wires the signal handlers plus last-resort error guards. */
function install(shutdown, { logger = makeLogger('Advertiser'), target = process } = {}) {
  target.on('SIGTERM', () => shutdown('SIGTERM'));
  target.on('SIGINT', () => shutdown('SIGINT'));
  // One bad update must never take the whole advertiser down.
  target.on('unhandledRejection', (reason) => logger.error(`unhandled rejection: ${reason instanceof Error ? reason.message : reason}`));
  target.on('uncaughtException', (error) => logger.error(`uncaught exception: ${error.message}`));
  return shutdown;
}

module.exports = { createShutdown, install };
