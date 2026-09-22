'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { createApp } = require('../index');
const { ensureDefaultCampaign } = require('../database/seed');
const { createSendQueue, waitPlanFor } = require('../services/sendQueue');
const { createBroadcaster } = require('../services/broadcaster');
const { createScheduler } = require('../services/scheduler');
const { createUserSender, REASONS } = require('../services/userSender');
const { createShutdown } = require('../services/shutdown');
const { FloodWaitError, SlowModeWaitError, PeerFloodError } = require('teleproto/errors');
const {
  FakeBot, FakeMTProtoClient, fakeDialog, makeTempDbPath, testConfig, openTestDb, callbackQuery,
} = require('./helpers');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Builds the user-account sending stack with a controllable clock and a
 * recording sleep, so waits are asserted rather than actually slept.
 */
function bootQueue({ overrides = {}, groupCount = 1, clientOptions = {} } = {}) {
  const dbPath = makeTempDbPath('queue');
  const { dbInfo, q, close } = openTestDb(dbPath);
  const config = testConfig({ USER_SEND_DELAY_MS: '20000', ...overrides });
  const bot = new FakeBot();
  const mt = new FakeMTProtoClient(clientOptions);
  const clock = { at: new Date('2026-09-22T12:00:00Z') };
  const now = () => clock.at;
  const sleeps = [];
  // Sleeping advances the virtual clock instead of real time.
  const sleep = async (ms) => { sleeps.push(ms); clock.at = new Date(clock.at.getTime() + ms); };

  const userSender = createUserSender({ config, createClient: () => mt });
  userSender._setClient(mt);

  const sendQueue = createSendQueue({ q, config, sleep, now });
  const broadcaster = createBroadcaster({ q, telegram: null, userSender, sendQueue, mediaStore: null, config, sleep, now });
  const scheduler = createScheduler({ q, broadcaster, config, now, sleep });

  ensureDefaultCampaign(q, config);

  const groups = [];
  for (let i = 0; i < groupCount; i += 1) {
    const chatId = -1001000000001 - i;
    q.registerUserGroup({ chat_id: chatId, title: `Group ${i + 1}`, type: 'supergroup', peer_type: 'channel', access_hash: `111111111111111111${i}` });
    // Imported groups start disabled by design (see G); these fixtures test
    // sending, so enable them explicitly.
    q.updateGroup(chatId, { enabled: 1, next_send_at: clock.at.toISOString() });
    groups.push(q.getGroup(chatId));
  }

  return {
    bot, mt, q, config, clock, sleeps, sendQueue, broadcaster, scheduler, userSender, groups, dbInfo,
    campaign: () => q.listCampaigns()[0],
    group: (i = 0) => q.getGroup(-1001000000001 - i),
    advance: (ms) => { clock.at = new Date(clock.at.getTime() + ms); },
    cleanup: () => { close(); fs.rmSync(dbPath, { force: true }); },
  };
}

test('9. Send Now delivers through the USER ACCOUNT, not the bot', async (t) => {
  const h = bootQueue();
  t.after(h.cleanup);

  const result = await h.broadcaster.deliver({ group: h.group(), campaign: h.campaign(), trigger: 'manual' });

  assert.equal(result.status, 'sent');
  assert.equal(result.senderKind, 'user');
  assert.equal(h.mt.sent.length, 1, 'the MTProto client sent it');
  assert.equal(h.bot.sent.length, 0, 'the bot sent nothing');
  assert.equal(String(h.mt.sent[0].peer.channelId), '1000000001');
  assert.equal(String(h.mt.sent[0].peer.accessHash), '1111111111111111110');
});

test('10. the scheduler delivers through the USER ACCOUNT when due', async (t) => {
  const h = bootQueue();
  t.after(h.cleanup);

  const summary = await h.scheduler.tick();

  assert.equal(summary.sent, 1);
  assert.equal(h.mt.sent.length, 1);
  assert.equal(h.bot.sent.length, 0);
  assert.equal(h.group().last_send_at !== null, true);
});

