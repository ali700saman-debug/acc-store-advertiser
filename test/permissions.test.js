'use strict';

/**
 * Regression tests for the remaining production failures:
 *
 *   - "query is too old and response timeout expired or query ID is invalid"
 *   - WRITE_FORBIDDEN / BANNED_IN_CHAT retried on every scheduler tick
 *   - imports going straight to enabled
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { createApp } = require('../index');
const { ensureDefaultCampaign } = require('../database/seed');
const { createBroadcaster } = require('../services/broadcaster');
const { createScheduler } = require('../services/scheduler');
const { createUserSender, REASONS } = require('../services/userSender');
const { createSendQueue } = require('../services/sendQueue');
const { resetAnsweredQueries } = require('../handlers/common');
const { FloodWaitError } = require('teleproto/errors');
const {
  FakeBot, FakeMTProtoClient, fakeDialog, makeTempDbPath, testConfig, openTestDb,
  callbackQuery, privateMessage, ADMIN_ID,
} = require('./helpers');

const MINUTE = 60 * 1000;

function boot({ dialogs = [], overrides = {} } = {}) {
  const dbPath = makeTempDbPath('perm');
  const { dbInfo, q, close } = openTestDb(dbPath);
  const config = testConfig({ USER_SEND_DELAY_MS: '1', ...overrides });
  const bot = new FakeBot();
  const mt = new FakeMTProtoClient({ dialogs });
  const ctx = createApp({ bot, config, dbInfo, createClient: () => mt });
  ctx.botInfo = { id: 777, username: 'AD_SENDER_9_bot' };
  ensureDefaultCampaign(q, config);
  resetAnsweredQueries();
  return { bot, mt, ctx, q, config, dbInfo, cleanup: () => { close(); fs.rmSync(dbPath, { force: true }); } };
}

/** A user-account group that is registered AND enabled, ready to send. */
function enabledUserGroup(q, { chatId = -1001000000001, title = 'Market' } = {}) {
  q.registerUserGroup({ chat_id: chatId, title, type: 'supergroup', peer_type: 'channel', access_hash: '123456789' });
  q.updateGroup(chatId, { enabled: 1, next_send_at: new Date().toISOString() });
  return q.getGroup(chatId);
}

// ------------------------------------------------------ B: callback timeouts

test('7. the callback is acknowledged BEFORE the slow dialog fetch completes', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  await h.ctx.userSender.connect();

  const order = [];
  const originalAnswer = h.bot.answerCallbackQuery.bind(h.bot);
  h.bot.answerCallbackQuery = async (...args) => { order.push('answered'); return originalAnswer(...args); };

  // A deliberately slow getDialogs, like a real MTProto round trip.
  h.mt.getDialogs = async () => {
    order.push('dialogs-start');
    await new Promise((resolve) => setTimeout(resolve, 60));
    order.push('dialogs-end');
    return [fakeDialog({ id: 1000000001, title: 'Slow Group' })];
  };

  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));

  assert.equal(order[0], 'answered', `acknowledged first, got ${order.join(' -> ')}`);
  assert.ok(order.indexOf('answered') < order.indexOf('dialogs-end'), 'answered before the fetch finished');
  assert.ok(h.bot.edits.length > 0, 'and the panel still rendered');
});

test('8. an expired callback acknowledgement does not crash anything', async (t) => {
  const h = boot({ dialogs: [fakeDialog({ id: 1000000001, title: 'Group' })] });
  t.after(h.cleanup);
  await h.ctx.userSender.connect();

  // Exactly what Telegram returned in production.
  h.bot.answerCallbackQuery = async () => {
    const error = new Error('ETELEGRAM: 400 Bad Request: query is too old and response timeout expired or query ID is invalid');
    error.response = { body: { ok: false, error_code: 400, description: 'query is too old and response timeout expired or query ID is invalid' } };
    throw error;
  };

  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));

  // The work still happened and the panel still rendered.
  assert.ok(h.bot.edits.length > 0, 'panel rendered despite the expired query');
  const panel = h.bot.edits[h.bot.edits.length - 1];
  assert.match(panel.text, /Import My Groups/);
});

test('8b. a query is answered at most once, so no "query ID is invalid"', async (t) => {
  const h = boot({ dialogs: [fakeDialog({ id: 1000000001, title: 'Group' })] });
  t.after(h.cleanup);
  await h.ctx.userSender.connect();

  const query = callbackQuery('sndr:imp:0');
  await h.bot.feedCallback(query);

  const answersForQuery = h.bot.answers.filter((a) => a.id === query.id);
  assert.equal(answersForQuery.length, 1, `answered exactly once (got ${answersForQuery.length})`);
});

