'use strict';

/**
 * ACC STORE Advertiser — private admin-controlled Telegram advertising bot.
 *
 * Advertisements are only ever posted to groups that an authorised admin has
 * explicitly registered with /register_group. The bot never discovers, joins
 * or messages any other chat.
 */

const TelegramBot = require('node-telegram-bot-api');

const config = require('./config');
const { openDatabase, integrityCheck } = require('./database/db');
const { createQueries } = require('./database/queries');
const { ensureDefaultCampaign } = require('./database/seed');
const { createSessions } = require('./handlers/session');
const { createTelegramService } = require('./services/telegram');
const { createBroadcaster } = require('./services/broadcaster');
const { createScheduler } = require('./services/scheduler');
const { createShutdown, install: installShutdown } = require('./services/shutdown');
const { createUserSender } = require('./services/userSender');
const { createSendQueue } = require('./services/sendQueue');
const { createMediaStore } = require('./services/mediaStore');
const { makeLogger, registerSecrets } = require('./utils/logger');

const startHandler = require('./handlers/start');
const groupsHandler = require('./handlers/groups');
const callbacksHandler = require('./handlers/callbacks');

const log = makeLogger('Advertiser');

/**
 * Builds the whole application graph. `bot` is injectable so tests can run
 * the real handlers against a stub instead of the Telegram API.
 */
/**
 * Builds the whole application graph.
 *
 * `bot` and `createClient` are injectable so tests can run the real handlers
 * against stubs instead of the Telegram APIs.
 */
function createApp({ bot, config: appConfig = config, dbInfo, logger = log, createClient = undefined, userSender: injectedUserSender = null } = {}) {
  const q = createQueries(dbInfo.db);
  const sessions = createSessions();
  const telegram = createTelegramService({ bot, logger: makeLogger('Telegram'), maxRetryAttempts: appConfig.maxRetryAttempts });

  // The MTProto user account: what actually posts the advertisements.
  const userSender = injectedUserSender
    || createUserSender({ config: appConfig, logger: makeLogger('User Sender'), ...(createClient ? { createClient } : {}) });
  const sendQueue = createSendQueue({ q, config: appConfig, logger: makeLogger('Send Queue') });
  const mediaStore = createMediaStore({ bot, config: appConfig, q, logger: makeLogger('Media') });

  const broadcaster = createBroadcaster({
    q, telegram, userSender, sendQueue, mediaStore,
    config: appConfig, logger: makeLogger('Broadcaster'),
  });

  const ctx = {
    bot,
    q,
    config: appConfig,
    sessions,
    telegram,
    userSender,
    sendQueue,
    mediaStore,
    broadcaster,
    logger,
    dbInfo,
    botInfo: null,
    scheduler: null,
    senderCache: {},
  };

  ctx.scheduler = createScheduler({ q, broadcaster, config: appConfig, logger: makeLogger('Scheduler') });

  startHandler.register(ctx);
  groupsHandler.register(ctx);
  callbacksHandler.register(ctx);

  return ctx;
}

async function main() {
  log.info('starting');

  // Register every secret with the logger BEFORE anything else can log, so a
  // token, api hash or session can never be printed even by accident.
  registerSecrets(config.secretValues(config));

  const problems = config.validate(config);
  if (problems.length) {
    problems.forEach((problem) => log.error(problem));
    log.error('Refusing to start. Fix the environment variables and redeploy.');
    process.exit(1);
  }

  const dbInfo = openDatabase({ dbPath: config.dbPath, verbose: true });
  const integrity = integrityCheck(dbInfo.db);
  if (!integrity.ok) {
    log.error(`Database integrity check failed: ${integrity.result}`);
    log.error('Refusing to start to avoid corrupting delivery state.');
    process.exit(1);
  }
  if (!dbInfo.persistent) {
    log.warn('No persistent volume detected — data will be lost on redeploy. Mount a volume at /data and set DB_PATH=/data/advertiser.db');
  }

  const bot = new TelegramBot(config.botToken, {
    polling: { interval: 1000, autoStart: false, params: { timeout: 30 } },
  });

  const ctx = createApp({ bot, config, dbInfo });
  const { q, scheduler } = ctx;

  ensureDefaultCampaign(q, config, { logger: makeLogger('Campaigns') });

  bot.on('polling_error', (error) => makeLogger('Telegram').warn(`polling: ${error.message}`));
  bot.on('webhook_error', (error) => makeLogger('Telegram').warn(`webhook: ${error.message}`));

  await bot.startPolling();
  try {
    ctx.botInfo = await bot.getMe();
    log.info(`admin bot connected as @${ctx.botInfo.username}`);
  } catch (error) {
    log.warn(`could not fetch bot identity: ${error.message}`);
  }

  // Connect the user account. A missing or revoked session must NEVER stop the
  // admin panel: the failure is reported here and shown in ⚙️ Sender Account.
  const senderLog = makeLogger('User Sender');
  try {
    const senderStatus = await ctx.userSender.connect();
    if (!senderStatus.connected) {
      senderLog.warn(`unavailable — ${senderStatus.reason || senderStatus.status}`);
      senderLog.warn('admin bot continues; fix it from the panel or regenerate with npm run login:user');
    }
  } catch (error) {
    // connect() already swallows its own errors; this is belt and braces.
    senderLog.warn(`unavailable — ${error.message}`);
  }

  if (config.schedulerEnabled) scheduler.start();
  else makeLogger('Scheduler').warn('disabled via SCHEDULER_ENABLED=false');

  makeLogger('Groups').info(
    `${q.countGroups()} registered (${q.countEnabledGroups()} enabled)`
    + ` — ${q.countGroupsBySender('user')} via user account, ${q.countGroupsBySender('bot')} via bot`
  );
  makeLogger('Campaigns').info(`${q.countEnabledCampaigns()} active`);
  makeLogger('Admins').info(`${config.adminIds.length} authorised admin id(s)`);
  if (q.isPaused()) log.warn('automatic advertising is currently PAUSED');

  const shutdown = createShutdown({ scheduler, bot, userSender: ctx.userSender, sendQueue: ctx.sendQueue, dbInfo, logger: log });
  installShutdown(shutdown, { logger: log });

  return ctx;
}

if (require.main === module) {
  main().catch((error) => {
    log.error(`fatal: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { createApp, main };