test('11. FLOOD_WAIT is respected exactly and holds the whole account', async (t) => {
  const h = bootQueue({ groupCount: 3 });
  t.after(h.cleanup);
  h.mt.failNext(new FloodWaitError({ request: {}, capture: 300 }));

  const result = await h.broadcaster.deliver({ group: h.group(0), campaign: h.campaign(), trigger: 'scheduled', scheduledFor: h.group(0).next_send_at });

  assert.equal(result.status, 'deferred', 'not counted as a failure');
  assert.equal(result.reason, REASONS.FLOOD_WAIT);
  assert.equal(result.scope, 'account');
  assert.equal(result.waitSeconds, 300, 'the exact wait Telegram asked for');

  // The hold is account-wide and stored, so a restart still honours it.
  assert.equal(h.q.isFloodGated(h.clock.at), true);
  const until = new Date(h.q.getFloodWaitUntil()).getTime();
  const expected = h.clock.at.getTime() + (300 + h.config.floodWaitMarginSeconds) * 1000;
  assert.equal(until, expected, 'hold = requested wait + safety margin, never less');

  // The ad is kept, not discarded, and is not flagged as a broken group.
  assert.equal(h.group(0).delivery_problem, 0);
  assert.equal(new Date(h.group(0).next_send_at).getTime() >= h.clock.at.getTime() + 300 * 1000, true);
});

test('11b. while the account is flood-held the scheduler sends nothing', async (t) => {
  const h = bootQueue({ groupCount: 3 });
  t.after(h.cleanup);
  h.q.setFloodWaitUntil(new Date(h.clock.at.getTime() + 10 * MINUTE).toISOString());

  const summary = await h.scheduler.tick();

  assert.equal(summary.sent, 0);
  assert.equal(summary.floodHeld, 3, 'every user group was held');
  assert.equal(h.mt.sent.length, 0);

  // Slots are untouched, so nothing is lost while waiting.
  assert.equal(h.group(0).next_send_at, h.groups[0].next_send_at);

  // Once the hold expires, sending resumes.
  h.advance(11 * MINUTE);
  const after = await h.scheduler.tick();
  assert.equal(after.sent, 3);
});

test('11c. a longer flood hold is never shortened by a later shorter one', async (t) => {
  const h = bootQueue();
  t.after(h.cleanup);

  h.sendQueue.applyAccountWait(3600);
  const long = h.q.getFloodWaitUntil();
  h.sendQueue.applyAccountWait(30);

  assert.equal(h.q.getFloodWaitUntil(), long, 'the longer hold stands');
});

test('11d. PEER_FLOOD backs off hard instead of retrying', async (t) => {
  const h = bootQueue();
  t.after(h.cleanup);
  h.mt.failNext(new PeerFloodError({ request: {} }));

  const result = await h.broadcaster.deliver({ group: h.group(), campaign: h.campaign(), trigger: 'manual' });

  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, REASONS.PEER_FLOOD);
  assert.equal(result.scope, 'account');
  assert.ok(result.waitSeconds >= 3600, `backs off for hours, got ${result.waitSeconds}s`);
  assert.equal(h.q.isFloodGated(h.clock.at), true);
  assert.equal(h.mt.sent.length, 0, 'no retry was attempted');
});

test('12. SLOWMODE_WAIT defers only that chat, not the account', async (t) => {
  const h = bootQueue({ groupCount: 2 });
  t.after(h.cleanup);
  h.mt.failNext(new SlowModeWaitError({ request: {}, capture: 45 }));

  const result = await h.broadcaster.deliver({ group: h.group(0), campaign: h.campaign(), trigger: 'scheduled', scheduledFor: h.group(0).next_send_at });

  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, REASONS.SLOWMODE_WAIT);
  assert.equal(result.scope, 'chat');
  assert.equal(result.waitSeconds, 45);

  // Crucially: the ACCOUNT is not gated, so other groups still go out.
  assert.equal(h.q.isFloodGated(h.clock.at), false);
  const other = await h.broadcaster.deliver({ group: h.group(1), campaign: h.campaign(), trigger: 'manual' });
  assert.equal(other.status, 'sent');

  // The deferred group is rescheduled for after the slow-mode window.
  assert.ok(new Date(h.group(0).next_send_at).getTime() >= h.clock.at.getTime());
  assert.equal(h.group(0).delivery_problem, 0);
});

