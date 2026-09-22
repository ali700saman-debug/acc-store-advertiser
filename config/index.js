'use strict';

/**
 * Central configuration. Everything comes from environment variables so that
 * no secret is ever committed, logged or stored in SQLite.
 */

try {
  require('dotenv').config();
} catch (_) {
  // dotenv is optional at runtime (Railway injects real env vars).
}

const DEFAULTS = {
  DB_PATH: '/data/advertiser.db',
  DEFAULT_AD_INTERVAL_MINUTES: 360,
  MIN_INTERVAL_MINUTES: 60,
  TZ: 'Asia/Baghdad',
  SCHEDULER_TICK_MS: 60 * 1000,
  SEND_DELAY_MS: 3000,
  MAX_SENDS_PER_TICK: 25,
  MAX_RETRY_ATTEMPTS: 2,
};

function parseAdminIds(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function parseIntEnv(raw, fallback) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseBoolEnv(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function build(env = process.env) {
  const adminIds = parseAdminIds(env.ADMIN_IDS);
  const minInterval = parseIntEnv(env.MIN_INTERVAL_MINUTES, DEFAULTS.MIN_INTERVAL_MINUTES);
  const defaultInterval = Math.max(
    minInterval,
    parseIntEnv(env.DEFAULT_AD_INTERVAL_MINUTES, DEFAULTS.DEFAULT_AD_INTERVAL_MINUTES)
  );

  return {
    botToken: env.BOT_TOKEN || '',
    adminIds,
    dbPath: env.DB_PATH || DEFAULTS.DB_PATH,
    mainStoreBotUrl: env.MAIN_STORE_BOT_URL || '',
    mainStoreBotUsername: (env.MAIN_STORE_BOT_USERNAME || '').replace(/^@/, ''),
    timezone: env.TZ || DEFAULTS.TZ,
    defaultIntervalMinutes: defaultInterval,
    minIntervalMinutes: minInterval,
    schedulerTickMs: parseIntEnv(env.SCHEDULER_TICK_MS, DEFAULTS.SCHEDULER_TICK_MS),
    sendDelayMs: parseIntEnv(env.SEND_DELAY_MS, DEFAULTS.SEND_DELAY_MS),
    maxSendsPerTick: parseIntEnv(env.MAX_SENDS_PER_TICK, DEFAULTS.MAX_SENDS_PER_TICK),
    maxRetryAttempts: parseIntEnv(env.MAX_RETRY_ATTEMPTS, DEFAULTS.MAX_RETRY_ATTEMPTS),
    allowChannels: parseBoolEnv(env.ALLOW_CHANNELS, false),
    schedulerEnabled: parseBoolEnv(env.SCHEDULER_ENABLED, true),
  };
}

/**
 * Validates configuration required to actually boot the bot.
 * Returns a list of human readable problems (never echoes secret values).
 */
function validate(config) {
  const problems = [];
  if (!config.botToken) problems.push('BOT_TOKEN is missing.');
  if (!config.adminIds.length) problems.push('ADMIN_IDS is missing or contains no valid numeric IDs.');
  if (config.mainStoreBotUrl && !/^https?:\/\//i.test(config.mainStoreBotUrl)) {
    problems.push('MAIN_STORE_BOT_URL must start with http:// or https://');
  }
  return problems;
}

module.exports = build();
module.exports.build = build;
module.exports.validate = validate;
module.exports.parseAdminIds = parseAdminIds;
module.exports.parseBoolEnv = parseBoolEnv;
module.exports.DEFAULTS = DEFAULTS;
