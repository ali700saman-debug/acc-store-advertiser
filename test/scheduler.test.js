'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { createQueries } = require('../database/queries');
const { openDatabase, closeDatabase } = require('../database/db');
const { createTelegramService } = require('../services/telegram');
const { createBroadcaster } = require('../services/broadcaster');
const { createScheduler } = require('../services/scheduler');
const { ensureDefaultCampaign } = require('../database/seed');
const policy = require('../services/policy');
const { FakeBot, makeTempDbPath, testConfig, openTestDb, GROUP_ID } = require('./helpers');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Scheduler wired to a controllable clock so nothing depends on wall time. */
function bootScheduler(overrides = {}) {
  const dbPath = makeTempDbPath('scheduler');
  const { dbInfo, q, close } = openTestDb(dbPath);
  const config = testConfig(overrides);
  const bot = new FakeBot();
  const clock = { at: new Date('2026-09-22T12:00:00Z') };
  const now = () => clock.at;

  const telegram = createTelegramService({ bot, sleep: async () => {} });
  const broadcaster = createBroadcaster({ q, telegram, config, sleep: async () => {}, now });
  const scheduler = createScheduler({ q, broadcaster, config, now, sleep: async () => {} });

  ensureDefaultCampaign(q, config);

  return {
    bot, q, config, clock, scheduler, broadcaster, dbPath,
    advance: (ms) => { clock.at = new Date(clock.at.getTime() + ms); },
    cleanup: () => { close(); fs.rmSync(dbPath, { force: true }); },
  };
}

function registerGroup(q, clock, { chatId = GROUP_ID, title = 'Tech Group', dueIn = 0 } = {}) {
  const { group } = q.registerGroup({ chat_id: chatId, title, type: 'supergroup' });
  q.updateGroup(chatId, { next_send_at: new Date(clock.at.getTime() + dueIn).toISOString() });
  return group;
}

test('14. the scheduler sends only when a group is due', async (t) => {
  const { bot, q, clock, scheduler, advance, cleanup } = bootScheduler();
  t.after(cleanup);
  registerGroup(q, clock, { dueIn: 2 * HOUR });

  let summary = await scheduler.tick();
  assert.equal(summary.sent, 0);
  assert.equal(bot.sent.length, 0, 'nothing sent before the slot arrives');

  advance(2 * HOUR);
  summary = await scheduler.tick();
  assert.equal(summary.sent, 1);
  assert.equal(bot.messagesTo(GROUP_ID).length, 1);
});

test('14b. a tick a minute later does not send again', async (t) => {
  const { bot, q, clock, scheduler, advance, cleanup } = bootScheduler();
  t.after(cleanup);
  registerGroup(q, clock);

  await scheduler.tick();
  assert.equal(bot.messagesTo(GROUP_ID).length, 1);

  for (let i = 0; i < 10; i += 1) {
    advance(MINUTE);
    // eslint-disable-next-line no-await-in-loop
    await scheduler.tick();
  }
  assert.equal(bot.messagesTo(GROUP_ID).length, 1, 'still exactly one ad after ten minutes of ticks');

  advance(6 * HOUR);
  await scheduler.tick();
  assert.equal(bot.messagesTo(GROUP_ID).length, 2, 'the next ad goes out one interval later');
});

test('4. unregistered groups never receive automated ads', async (t) => {
  const { bot, scheduler, cleanup } = bootScheduler();
  t.after(cleanup);

  const summary = await scheduler.tick();

  assert.equal(summary.checked, 0);
  assert.equal(bot.sent.length, 0, 'the bot messages nothing it was not given');
});

test('5. a disabled group receives no automated ads', async (t) => {
  const { bot, q, clock, scheduler, cleanup } = bootScheduler();
  t.after(cleanup);
  registerGroup(q, clock);
  q.updateGroup(GROUP_ID, { enabled: 0 });

  const summary = await scheduler.tick();

  assert.equal(summary.checked, 0);
  assert.equal(bot.messagesTo(GROUP_ID).length, 0);
});

test('15. the same scheduled slot is never sent twice', async (t) => {
  const { bot, q, clock, scheduler, broadcaster, cleanup } = bootScheduler();
  t.after(cleanup);
  registerGroup(q, clock);
  const group = q.getGroup(GROUP_ID);
  const campaign = q.listCampaigns()[0];
  const slot = group.next_send_at;

  const first = await broadcaster.deliver({ group, campaign, trigger: 'scheduled', scheduledFor: slot });
  const second = await broadcaster.deliver({ group, campaign, trigger: 'scheduled', scheduledFor: slot });

  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'duplicate');
  assert.equal(bot.messagesTo(GROUP_ID).length, 1);
  assert.equal(q.deliveryStats({}).sentTotal, 1);
});