test('8c. a slow Send Now is acknowledged before the broadcast runs', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  await h.ctx.userSender.connect();
  enabledUserGroup(h.q);

  const order = [];
  const originalAnswer = h.bot.answerCallbackQuery.bind(h.bot);
  h.bot.answerCallbackQuery = async (...args) => { order.push('answered'); return originalAnswer(...args); };
  const originalSend = h.mt.sendMessage.bind(h.mt);
  h.mt.sendMessage = async (...args) => { order.push('sent'); return originalSend(...args); };

  const campaign = h.q.listCampaigns()[0];
  await h.bot.feedCallback(callbackQuery(`n:go:${campaign.id}:all`));

  assert.equal(order[0], 'answered', `acknowledged before sending, got ${order.join(' -> ')}`);
});

// ------------------------------------------- C/D: permanent permission errors

test('9. WRITE_FORBIDDEN becomes a permanent delivery problem', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  await h.ctx.userSender.connect();
  const group = enabledUserGroup(h.q);
  h.mt.failNext(Object.assign(new Error('CHAT_WRITE_FORBIDDEN'), { errorMessage: 'CHAT_WRITE_FORBIDDEN' }));

  const result = await h.ctx.broadcaster.deliver({ group, campaign: h.q.listCampaigns()[0], trigger: 'manual' });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, REASONS.WRITE_FORBIDDEN);
  assert.equal(result.permanent, true);
  assert.equal(result.blocked, true);

  const after = h.q.getGroup(group.chat_id);
  assert.equal(after.blocked_reason, REASONS.WRITE_FORBIDDEN);
  assert.equal(after.delivery_problem, 1);
  assert.equal(after.enabled, 0, 'automatic sending switched off');
  assert.ok(after.blocked_at, 'blocked timestamp recorded');
});

test('10. BANNED_IN_CHAT becomes a permanent delivery problem', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  await h.ctx.userSender.connect();
  const group = enabledUserGroup(h.q);
  h.mt.failNext(Object.assign(new Error('USER_BANNED_IN_CHANNEL'), { errorMessage: 'USER_BANNED_IN_CHANNEL' }));

  const result = await h.ctx.broadcaster.deliver({ group, campaign: h.q.listCampaigns()[0], trigger: 'manual' });

  assert.equal(result.reason, REASONS.BANNED_IN_CHAT);
  assert.equal(result.blocked, true);
  const after = h.q.getGroup(group.chat_id);
  assert.equal(after.blocked_reason, REASONS.BANNED_IN_CHAT);
  assert.equal(after.enabled, 0);
});

test('11. permanent failures are NOT retried on every scheduler tick', async (t) => {
  const dbPath = makeTempDbPath('noretry');
  const { dbInfo, q, close } = openTestDb(dbPath);
  t.after(() => { close(); fs.rmSync(dbPath, { force: true }); });

  const config = testConfig({ USER_SEND_DELAY_MS: '1' });
  const mt = new FakeMTProtoClient();
  const clock = { at: new Date('2026-09-22T12:00:00Z') };
  const userSender = createUserSender({ config, createClient: () => mt });
  userSender._setClient(mt);
  const sendQueue = createSendQueue({ q, config, sleep: async () => {}, now: () => clock.at });
  const broadcaster = createBroadcaster({ q, telegram: null, userSender, sendQueue, config, sleep: async () => {}, now: () => clock.at });
  const scheduler = createScheduler({ q, broadcaster, config, now: () => clock.at, sleep: async () => {} });
  ensureDefaultCampaign(q, config);

  q.registerUserGroup({ chat_id: -1001000000001, title: 'Banned Group', type: 'supergroup', peer_type: 'channel', access_hash: '1' });
  q.updateGroup(-1001000000001, { enabled: 1, next_send_at: clock.at.toISOString() });

  // Every attempt is refused permanently.
  mt.failNext(Object.assign(new Error('CHAT_WRITE_FORBIDDEN'), { errorMessage: 'CHAT_WRITE_FORBIDDEN' }), { times: 99 });

  const first = await scheduler.tick();
  assert.equal(first.failed, 1, 'one attempt was made');
  assert.equal(mt.sent.length, 0);

  // 60 further minutes of ticks must produce no further attempts.
  let attempts = 0;
  const countingSend = mt.sendMessage.bind(mt);
  mt.sendMessage = async (...args) => { attempts += 1; return countingSend(...args); };

  for (let i = 0; i < 60; i += 1) {
    clock.at = new Date(clock.at.getTime() + MINUTE);
    // eslint-disable-next-line no-await-in-loop
    const summary = await scheduler.tick();
    assert.equal(summary.checked, 0, `tick ${i}: the blocked group is not even due`);
  }
  assert.equal(attempts, 0, 'no retry against a permanently refused group');
});