test('12b. a deferred slot is retried later rather than lost', async (t) => {
  const h = bootQueue();
  t.after(h.cleanup);
  const slot = h.group().next_send_at;
  h.mt.failNext(new SlowModeWaitError({ request: {}, capture: 60 }));

  const deferred = await h.broadcaster.deliver({ group: h.group(), campaign: h.campaign(), trigger: 'scheduled', scheduledFor: slot });
  assert.equal(deferred.status, 'deferred');
  // The claim was released, so the advertisement is not stuck as "already sent".
  assert.equal(h.q.getDeliveryByKey(`s:${h.group().chat_id}:${slot}`), null);

  h.advance(2 * MINUTE);
  const retry = await h.scheduler.tick();
  assert.equal(retry.sent, 1, 'the delayed ad went out on the next due tick');
  assert.equal(h.mt.sent.length, 1);
});

test('13. multiple due groups are queued one at a time, never blasted', async (t) => {
  const h = bootQueue({ groupCount: 4, overrides: { USER_SEND_DELAY_MS: '20000' } });
  t.after(h.cleanup);

  let maxConcurrent = 0;
  let current = 0;
  const originalSend = h.mt.sendMessage.bind(h.mt);
  h.mt.sendMessage = async (...args) => {
    current += 1;
    maxConcurrent = Math.max(maxConcurrent, current);
    const result = await originalSend(...args);
    current -= 1;
    return result;
  };

  const summary = await h.scheduler.tick();

  assert.equal(summary.sent, 4);
  assert.equal(maxConcurrent, 1, 'only ever one send in flight');
  // A ~20s gap was enforced between each pair of consecutive sends.
  const longGaps = h.sleeps.filter((ms) => ms >= 19000);
  assert.equal(longGaps.length, 3, `3 inter-send delays for 4 groups (saw ${h.sleeps})`);
  assert.ok(longGaps.every((ms) => ms <= 20000), 'gaps never exceed the configured delay');
});

test('13b. the queue serialises even when jobs are enqueued together', async (t) => {
  const h = bootQueue();
  t.after(h.cleanup);
  const order = [];

  const jobs = [1, 2, 3].map((n) => h.sendQueue.enqueue(async () => {
    order.push(`start-${n}`);
    await new Promise((resolve) => setImmediate(resolve));
    order.push(`end-${n}`);
    return n;
  }));
  const results = await Promise.all(jobs);

  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3'], 'no interleaving');
});

test('13c. the queue waits out an account hold before running a job', async (t) => {
  const h = bootQueue();
  t.after(h.cleanup);
  h.q.setFloodWaitUntil(new Date(h.clock.at.getTime() + 5 * MINUTE).toISOString());

  let ran = false;
  await h.sendQueue.enqueue(async () => { ran = true; return 'done'; });

  assert.equal(ran, true, 'the job eventually ran');
  assert.ok(h.sleeps.some((ms) => ms >= 4 * MINUTE), `slept out the hold (saw ${h.sleeps})`);
});

test('14b. a restart does not resend a scheduled slot delivered as the user', async (t) => {
  const h = bootQueue();
  t.after(h.cleanup);
  const slot = h.group().next_send_at;

  const first = await h.broadcaster.deliver({ group: h.group(), campaign: h.campaign(), trigger: 'scheduled', scheduledFor: slot });
  const second = await h.broadcaster.deliver({ group: h.group(), campaign: h.campaign(), trigger: 'scheduled', scheduledFor: slot });

  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'duplicate');
  assert.equal(h.mt.sent.length, 1, 'exactly one message reached Telegram');
});