test('16. a crash between sending and bookkeeping does not duplicate after restart', async (t) => {
  const { bot, q, clock, scheduler, dbPath, cleanup } = bootScheduler();
  t.after(cleanup);
  registerGroup(q, clock);
  const slotBeforeCrash = q.getGroup(GROUP_ID).next_send_at;

  await scheduler.tick();
  assert.equal(bot.messagesTo(GROUP_ID).length, 1);

  // Simulate a crash right after Telegram accepted the message but before the
  // group's next slot was persisted: the slot still points at the sent one.
  q.updateGroup(GROUP_ID, { next_send_at: slotBeforeCrash });

  // Restart: reopen the same database file and rebuild the whole graph.
  const reopened = openDatabase({ dbPath });
  const q2 = createQueries(reopened.db);
  const bot2 = new FakeBot();
  const telegram2 = createTelegramService({ bot: bot2, sleep: async () => {} });
  const broadcaster2 = createBroadcaster({ q: q2, telegram: telegram2, config: testConfig(), sleep: async () => {}, now: () => clock.at });
  const scheduler2 = createScheduler({ q: q2, broadcaster: broadcaster2, config: testConfig(), now: () => clock.at, sleep: async () => {} });

  const summary = await scheduler2.tick();

  assert.equal(bot2.messagesTo(GROUP_ID).length, 0, 'no advertisement is resent after the restart');
  assert.equal(summary.duplicate, 1, 'the slot was recognised as already delivered');
  assert.notEqual(q2.getGroup(GROUP_ID).next_send_at, slotBeforeCrash, 'the group moves on to the next slot');
  closeDatabase(reopened.db);
});

test('24. the database survives a restart with its schedule intact', async (t) => {
  const { q, clock, dbPath, cleanup } = bootScheduler();
  t.after(cleanup);
  registerGroup(q, clock);
  q.updateGroup(GROUP_ID, { interval_minutes: 720 });
  const snapshot = q.getGroup(GROUP_ID);

  const reopened = openDatabase({ dbPath });
  const q2 = createQueries(reopened.db);

  const restored = q2.getGroup(GROUP_ID);
  assert.equal(restored.interval_minutes, 720);
  assert.equal(restored.next_send_at, snapshot.next_send_at);
  assert.equal(q2.countCampaigns(), 1);
  closeDatabase(reopened.db);
});

test('17. campaign rotation cycles A -> B -> C -> A and survives a restart', async (t) => {
  const { bot, q, clock, scheduler, advance, dbPath, cleanup } = bootScheduler();
  t.after(cleanup);
  registerGroup(q, clock);

  const a = q.listCampaigns()[0];
  const b = q.createCampaign({ name: 'Campaign B', text: 'B text' });
  const c = q.createCampaign({ name: 'Campaign C', text: 'C text' });
  q.updateGroup(GROUP_ID, { rotation_enabled: 1 });
  q.setGroupCampaigns(GROUP_ID, [a.id, b.id, c.id]);

  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await scheduler.tick();
    seen.push(q.getGroup(GROUP_ID).last_campaign_id);
    advance(6 * HOUR);
  }
  assert.deepEqual(seen, [a.id, b.id, c.id, a.id]);

  // Rotation position is stored, so a restart continues where it stopped.
  const reopened = openDatabase({ dbPath });
  const q2 = createQueries(reopened.db);
  const broadcaster2 = createBroadcaster({ q: q2, telegram: createTelegramService({ bot, sleep: async () => {} }), config: testConfig(), sleep: async () => {}, now: () => clock.at });
  const next = broadcaster2.resolveCampaign(q2.getGroup(GROUP_ID));
  assert.equal(next.id, b.id, 'continues after the last-used campaign, not from the start');
  closeDatabase(reopened.db);
});

test('17b. a group without rotation always gets its fixed campaign', async (t) => {
  const { q, clock, broadcaster, cleanup } = bootScheduler();
  t.after(cleanup);
  registerGroup(q, clock);
  const b = q.createCampaign({ name: 'Campaign B', text: 'B' });
  q.updateGroup(GROUP_ID, { campaign_id: b.id });

  for (let i = 0; i < 3; i += 1) {
    assert.equal(broadcaster.resolveCampaign(q.getGroup(GROUP_ID)).id, b.id);
  }
});

