'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { createTelegramService, classifyError, REASONS } = require('../services/telegram');
const { createBroadcaster } = require('../services/broadcaster');
const { createScheduler } = require('../services/scheduler');
const { ensureDefaultCampaign } = require('../database/seed');
const { FakeBot, telegramError, makeTempDbPath, testConfig, openTestDb, GROUP_ID } = require('./helpers');

function bootBroadcaster(overrides = {}) {
  const dbPath = makeTempDbPath('broadcaster');
  const { dbInfo, q, close } = openTestDb(dbPath);
  const config = testConfig(overrides);
  const bot = new FakeBot();
  const clock = { at: new Date('2026-09-22T12:00:00Z') };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };

  const telegram = createTelegramService({ bot, sleep, maxRetryAttempts: config.maxRetryAttempts });
  const broadcaster = createBroadcaster({ q, telegram, config, sleep, now: () => clock.at });
  const scheduler = createScheduler({ q, broadcaster, config, now: () => clock.at, sleep });

  ensureDefaultCampaign(q, config);
  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech Group', type: 'supergroup' });
  q.updateGroup(GROUP_ID, { next_send_at: clock.at.toISOString() });

  return {
    bot, q, config, clock, sleeps, telegram, broadcaster, scheduler,
    group: () => q.getGroup(GROUP_ID),
    campaign: () => q.listCampaigns()[0],
    cleanup: () => { close(); fs.rmSync(dbPath, { force: true }); },
  };
}

test('19. a Telegram failure is recorded and never crashes the bot', async (t) => {
  const { bot, q, broadcaster, group, campaign, cleanup } = bootBroadcaster();
  t.after(cleanup);
  bot.failNext(telegramError(403, 'Forbidden: bot was kicked from the supergroup chat'));

  const result = await broadcaster.deliver({ group: group(), campaign: campaign(), trigger: 'manual' });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, REASONS.BOT_REMOVED);
  assert.equal(group().delivery_problem, 1, 'the group is flagged in the admin panel');
  assert.match(group().last_error, /removed from the group/);
  assert.equal(q.deliveryStats({}).failedTotal, 1, 'the failure is in the delivery history');
});

test('19b. one failing group does not stop the rest of a broadcast', async (t) => {
  const { bot, q, broadcaster, campaign, cleanup } = bootBroadcaster();
  t.after(cleanup);
  q.registerGroup({ chat_id: -1002222222222, title: 'Market', type: 'supergroup' });
  q.registerGroup({ chat_id: -1003333333333, title: 'Sales', type: 'supergroup' });
  bot.failNext(telegramError(400, 'Bad Request: chat not found'));

  const results = await broadcaster.broadcast({ groups: q.listGroups(), campaignFor: campaign(), trigger: 'manual' });

  assert.equal(results.length, 3);
  assert.equal(results.filter((r) => r.status === 'sent').length, 2);
  assert.equal(results.filter((r) => r.status === 'failed').length, 1);
});

test('20. a 429 is retried after retry_after and then succeeds', async (t) => {
  const { bot, sleeps, broadcaster, group, campaign, cleanup } = bootBroadcaster();
  t.after(cleanup);
  bot.failNext(telegramError(429, 'Too Many Requests: retry after 7', { retry_after: 7 }));

  const result = await broadcaster.deliver({ group: group(), campaign: campaign(), trigger: 'manual' });

  assert.equal(result.status, 'sent');
  assert.ok(sleeps.includes(7000), `waited the retry_after Telegram asked for (saw ${sleeps})`);
  assert.equal(bot.messagesTo(GROUP_ID).length, 1, 'the ad is delivered exactly once');
});

