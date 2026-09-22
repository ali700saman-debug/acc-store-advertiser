'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { createApp } = require('../index');
const { ensureDefaultCampaign } = require('../database/seed');
const {
  FakeBot, makeTempDbPath, testConfig, openTestDb,
  privateMessage, groupMessage, callbackQuery,
  ADMIN_ID, STRANGER_ID, GROUP_ID,
} = require('./helpers');

/** Boots the real handler graph against a fake bot and a temp database. */
function boot(overrides = {}) {
  const dbPath = makeTempDbPath('admin');
  const { dbInfo, q, close } = openTestDb(dbPath);
  const config = testConfig(overrides);
  const bot = new FakeBot();
  const ctx = createApp({ bot, config, dbInfo });
  ctx.botInfo = { id: 777, username: 'AdvertiserBot' };
  ensureDefaultCampaign(q, config);
  return {
    bot, ctx, q, config,
    cleanup: () => { close(); fs.rmSync(dbPath, { force: true }); },
  };
}

test('1. unauthorized user cannot access the admin panel', async (t) => {
  const { bot, cleanup } = boot();
  t.after(cleanup);

  await bot.feedMessage(privateMessage('/start', { from: STRANGER_ID }));

  const replies = bot.messagesTo(STRANGER_ID);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, 'This bot is for ACC STORE administration.');
  assert.equal(replies[0].options.reply_markup, undefined, 'no admin keyboard is exposed');
});

test('1b. unauthorized callback data is rejected outright', async (t) => {
  const { bot, ctx, q, cleanup } = boot();
  t.after(cleanup);
  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech', type: 'supergroup' });

  await bot.feedCallback(callbackQuery(`g:rmc:${GROUP_ID}`, { from: STRANGER_ID }));

  assert.ok(q.getGroup(GROUP_ID), 'group was not removed by a non-admin');
  assert.match(bot.answers[0].text, /ACC STORE administration/);
  assert.equal(ctx.sessions.size(), 0);
});

test('1c. admin sees the dashboard', async (t) => {
  const { bot, cleanup } = boot();
  t.after(cleanup);

  await bot.feedMessage(privateMessage('/start'));

  const panel = bot.lastMessage();
  assert.match(panel.text, /ACC STORE Advertiser/);
  const labels = panel.options.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes('📣 Campaigns') && labels.includes('👥 Groups') && labels.includes('🚀 Send Now'));
});

test('2. admin can register a group from inside it', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);

  await bot.feedMessage(groupMessage('/register_group'));

  const group = q.getGroup(GROUP_ID);
  assert.ok(group, 'group is registered');
  assert.equal(group.title, 'Tech Marketplace');
  assert.equal(group.enabled, 1);
  assert.ok(group.next_send_at, 'a first slot is scheduled');
  assert.match(bot.messagesTo(GROUP_ID)[0].text, /registered successfully/);
});

test('2b. non-admin cannot register a group', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);

  await bot.feedMessage(groupMessage('/register_group', { from: STRANGER_ID }));

  assert.equal(q.getGroup(GROUP_ID), null);
  assert.equal(bot.messagesTo(GROUP_ID).length, 0, 'the bot stays silent');
});

test('2c. registration is refused when the bot cannot post', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  bot.setChatMember(GROUP_ID, { status: 'restricted', can_send_messages: false });

  await bot.feedMessage(groupMessage('/register_group'));

  assert.equal(q.getGroup(GROUP_ID), null);
  assert.match(bot.messagesTo(GROUP_ID)[0].text, /Cannot register/);
});

test('3. the same group cannot be registered twice', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);

  await bot.feedMessage(groupMessage('/register_group'));
  bot.reset();
  await bot.feedMessage(groupMessage('/register_group'));

  assert.equal(q.countGroups(), 1);
  assert.match(bot.messagesTo(GROUP_ID)[0].text, /already registered/);
});

test('6. admin can enable and disable a group', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech', type: 'supergroup' });

  await bot.feedCallback(callbackQuery(`g:tog:${GROUP_ID}`));
  assert.equal(q.getGroup(GROUP_ID).enabled, 0);

  await bot.feedCallback(callbackQuery(`g:tog:${GROUP_ID}`));
  assert.equal(q.getGroup(GROUP_ID).enabled, 1);
});

test('7. admin can change a group interval, and the minimum is enforced', async (t) => {
  const { bot, ctx, q, config, cleanup } = boot();
  t.after(cleanup);
  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech', type: 'supergroup' });

  await bot.feedCallback(callbackQuery(`g:si:${GROUP_ID}:1440`));
  assert.equal(q.getGroup(GROUP_ID).interval_minutes, 1440);

  // A custom value below the floor is clamped, never accepted as-is.
  ctx.sessions.set(ADMIN_ID, { type: 'g_interval', chatId: GROUP_ID });
  await bot.feedMessage(privateMessage('5'));
  assert.equal(q.getGroup(GROUP_ID).interval_minutes, 1440, 'the too-small value was rejected');
  assert.match(bot.allText(), /Minimum interval is 1 hour/);

  ctx.sessions.set(ADMIN_ID, { type: 'g_interval', chatId: GROUP_ID });
  await bot.feedMessage(privateMessage('2h'));
  assert.equal(q.getGroup(GROUP_ID).interval_minutes, 120);
  assert.equal(config.minIntervalMinutes, 60);
});