test('17c. disabled campaigns are skipped by the rotation', (t) => {
  const { q, clock, broadcaster, cleanup } = bootScheduler();
  t.after(cleanup);
  registerGroup(q, clock);
  const a = q.listCampaigns()[0];
  const b = q.createCampaign({ name: 'B', text: 'B', enabled: 0 });
  q.updateGroup(GROUP_ID, { rotation_enabled: 1, last_campaign_id: a.id });
  q.setGroupCampaigns(GROUP_ID, [a.id, b.id]);

  assert.equal(broadcaster.resolveCampaign(q.getGroup(GROUP_ID)).id, a.id, 'disabled campaign never selected');
});

test('18. quiet hours delay an ad instead of discarding it', async (t) => {
  // 02:00 Baghdad is inside the 00:00-08:00 quiet window.
  const { bot, q, clock, scheduler, cleanup } = bootScheduler();
  t.after(cleanup);
  clock.at = new Date('2026-09-22T23:00:00Z'); // 02:00 next day in Asia/Baghdad
  registerGroup(q, clock);
  q.setSetting('quiet_enabled', '1');
  q.setSetting('quiet_start', '00:00');
  q.setSetting('quiet_end', '08:00');

  const summary = await scheduler.tick();

  assert.equal(summary.sent, 0);
  assert.equal(summary.deferred, 1);
  assert.equal(bot.messagesTo(GROUP_ID).length, 0, 'nothing posted during quiet hours');

  const group = q.getGroup(GROUP_ID);
  assert.ok(group.next_send_at, 'the ad is still scheduled, not dropped');
  const deferredTo = new Date(group.next_send_at);
  assert.ok(deferredTo > clock.at, 'moved into the future');
  assert.equal(
    policy.inQuietHours(deferredTo, { enabled: true, start: '00:00', end: '08:00' }, 'Asia/Baghdad'),
    false,
    'lands outside the quiet window'
  );

  // When the window closes the delayed ad goes out.
  clock.at = deferredTo;
  await scheduler.tick();
  assert.equal(bot.messagesTo(GROUP_ID).length, 1);
});

test('18b. a per-group quiet window overrides the global one', async (t) => {
  const { bot, q, clock, scheduler, cleanup } = bootScheduler();
  t.after(cleanup);
  clock.at = new Date('2026-09-22T12:00:00Z'); // 15:00 Baghdad
  registerGroup(q, clock);
  q.updateGroup(GROUP_ID, { quiet_enabled: 1, quiet_start: '14:00', quiet_end: '16:00' });

  const summary = await scheduler.tick();

  assert.equal(summary.deferred, 1);
  assert.equal(bot.messagesTo(GROUP_ID).length, 0);
});

test('23d. Pause All stops the scheduler without touching the schedule', async (t) => {
  const { bot, q, clock, scheduler, cleanup } = bootScheduler();
  t.after(cleanup);
  registerGroup(q, clock);
  const before = q.getGroup(GROUP_ID).next_send_at;
  q.setPaused(true);

  const summary = await scheduler.tick();

  assert.equal(summary.paused, true);
  assert.equal(bot.sent.length, 0);
  assert.equal(q.getGroup(GROUP_ID).next_send_at, before, 'schedule is untouched while paused');

  q.setPaused(false);
  await scheduler.tick();
  assert.equal(bot.messagesTo(GROUP_ID).length, 1, 'resuming picks the ad straight back up');
});

test('9e. the interval floor is enforced everywhere, including stored settings', (t) => {
  const { q, config, cleanup } = bootScheduler();
  t.after(cleanup);
  q.setSetting('default_interval_minutes', '1');

  assert.equal(policy.getDefaultIntervalMinutes(q, config), 60);
  assert.equal(policy.resolveIntervalMinutes(q, config, { interval_minutes: 2 }), 60);
  assert.equal(policy.clampInterval(5, config), 60);
  assert.equal(policy.clampInterval(180, config), 180);
});

test('14c. many due groups are sent one by one, not all at once', async (t) => {
  const { bot, q, clock, scheduler, cleanup } = bootScheduler();
  t.after(cleanup);
  const order = [];
  for (let i = 0; i < 5; i += 1) registerGroup(q, clock, { chatId: -100100 - i, title: `Group ${i}` });

  const summary = await scheduler.tick();

  assert.equal(summary.sent, 5);
  bot.sent.forEach((m) => order.push(m.chat.id));
  assert.equal(new Set(order).size, 5, 'each group received exactly one ad');
});

test('14d. maxSendsPerTick caps how much one tick does', async (t) => {
  const { bot, q, clock, scheduler, cleanup } = bootScheduler({ MAX_SENDS_PER_TICK: '2' });
  t.after(cleanup);
  for (let i = 0; i < 5; i += 1) registerGroup(q, clock, { chatId: -100200 - i, title: `Group ${i}` });

  const summary = await scheduler.tick();

  assert.equal(summary.sent, 2);
  assert.equal(bot.sent.length, 2);
});