test('12. Re-check Permission can recover a blocked group', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  await h.ctx.userSender.connect();
  const group = enabledUserGroup(h.q);

  h.mt.failNext(Object.assign(new Error('CHAT_WRITE_FORBIDDEN'), { errorMessage: 'CHAT_WRITE_FORBIDDEN' }));
  await h.ctx.broadcaster.deliver({ group, campaign: h.q.listCampaigns()[0], trigger: 'manual' });
  assert.equal(h.q.getGroup(group.chat_id).blocked_reason, REASONS.WRITE_FORBIDDEN);

  // Permission restored in Telegram; the admin re-checks.
  await h.bot.feedCallback(callbackQuery(`g:perm:${group.chat_id}`));

  const after = h.q.getGroup(group.chat_id);
  assert.equal(after.blocked_reason, null, 'block cleared');
  assert.equal(after.delivery_problem, 0);
  assert.equal(after.enabled, 0, 'still off until the admin re-enables deliberately');
  assert.match(h.bot.allText(), /Press ✅ Enable to resume/);

  // The admin enables it, and sending works again.
  await h.bot.feedCallback(callbackQuery(`g:tog:${group.chat_id}`));
  assert.equal(h.q.getGroup(group.chat_id).enabled, 1);
  const result = await h.ctx.broadcaster.deliver({ group: h.q.getGroup(group.chat_id), campaign: h.q.listCampaigns()[0], trigger: 'manual' });
  assert.equal(result.status, 'sent');
});

test('12b. a failed re-check keeps the group blocked', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  await h.ctx.userSender.connect();
  const group = enabledUserGroup(h.q);

  h.mt.failNext(Object.assign(new Error('CHAT_WRITE_FORBIDDEN'), { errorMessage: 'CHAT_WRITE_FORBIDDEN' }), { times: 5 });
  await h.bot.feedCallback(callbackQuery(`g:perm:${group.chat_id}`));

  const after = h.q.getGroup(group.chat_id);
  assert.ok(after.blocked_reason, 'still blocked');
  assert.equal(after.enabled, 0);
  assert.match(h.bot.allText(), /Automatic sending stays off/);
});

test('12c. the group panel explains the block and offers a re-check', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  const group = enabledUserGroup(h.q);
  h.q.markGroupBlocked(group.chat_id, { reason: 'BANNED_IN_CHAT', message: 'The account is banned in this chat' });

  await h.bot.feedCallback(callbackQuery(`g:v:${group.chat_id}`));

  const panel = h.bot.edits[h.bot.edits.length - 1];
  assert.match(panel.text, /Blocked by Telegram/);
  assert.match(panel.text, /BANNED_IN_CHAT/);
  assert.match(panel.text, /not retried every tick/);
  const labels = panel.options.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((l) => l.includes('Re-check Permission')), 'a re-check button is offered');
});

test('12d. blocking never deletes history', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  await h.ctx.userSender.connect();
  const group = enabledUserGroup(h.q);
  const claim = h.q.claimDelivery({ key: 'history-1', campaignId: 1, chatId: group.chat_id });
  h.q.markDeliverySent(claim.delivery.id, 42);

  h.mt.failNext(Object.assign(new Error('CHAT_WRITE_FORBIDDEN'), { errorMessage: 'CHAT_WRITE_FORBIDDEN' }));
  await h.ctx.broadcaster.deliver({ group, campaign: h.q.listCampaigns()[0], trigger: 'manual' });

  assert.ok(h.q.getGroup(group.chat_id), 'group still registered');
  assert.equal(h.q.deliveryStats({}).sentTotal, 1, 'past deliveries kept');
  assert.equal(h.q.getGroup(group.chat_id).campaign_id, group.campaign_id, 'settings kept');
});

// ------------------------------------------------------------- E: flood waits

test('13. FLOOD_WAIT still holds the queue and is not a permanent failure', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  await h.ctx.userSender.connect();
  const group = enabledUserGroup(h.q);
  h.mt.failNext(new FloodWaitError({ request: {}, capture: 300 }));

  const result = await h.ctx.broadcaster.deliver({ group, campaign: h.q.listCampaigns()[0], trigger: 'scheduled', scheduledFor: group.next_send_at });

  assert.equal(result.status, 'deferred', 'not a failure');
  assert.equal(result.waitSeconds, 300, 'Telegram\'s wait is not shortened');
  assert.equal(h.q.isFloodGated(), true, 'queue held');

  const after = h.q.getGroup(group.chat_id);
  assert.equal(after.blocked_reason, null, 'a rate limit is NOT a permanent block');
  assert.equal(after.enabled, 1, 'the group stays enabled');
  assert.equal(after.delivery_problem, 0);
});

