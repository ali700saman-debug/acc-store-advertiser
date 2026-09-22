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
  USER_SEND_DELAY_MS: 20000,
  FLOOD_WAIT_MARGIN_SECONDS: 5,
  MAX_FLOOD_WAIT_SECONDS: 6 * 60 * 60,
  USER_CONNECT_TIMEOUT_MS: 30000,
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

    // ---- MTProto user account (the account that actually posts the ads) ----
    // These are credentials. They live only in memory, never in SQLite, and
    // are registered with the logger so they cannot be printed by accident.
    userApiId: parseIntEnv(env.TELEGRAM_API_ID, 0),
    userApiHash: env.TELEGRAM_API_HASH || '',
    userSession: env.TELEGRAM_USER_SESSION || '',
    userSenderEnabled: parseBoolEnv(env.USER_SENDER_ENABLED, true),
    userSendDelayMs: parseIntEnv(env.USER_SEND_DELAY_MS, DEFAULTS.USER_SEND_DELAY_MS),
    userConnectTimeoutMs: parseIntEnv(env.USER_CONNECT_TIMEOUT_MS, DEFAULTS.USER_CONNECT_TIMEOUT_MS),
    floodWaitMarginSeconds: parseIntEnv(env.FLOOD_WAIT_MARGIN_SECONDS, DEFAULTS.FLOOD_WAIT_MARGIN_SECONDS),
    maxFloodWaitSeconds: parseIntEnv(env.MAX_FLOOD_WAIT_SECONDS, DEFAULTS.MAX_FLOOD_WAIT_SECONDS),
    mediaDir: env.MEDIA_DIR || '',
  };
}

/** True when all three MTProto credentials are present. */
function hasUserCredentials(config) {
  return Boolean(config.userApiId && config.userApiHash && config.userSession);
}

/** Every secret value, for registration with the logger's redactor. */
function secretValues(config) {
  return [config.botToken, config.userApiHash, config.userSession].filter((v) => typeof v === 'string' && v.length >= 8);
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

/**
 * Problems that disable the MTProto sender but must NOT stop the admin bot
 * from booting. Never echoes any credential value.
 */
function validateUserSender(config) {
  const problems = [];
  if (!config.userSenderEnabled) return ['USER_SENDER_ENABLED is false.'];
  if (!config.userApiId) problems.push('TELEGRAM_API_ID is missing.');
  if (!config.userApiHash) problems.push('TELEGRAM_API_HASH is missing.');
  if (!config.userSession) problems.push('TELEGRAM_USER_SESSION is missing.');
  return problems;
}

module.exports = build();
module.exports.build = build;
module.exports.validate = validate;
module.exports.validateUserSender = validateUserSender;
module.exports.hasUserCredentials = hasUserCredentials;
module.exports.secretValues = secretValues;
module.exports.parseAdminIds = parseAdminIds;
module.exports.parseBoolEnv = parseBoolEnv;
module.exports.DEFAULTS = DEFAULTS;