test('20b. retries are hard-capped — no infinite loop', async (t) => {
  const { bot, sleeps, broadcaster, group, campaign, config, cleanup } = bootBroadcaster();
  t.after(cleanup);
  bot.failNext(telegramError(429, 'Too Many Requests: retry after 3', { retry_after: 3 }), { times: 99 });

  const result = await broadcaster.deliver({ group: group(), campaign: campaign(), trigger: 'manual' });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, REASONS.RATE_LIMITED);
  assert.equal(sleeps.filter((ms) => ms === 3000).length, config.maxRetryAttempts, 'retried exactly maxRetryAttempts times');
});

test('20c. a rate-limited group is retried soon, not flagged as broken', async (t) => {
  const { bot, clock, scheduler, group, cleanup } = bootBroadcaster();
  t.after(cleanup);
  bot.failNext(telegramError(429, 'Too Many Requests: retry after 3', { retry_after: 3 }), { times: 99 });

  await scheduler.tick();

  assert.equal(group().delivery_problem, 0, 'a transient limit is not a permanent problem');
  const nextSend = new Date(group().next_send_at);
  assert.ok(nextSend > clock.at && nextSend <= new Date(clock.at.getTime() + 15 * 60 * 1000), 'retried within 15 minutes');
});

test('16. a permanent failure still advances the slot, so it cannot hot-loop', async (t) => {
  const { bot, clock, scheduler, group, cleanup } = bootBroadcaster();
  t.after(cleanup);
  bot.failNext(telegramError(400, 'Bad Request: have no rights to send a message'), { times: 99 });

  await scheduler.tick();

  const nextSend = new Date(group().next_send_at);
  assert.equal(nextSend.getTime(), clock.at.getTime() + 6 * 60 * 60 * 1000, 'moved a full interval ahead');
  assert.equal(group().delivery_problem, 1);
});

test('21. missing send permissions are surfaced clearly', async (t) => {
  const { bot, telegram, cleanup } = bootBroadcaster();
  t.after(cleanup);
  bot.setChatMember(GROUP_ID, { status: 'restricted', can_send_messages: false });

  const permission = await telegram.checkPostPermission(GROUP_ID, 777);

  assert.equal(permission.ok, false);
  assert.equal(permission.reason, REASONS.NO_PERMISSION);
  assert.match(permission.friendly, /no permission to send/i);
});

test('21b. a removed bot is reported as removed, not as a generic error', async (t) => {
  const { bot, telegram, cleanup } = bootBroadcaster();
  t.after(cleanup);
  bot.setChatMember(GROUP_ID, { status: 'kicked' });

  const permission = await telegram.checkPostPermission(GROUP_ID, 777);

  assert.equal(permission.ok, false);
  assert.equal(permission.reason, REASONS.BOT_REMOVED);
});

test('21c. a healthy group reports that it can post', async (t) => {
  const { telegram, cleanup } = bootBroadcaster();
  t.after(cleanup);

  const permission = await telegram.checkPostPermission(GROUP_ID, 777);

  assert.equal(permission.ok, true);
});

test('15b. a group upgraded to a supergroup keeps its registration', async (t) => {
  const { bot, q, broadcaster, group, campaign, cleanup } = bootBroadcaster();
  t.after(cleanup);
  const newChatId = -1005555555555;
  bot.failNext(telegramError(400, 'Bad Request: group chat was upgraded to a supergroup chat', { migrate_to_chat_id: newChatId }));

  const result = await broadcaster.deliver({ group: group(), campaign: campaign(), trigger: 'manual' });

  assert.equal(result.status, 'migrated');
  assert.equal(q.getGroup(GROUP_ID), null);
  assert.ok(q.getGroup(newChatId), 'the registration followed the chat to its new id');
  assert.equal(q.countGroups(), 1);
});

test('22c. delete-previous removes only the ad this bot recorded', async (t) => {
  const { bot, q, broadcaster, group, campaign, cleanup } = bootBroadcaster();
  t.after(cleanup);
  q.updateGroup(GROUP_ID, { delete_previous: 1 });

  const first = await broadcaster.deliver({ group: group(), campaign: campaign(), trigger: 'manual' });
  assert.equal(bot.deleted.length, 0, 'nothing to delete on the very first ad');

  await broadcaster.deliver({ group: group(), campaign: campaign(), trigger: 'manual' });

  assert.deepEqual(bot.deleted, [{ chatId: GROUP_ID, messageId: first.messageId }]);
});