test('8c. a disabled user group receives nothing from the scheduler', async (t) => {
  const h = bootQueue({ groupCount: 2 });
  t.after(h.cleanup);
  h.q.updateGroup(h.group(0).chat_id, { enabled: 0 });

  const summary = await h.scheduler.tick();

  assert.equal(summary.sent, 1);
  assert.equal(h.mt.sent.length, 1);
  assert.equal(String(h.mt.sent[0].peer.channelId), '1000000002');
});

test('9b. when the user sender is down, delivery fails safely without sending', async (t) => {
  const h = bootQueue();
  t.after(h.cleanup);
  await h.userSender.disconnect();

  const result = await h.broadcaster.deliver({ group: h.group(), campaign: h.campaign(), trigger: 'manual' });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, REASONS.SENDER_UNAVAILABLE);
  assert.equal(result.permanent, false, 'retryable once the session is fixed');
  assert.equal(h.mt.sent.length, 0);
  // No slot was consumed, so the ad can still go out later.
  assert.equal(h.q.deliveryStats({}).sentTotal, 0);
});

test('19b. SIGTERM disconnects the user client and drops queued sends', async (t) => {
  const h = bootQueue();
  t.after(h.cleanup);
  const dbPath = makeTempDbPath('shutdown-mt');
  const { dbInfo, close } = openTestDb(dbPath);
  t.after(() => { close(); fs.rmSync(dbPath, { force: true }); });

  const order = [];
  const scheduler = { stop: () => order.push('scheduler') };
  const bot = { stopPolling: async () => order.push('polling') };
  let exitCode = null;

  // Queue work that must NOT run once shutdown begins.
  let ranAfterStop = false;
  h.q.setFloodWaitUntil(new Date(h.clock.at.getTime() + HOUR).toISOString());
  h.sendQueue.enqueue(async () => { ranAfterStop = true; });

  const shutdown = createShutdown({
    scheduler, bot, userSender: h.userSender, sendQueue: h.sendQueue, dbInfo,
    exit: (code) => { exitCode = code; },
  });
  await shutdown('SIGTERM');

  assert.equal(exitCode, 0);
  assert.deepEqual(order, ['scheduler', 'polling']);
  assert.equal(h.userSender.isConnected(), false, 'MTProto client disconnected');
  assert.equal(h.mt.disconnectCount >= 1, true);
  assert.equal(ranAfterStop, false, 'queued send was dropped, not fired mid-shutdown');
  assert.equal(dbInfo.db.open, false, 'database closed');
});

test('20b. SQLite stays healthy through rate-limit churn', async (t) => {
  const h = bootQueue({ groupCount: 3 });
  t.after(h.cleanup);
  const { integrityCheck } = require('../database/db');

  for (let round = 0; round < 6; round += 1) {
    if (round % 2 === 0) h.mt.failNext(new SlowModeWaitError({ request: {}, capture: 30 }));
    // eslint-disable-next-line no-await-in-loop
    await h.scheduler.tick();
    h.q.setFloodWaitUntil(null);
    h.advance(2 * HOUR);
  }

  assert.equal(integrityCheck(h.dbInfo.db).ok, true, 'database still healthy');
  assert.equal(h.q.countGroups(), 3, 'no group was lost');
  assert.ok(h.q.deliveryStats({}).sentTotal > 0, 'sends were recorded');
});

test('waitPlanFor maps each wait error to the right scope', () => {
  const config = testConfig();
  assert.deepEqual(waitPlanFor({ reason: REASONS.FLOOD_WAIT, waitSeconds: 90 }, config), { scope: 'account', waitSeconds: 90 });
  assert.deepEqual(waitPlanFor({ reason: REASONS.SLOWMODE_WAIT, waitSeconds: 20 }, config), { scope: 'chat', waitSeconds: 20 });
  assert.equal(waitPlanFor({ reason: REASONS.FLOOD_WAIT, waitSeconds: null }, config).waitSeconds, 60, 'sane default when no number given');
  assert.equal(waitPlanFor({ reason: REASONS.WRITE_FORBIDDEN }, config), null, 'not a wait error');
});
