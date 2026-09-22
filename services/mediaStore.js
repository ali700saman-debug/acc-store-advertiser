'use strict';

/**
 * Bridges the two Telegram APIs for media.
 *
 * The admin uploads campaign media to the BOT, which yields a Bot API
 * `file_id`. That identifier is meaningless over MTProto: a user account
 * cannot send someone else's `file_id`. So the file is downloaded once to the
 * persistent volume and the USER ACCOUNT uploads it from there.
 *
 * The `file_id` is still kept and reused for bot-sent groups and for previews,
 * so nothing is downloaded or re-uploaded unnecessarily.
 */

const fs = require('fs');
const path = require('path');

const { makeLogger } = require('../utils/logger');

const EXTENSIONS = { photo: '.jpg', video: '.mp4', animation: '.mp4' };

/** Media lives next to the database, i.e. on the same persistent volume. */
function mediaDirFor(config) {
  if (config.mediaDir) return path.resolve(config.mediaDir);
  return path.join(path.dirname(path.resolve(config.dbPath)), 'media');
}

function ensureMediaDir(config) {
  const dir = mediaDirFor(config);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function localPathFor(config, campaign) {
  const extension = EXTENSIONS[campaign.media_type] || '';
  return path.join(mediaDirFor(config), `campaign-${campaign.id}-${campaign.media_type}${extension}`);
}

function createMediaStore({ bot, config, q, logger = makeLogger('Media') } = {}) {
  const service = {};

  service.dir = () => mediaDirFor(config);

  service.hasLocalCopy = (campaign) =>
    Boolean(campaign?.media_local_path) && fs.existsSync(campaign.media_local_path);

  /**
   * Makes sure a local copy exists for MTProto sending.
   * Returns { ok, path, reason }. Never throws.
   */
  service.ensureLocalCopy = async (campaign) => {
    if (!campaign?.media_type || !campaign?.media_file_id) {
      return { ok: false, reason: 'NO_MEDIA' };
    }
    if (service.hasLocalCopy(campaign)) {
      return { ok: true, path: campaign.media_local_path, cached: true };
    }

    try {
      ensureMediaDir(config);
      const target = localPathFor(config, campaign);

      // Already on disk from an earlier deploy: just re-link it.
      if (fs.existsSync(target)) {
        q.updateCampaign(campaign.id, { media_local_path: target });
        return { ok: true, path: target, cached: true };
      }

      const downloadedPath = await bot.downloadFile(campaign.media_file_id, mediaDirFor(config));
      if (downloadedPath !== target) {
        fs.renameSync(downloadedPath, target);
      }
      q.updateCampaign(campaign.id, { media_local_path: target });
      logger.info(`cached media for campaign ${campaign.id}`);
      return { ok: true, path: target, cached: false };
    } catch (error) {
      logger.warn(`could not cache media for campaign ${campaign.id}: ${error.message}`);
      return { ok: false, reason: 'DOWNLOAD_FAILED', error: error.message };
    }
  };

  /** Removes the cached file when media is cleared or the campaign is deleted. */
  service.removeLocalCopy = (campaign) => {
    const target = campaign?.media_local_path;
    if (!target) return false;
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      return true;
    } catch (error) {
      logger.warn(`could not remove cached media: ${error.message}`);
      return false;
    }
  };

  return service;
}

module.exports = { createMediaStore, mediaDirFor, ensureMediaDir, localPathFor, EXTENSIONS };