test('22d. delete-previous is off by default', async (t) => {
  const { bot, broadcaster, group, campaign, cleanup } = bootBroadcaster();
  t.after(cleanup);

  await broadcaster.deliver({ group: group(), campaign: campaign(), trigger: 'manual' });
  await broadcaster.deliver({ group: group(), campaign: campaign(), trigger: 'manual' });

  assert.equal(bot.deleted.length, 0);
});

test('22e. a failed delete never blocks the new advertisement', async (t) => {
  const { bot, q, broadcaster, group, campaign, cleanup } = bootBroadcaster();
  t.after(cleanup);
  q.updateGroup(GROUP_ID, { delete_previous: 1, last_message_id: 4242 });
  bot.deleteMessage = async () => { throw telegramError(400, 'Bad Request: message to delete not found'); };

  const result = await broadcaster.deliver({ group: group(), campaign: campaign(), trigger: 'manual' });

  assert.equal(result.status, 'sent');
});

test('16b. rate limiting puts a delay between group sends', async (t) => {
  const { q, sleeps, broadcaster, campaign, cleanup } = bootBroadcaster({ SEND_DELAY_MS: '2500' });
  t.after(cleanup);
  q.registerGroup({ chat_id: -1002222222222, title: 'Market', type: 'supergroup' });
  q.registerGroup({ chat_id: -1003333333333, title: 'Sales', type: 'supergroup' });

  await broadcaster.broadcast({ groups: q.listGroups(), campaignFor: campaign(), trigger: 'manual' });

  assert.equal(sleeps.filter((ms) => ms === 2500).length, 2, 'a delay between each pair of sends');
});

test('19c. an empty campaign is refused instead of throwing at Telegram', async (t) => {
  const { bot, q, broadcaster, group, cleanup } = bootBroadcaster();
  t.after(cleanup);
  const empty = q.createCampaign({ name: 'Empty', text: '' });

  const result = await broadcaster.deliver({ group: group(), campaign: empty, trigger: 'manual' });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, REASONS.EMPTY_CAMPAIGN);
  assert.equal(bot.sent.length, 0);
});

test('19d. broken campaign HTML is classified as a formatting problem', async (t) => {
  const { bot, broadcaster, group, campaign, cleanup } = bootBroadcaster();
  t.after(cleanup);
  bot.failNext(telegramError(400, "Bad Request: can't parse entities: Unclosed start tag at byte offset 4"));

  const result = await broadcaster.deliver({ group: group(), campaign: campaign(), trigger: 'manual' });

  assert.equal(result.reason, REASONS.PARSE_ERROR);
  assert.equal(result.permanent, true);
});

test('19e. unknown errors degrade gracefully instead of throwing', async (t) => {
  const { bot, broadcaster, group, campaign, cleanup } = bootBroadcaster();
  t.after(cleanup);
  bot.failNext(new Error('something entirely unexpected'));

  const result = await broadcaster.deliver({ group: group(), campaign: campaign(), trigger: 'manual' });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, REASONS.UNKNOWN);
});

test('20d. classifyError reads retry_after and migrate_to_chat_id', () => {
  const rateLimited = classifyError(telegramError(429, 'Too Many Requests: retry after 42', { retry_after: 42 }));
  assert.equal(rateLimited.reason, REASONS.RATE_LIMITED);
  assert.equal(rateLimited.retryAfter, 42);
  assert.equal(rateLimited.permanent, false);

  const migrated = classifyError(telegramError(400, 'Bad Request: group chat was upgraded', { migrate_to_chat_id: -100777 }));
  assert.equal(migrated.migrateToChatId, -100777);
});