// ------------------------------------------- F/G: import is safe by default

test('14. importing a group never sends an advertisement', async (t) => {
  const h = boot({
    dialogs: [
      fakeDialog({ id: 1000000001, title: 'Group One' }),
      fakeDialog({ id: 1000000002, title: 'Group Two' }),
      fakeDialog({ id: 1000000003, title: 'Group Three' }),
    ],
  });
  t.after(h.cleanup);
  await h.ctx.userSender.connect();

  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:1'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:2'));
  await h.bot.feedCallback(callbackQuery('sndr:add'));

  assert.equal(h.q.countGroups(), 3, 'all three registered');
  assert.equal(h.mt.sent.length, 0, 'not a single advertisement was sent');

  // And a scheduler tick right afterwards still sends nothing.
  const summary = await h.ctx.scheduler.tick();
  assert.equal(summary.sent, 0);
  assert.equal(summary.checked, 0, 'no imported group is due, because none is enabled');
  assert.equal(h.mt.sent.length, 0);
});

test('15. newly imported groups are disabled by default', async (t) => {
  const h = boot({
    dialogs: [fakeDialog({ id: 1000000001, title: 'One' }), fakeDialog({ id: 1000000002, title: 'Two' })],
  });
  t.after(h.cleanup);
  await h.ctx.userSender.connect();

  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:1'));
  await h.bot.feedCallback(callbackQuery('sndr:add'));

  for (const chatId of [-1001000000001, -1001000000002]) {
    assert.equal(h.q.getGroup(chatId).enabled, 0, `${chatId} starts disabled`);
  }
  assert.equal(h.q.countEnabledGroups(), 0);
  // And the admin is told, so this is not a silent surprise.
  assert.match(h.bot.edits[h.bot.edits.length - 1].text, /start <b>disabled<\/b>/);
});

test('15b. re-importing does not change a group the admin already enabled', async (t) => {
  const h = boot({ dialogs: [fakeDialog({ id: 1000000001, title: 'One' })] });
  t.after(h.cleanup);
  await h.ctx.userSender.connect();

  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:0'));
  await h.bot.feedCallback(callbackQuery('sndr:add'));
  h.q.updateGroup(-1001000000001, { enabled: 1 });

  await h.bot.feedCallback(callbackQuery('sndr:ref'));
  await h.bot.feedCallback(callbackQuery('sndr:add'));

  assert.equal(h.q.getGroup(-1001000000001).enabled, 1, 'still enabled after a re-import');
});

test('15c. /register_group stays enabled — it is an explicit per-group action', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  const { groupMessage, GROUP_ID } = require('./helpers');

  await h.bot.feedMessage(groupMessage('/register_group'));

  assert.equal(h.q.getGroup(GROUP_ID).enabled, 1);
});

// ------------------------------------------------- 17/18: nothing else broke

test('17. the admin bot still works end to end', async (t) => {
  const h = boot({ dialogs: [fakeDialog({ id: 1000000001, title: 'Group' })] });
  t.after(h.cleanup);
  await h.ctx.userSender.connect();

  await h.bot.feedMessage(privateMessage('/start'));
  assert.match(h.bot.lastMessage().text, /ACC STORE Advertiser/);

  await h.bot.feedCallback(callbackQuery('st:home'));
  assert.match(h.bot.edits[h.bot.edits.length - 1].text, /Statistics/);

  await h.bot.feedCallback(callbackQuery('s:pause'));
  assert.equal(h.q.isPaused(), true);
  await h.bot.feedCallback(callbackQuery('s:pause'));
  assert.equal(h.q.isPaused(), false);

  await h.bot.feedMessage(privateMessage('/status'));
  assert.match(h.bot.lastMessage().text, /Advertiser Status/);
});

test('18. the user sender still connects and reports safely', async (t) => {
  const h = boot({ dialogs: [fakeDialog({ id: 1000000001, title: 'Group' })] });
  t.after(h.cleanup);

  const status = await h.ctx.userSender.connect();
  assert.equal(status.connected, true);

  await h.bot.feedCallback(callbackQuery('sndr:home'));
  const panel = h.bot.edits[h.bot.edits.length - 1];
  assert.match(panel.text, /User sender: 🟢 Connected/);
  assert.equal(panel.text.includes(h.config.userSession), false);
  assert.equal(panel.text.includes(h.config.userApiHash), false);
});