test('22. remove group works and stops all advertising there', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech', type: 'supergroup' });

  await bot.feedCallback(callbackQuery(`g:rmc:${GROUP_ID}`));

  assert.equal(q.getGroup(GROUP_ID), null);
  assert.equal(q.dueGroups(new Date(Date.now() + 86400000).toISOString()).length, 0);
});

test('22b. /unregister_group works from inside the group', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  await bot.feedMessage(groupMessage('/register_group'));
  bot.reset();

  await bot.feedMessage(groupMessage('/unregister_group'));

  assert.equal(q.getGroup(GROUP_ID), null);
  assert.match(bot.messagesTo(GROUP_ID)[0].text, /removed/i);
});

test('23. Pause All stops automatic sending but keeps admin access', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);

  await bot.feedCallback(callbackQuery('s:pause'));
  assert.equal(q.isPaused(), true);

  bot.reset();
  await bot.feedMessage(privateMessage('/start'));
  assert.match(bot.lastMessage().text, /Paused/);
  assert.ok(bot.lastMessage().options.reply_markup, 'admin panel still reachable while paused');

  await bot.feedCallback(callbackQuery('s:pause'));
  assert.equal(q.isPaused(), false);
});

test('13. Send to all asks for confirmation before broadcasting', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech', type: 'supergroup' });
  q.registerGroup({ chat_id: -1009876543210, title: 'Market', type: 'supergroup' });
  const campaign = q.listCampaigns()[0];

  await bot.feedCallback(callbackQuery(`n:all:${campaign.id}`));

  assert.equal(bot.sent.length, 0, 'nothing is broadcast before confirmation');
  const confirm = bot.edits[bot.edits.length - 1];
  assert.match(confirm.text, /Send this campaign to 2 groups\?/);
  const labels = confirm.options.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((l) => l.includes('Confirm')) && labels.some((l) => l.includes('Cancel')));
});

test('12 & 13b. confirmed Send Now reaches every enabled group exactly once', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech', type: 'supergroup' });
  q.registerGroup({ chat_id: -1009876543210, title: 'Market', type: 'supergroup' });
  const campaign = q.listCampaigns()[0];

  await bot.feedCallback(callbackQuery(`n:go:${campaign.id}:all`));

  assert.equal(bot.messagesTo(GROUP_ID).length, 1);
  assert.equal(bot.messagesTo(-1009876543210).length, 1);
  assert.equal(q.deliveryStats({}).sentTotal, 2);
});

test('12b. Send Now to a single group only touches that group', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech', type: 'supergroup' });
  q.registerGroup({ chat_id: -1009876543210, title: 'Market', type: 'supergroup' });
  const campaign = q.listCampaigns()[0];

  await bot.feedCallback(callbackQuery(`n:og:${campaign.id}:${GROUP_ID}`));

  assert.equal(bot.messagesTo(GROUP_ID).length, 1);
  assert.equal(bot.messagesTo(-1009876543210).length, 0);
});

test('23b. manual send still works while advertising is paused', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  q.setPaused(true);
  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech', type: 'supergroup' });
  const campaign = q.listCampaigns()[0];

  await bot.feedCallback(callbackQuery(`n:all:${campaign.id}`));
  assert.match(bot.edits[bot.edits.length - 1].text, /paused/i, 'the pause is called out before confirming');

  await bot.feedCallback(callbackQuery(`n:go:${campaign.id}:all`));
  assert.equal(bot.messagesTo(GROUP_ID).length, 1);
});

test('23c. admin actions are written to the audit log', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);

  await bot.feedMessage(groupMessage('/register_group'));
  await bot.feedCallback(callbackQuery(`g:tog:${GROUP_ID}`));
  await bot.feedCallback(callbackQuery('s:pause'));

  const actions = q.listAudit(10).map((row) => row.action);
  assert.ok(actions.includes('group.register'));
  assert.ok(actions.includes('group.enabled'));
  assert.ok(actions.includes('settings.pause'));
  assert.ok(q.listAudit(10).every((row) => row.admin_id === ADMIN_ID));
});

test('25. /status reports scheduler, database and pause state', async (t) => {
  const { bot, ctx, cleanup } = boot();
  t.after(cleanup);
  ctx.dbInfo.persistent = true;

  await bot.feedMessage(privateMessage('/status'));

  const text = bot.lastMessage().text;
  assert.match(text, /Advertiser Status/);
  assert.match(text, /Auto Ads: ✅ Enabled/);
  assert.match(text, /Database: Persistent/);
});

test('25b. /status is not available to non-admins', async (t) => {
  const { bot, cleanup } = boot();
  t.after(cleanup);

  await bot.feedMessage(privateMessage('/status', { from: STRANGER_ID }));

  assert.equal(bot.messagesTo(STRANGER_ID)[0].text, 'This bot is for ACC STORE administration.');
});

test('18. statistics report group and delivery counts', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech', type: 'supergroup' });
  q.registerGroup({ chat_id: -1009876543210, title: 'Market', type: 'supergroup' });
  q.updateGroup(-1009876543210, { enabled: 0 });
  const claim = q.claimDelivery({ key: 'stat-1', campaignId: 1, chatId: GROUP_ID });
  q.markDeliverySent(claim.delivery.id, 42);

  await bot.feedCallback(callbackQuery('st:home'));

  const text = bot.edits[bot.edits.length - 1].text;
  assert.match(text, /Registered groups: 2/);
  assert.match(text, /Enabled groups: 1/);
  assert.match(text, /Ads sent total: 1/);
});
