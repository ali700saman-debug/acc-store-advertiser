'use strict';

/**
 * Proves the upgrade is safe against a database that already exists in
 * production: nothing is dropped, nothing is recreated, and everything the
 * bot-only version stored keeps working.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { openDatabase, closeDatabase, integrityCheck, MIGRATIONS } = require('../database/db');
const { createQueries } = require('../database/queries');
const { createApp } = require('../index');
const { ensureDefaultCampaign } = require('../database/seed');
const {
  FakeBot, FakeMTProtoClient, makeTempDbPath, testConfig,
  privateMessage, groupMessage, callbackQuery, GROUP_ID,
} = require('./helpers');

/**
 * Builds a database at the PREVIOUS schema version (migration 001 only) and
 * fills it with the kind of data a live deployment would hold.
 */
function buildLegacyDatabase(dbPath) {
  const db = new Database(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));");
  MIGRATIONS[0].up(db);
  db.prepare('INSERT INTO migrations (id) VALUES (?)').run(MIGRATIONS[0].id);

  const q = createQueries(db);
  const campaign = q.createCampaign({
    name: 'ACC STORE Main Ad',
    text: '🛍 <b>ACC STORE</b>\nLegacy advertisement text',
    button_text: '🛒 Open ACC STORE',
    button_url: 'https://t.me/LegacyStoreBot',
    media_type: 'photo',
    media_file_id: 'LEGACY_PHOTO_FILE_ID',
  });
  const second = q.createCampaign({ name: 'Second Campaign', text: 'Another ad' });

  q.registerGroup({ chat_id: -1001111111111, title: 'Legacy Group One', type: 'supergroup' });
  q.registerGroup({ chat_id: -1002222222222, title: 'Legacy Group Two', type: 'supergroup' });
  q.updateGroup(-1001111111111, { interval_minutes: 720, campaign_id: campaign.id, next_send_at: '2026-10-01T09:00:00.000Z' });
  q.updateGroup(-1002222222222, { enabled: 0, rotation_enabled: 1 });
  q.setGroupCampaigns(-1002222222222, [campaign.id, second.id]);

  q.setSetting('default_interval_minutes', '420');
  q.setSetting('timezone', 'Asia/Baghdad');
  q.setSetting('default_campaign_id', campaign.id);
  q.setSetting('quiet_enabled', '1');
  q.setSetting('quiet_start', '23:00');
  q.setSetting('quiet_end', '07:00');

  for (let i = 0; i < 5; i += 1) {
    const claim = q.claimDelivery({ key: `legacy-${i}`, campaignId: campaign.id, chatId: -1001111111111 });
    q.markDeliverySent(claim.delivery.id, 500 + i);
  }
  const failed = q.claimDelivery({ key: 'legacy-failed', campaignId: campaign.id, chatId: -1002222222222 });
  q.markDeliveryFailed(failed.delivery.id, { code: 'NO_PERMISSION', message: 'no rights' });
  q.recordAudit(111111, 'group.register', '-1001111111111', 'Legacy Group One');

  const snapshot = {
    campaignId: campaign.id,
    secondId: second.id,
    campaigns: q.listCampaigns().length,
    groups: q.countGroups(),
    sentTotal: q.deliveryStats({}).sentTotal,
    failedTotal: q.deliveryStats({}).failedTotal,
    audit: q.listAudit(10).length,
    rotation: q.getGroupCampaignIds(-1002222222222),
  };
  db.close();
  return snapshot;
}

test('15. existing campaigns, groups, settings and history survive the migration', (t) => {
  const dbPath = makeTempDbPath('legacy');
  t.after(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));
  const before = buildLegacyDatabase(dbPath);

  const upgraded = openDatabase({ dbPath });
  t.after(() => closeDatabase(upgraded.db));
  const q = createQueries(upgraded.db);

  // Only the new migration ran, and the file was reused.
  assert.equal(upgraded.existed, true);
  assert.deepEqual(upgraded.appliedMigrations, ['002_mtproto_user_sender', '003_permission_block']);
  assert.equal(integrityCheck(upgraded.db).ok, true);

  // Campaigns intact, including media file_id and button.
  assert.equal(q.listCampaigns().length, before.campaigns);
  const campaign = q.getCampaign(before.campaignId);
  assert.equal(campaign.name, 'ACC STORE Main Ad');
  assert.match(campaign.text, /Legacy advertisement text/);
  assert.equal(campaign.media_file_id, 'LEGACY_PHOTO_FILE_ID');
  assert.equal(campaign.button_url, 'https://t.me/LegacyStoreBot');
  assert.equal(campaign.media_local_path, null, 'new column defaults to null');

  // Groups intact, with their schedules and per-group settings.
  assert.equal(q.countGroups(), before.groups);
  const one = q.getGroup(-1001111111111);
  assert.equal(one.title, 'Legacy Group One');
  assert.equal(one.interval_minutes, 720);
  assert.equal(one.campaign_id, before.campaignId);
  assert.equal(one.next_send_at, '2026-10-01T09:00:00.000Z');
  assert.equal(q.getGroup(-1002222222222).enabled, 0);
  assert.deepEqual(q.getGroupCampaignIds(-1002222222222), before.rotation);

  // Every legacy group keeps delivering via the bot until changed.
  assert.equal(one.sender_kind, 'bot');
  assert.equal(q.countGroupsBySender('bot'), 2);
  assert.equal(q.countGroupsBySender('user'), 0);

  // Settings and history intact.
  assert.equal(q.getSetting('default_interval_minutes'), '420');
  assert.equal(q.getSetting('quiet_start'), '23:00');
  assert.equal(String(q.getSetting('default_campaign_id')), String(before.campaignId));
  assert.equal(q.deliveryStats({}).sentTotal, before.sentTotal);
  assert.equal(q.deliveryStats({}).failedTotal, before.failedTotal);
  assert.equal(q.listAudit(10).length, before.audit);
});

test('15b. migrating twice is a no-op', (t) => {
  const dbPath = makeTempDbPath('legacy-twice');
  t.after(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));
  buildLegacyDatabase(dbPath);

  const first = openDatabase({ dbPath });
  assert.deepEqual(first.appliedMigrations, ['002_mtproto_user_sender', '003_permission_block']);
  closeDatabase(first.db);

  const second = openDatabase({ dbPath });
  t.after(() => closeDatabase(second.db));
  assert.deepEqual(second.appliedMigrations, [], 'nothing re-ran');
  assert.equal(integrityCheck(second.db).ok, true);
  assert.equal(createQueries(second.db).countGroups(), 2);
});

test('16 & 17. the existing admin controls and statistics still work after upgrade', async (t) => {
  const dbPath = makeTempDbPath('legacy-panel');
  t.after(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));
  buildLegacyDatabase(dbPath);

  const dbInfo = openDatabase({ dbPath });
  t.after(() => closeDatabase(dbInfo.db));
  const config = testConfig();
  const bot = new FakeBot();
  const mt = new FakeMTProtoClient();
  const ctx = createApp({ bot, config, dbInfo, createClient: () => mt });
  ctx.botInfo = { id: 777, username: 'AD_SENDER_9_bot' };
  const q = ctx.q;

  // Dashboard still renders.
  await bot.feedMessage(privateMessage('/start'));
  assert.match(bot.lastMessage().text, /ACC STORE Advertiser/);
  assert.match(bot.lastMessage().text, /Groups: 2/);

  // Group enable/disable still works.
  await bot.feedCallback(callbackQuery('g:tog:-1002222222222'));
  assert.equal(q.getGroup(-1002222222222).enabled, 1);

  // Interval change still works.
  await bot.feedCallback(callbackQuery('g:si:-1001111111111:1440'));
  assert.equal(q.getGroup(-1001111111111).interval_minutes, 1440);

  // Statistics still report the legacy history.
  await bot.feedCallback(callbackQuery('st:home'));
  const stats = bot.edits[bot.edits.length - 1].text;
  assert.match(stats, /Registered groups: 2/);
  assert.match(stats, /Ads sent total: 5/);
  assert.match(stats, /Failed deliveries \(total\): 1/);

  // Pause/resume still works.
  await bot.feedCallback(callbackQuery('s:pause'));
  assert.equal(q.isPaused(), true);
  await bot.feedCallback(callbackQuery('s:pause'));
  assert.equal(q.isPaused(), false);

  // The legacy /register_group path still registers a bot-delivered group.
  await bot.feedMessage(groupMessage('/register_group'));
  assert.ok(q.getGroup(GROUP_ID));
  assert.equal(q.getGroup(GROUP_ID).sender_kind, 'bot');
});

test('16b. a legacy bot group still delivers via the bot after upgrade', async (t) => {
  const dbPath = makeTempDbPath('legacy-send');
  t.after(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));
  const before = buildLegacyDatabase(dbPath);

  const dbInfo = openDatabase({ dbPath });
  t.after(() => closeDatabase(dbInfo.db));
  const bot = new FakeBot();
  const mt = new FakeMTProtoClient();
  const ctx = createApp({ bot, config: testConfig(), dbInfo, createClient: () => mt });

  const group = ctx.q.getGroup(-1001111111111);
  const campaign = ctx.q.getCampaign(before.campaignId);
  const result = await ctx.broadcaster.deliver({ group, campaign, trigger: 'manual' });

  assert.equal(result.status, 'sent');
  assert.equal(result.senderKind, 'bot');
  assert.equal(bot.sent.length, 1, 'the bot delivered it');
  assert.equal(mt.sent.length, 0, 'the user account was not involved');
  // The bot keeps its real inline button and its file_id media.
  assert.equal(bot.sent[0].method, 'sendPhoto');
  assert.equal(bot.sent[0].fileId, 'LEGACY_PHOTO_FILE_ID');
  assert.equal(bot.sent[0].options.reply_markup.inline_keyboard[0][0].url, 'https://t.me/LegacyStoreBot');
});

test('15d. legacy bot-uploaded media is cached locally so the user account can post it', async (t) => {
  const dbPath = makeTempDbPath('legacy-media');
  t.after(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));
  const before = buildLegacyDatabase(dbPath);

  const dbInfo = openDatabase({ dbPath });
  t.after(() => closeDatabase(dbInfo.db));
  const bot = new FakeBot();
  const mt = new FakeMTProtoClient();
  const config = testConfig({ USER_SEND_DELAY_MS: '1', MEDIA_DIR: path.join(path.dirname(dbPath), 'media') });
  const ctx = createApp({ bot, config, dbInfo, createClient: () => mt });
  await ctx.userSender.connect();

  ctx.q.registerUserGroup({ chat_id: -1004444444444, title: 'Imported', type: 'supergroup', peer_type: 'channel', access_hash: '5544332211' });
  const campaign = ctx.q.getCampaign(before.campaignId);
  assert.equal(campaign.media_file_id, 'LEGACY_PHOTO_FILE_ID');
  assert.equal(campaign.media_local_path, null, 'not cached yet');

  const result = await ctx.broadcaster.deliver({ group: ctx.q.getGroup(-1004444444444), campaign, trigger: 'manual' });

  assert.equal(result.status, 'sent');
  // The file_id was downloaded once and the local copy recorded for reuse.
  assert.equal(bot.downloads.length, 1, 'downloaded exactly once');
  const cached = ctx.q.getCampaign(before.campaignId).media_local_path;
  assert.ok(cached && fs.existsSync(cached), 'local copy exists on the volume');
  assert.equal(mt.sent[0].method, 'sendFile', 'the user account sent it as a file');

  // A second send reuses the cached file rather than downloading again.
  await ctx.broadcaster.deliver({ group: ctx.q.getGroup(-1004444444444), campaign, trigger: 'manual' });
  assert.equal(bot.downloads.length, 1, 'no second download');
  assert.equal(mt.sent.length, 2);
});

test('15e. when media cannot be cached the send fails loudly instead of silently dropping it', async (t) => {
  const dbPath = makeTempDbPath('legacy-media-fail');
  t.after(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));
  const before = buildLegacyDatabase(dbPath);

  const dbInfo = openDatabase({ dbPath });
  t.after(() => closeDatabase(dbInfo.db));
  const bot = new FakeBot();
  const mt = new FakeMTProtoClient();
  const config = testConfig({ USER_SEND_DELAY_MS: '1', MEDIA_DIR: path.join(path.dirname(dbPath), 'media') });
  const ctx = createApp({ bot, config, dbInfo, createClient: () => mt });
  await ctx.userSender.connect();
  ctx.q.registerUserGroup({ chat_id: -1005555555555, title: 'Imported', type: 'supergroup', peer_type: 'channel', access_hash: '1' });

  bot.failNext(new Error('file is too big'), { times: 3 });
  const result = await ctx.broadcaster.deliver({
    group: ctx.q.getGroup(-1005555555555),
    campaign: ctx.q.getCampaign(before.campaignId),
    trigger: 'manual',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'MEDIA_UNAVAILABLE');
  assert.equal(mt.sent.length, 0, 'nothing was sent without its media');
  assert.equal(ctx.q.getGroup(-1005555555555).delivery_problem, 1, 'surfaced in the admin panel');
});

test('15c. a mixed deployment routes each group to its own sender', async (t) => {
  const dbPath = makeTempDbPath('mixed');
  t.after(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));
  buildLegacyDatabase(dbPath);

  const dbInfo = openDatabase({ dbPath });
  t.after(() => closeDatabase(dbInfo.db));
  const bot = new FakeBot();
  const mt = new FakeMTProtoClient();
  const config = testConfig({ USER_SEND_DELAY_MS: '1' });
  const ctx = createApp({ bot, config, dbInfo, createClient: () => mt });
  await ctx.userSender.connect();

  ctx.q.registerUserGroup({ chat_id: -1003333333333, title: 'Imported Group', type: 'supergroup', peer_type: 'channel', access_hash: '99887766554433221' });
  // Imports start disabled by design; this test is about routing, so enable it.
  ctx.q.updateGroup(-1003333333333, { enabled: 1 });
  ctx.q.updateGroup(-1002222222222, { enabled: 1 });
  ensureDefaultCampaign(ctx.q, config);

  const campaign = ctx.q.getCampaign(Number(ctx.q.getSetting('default_campaign_id')));
  const results = await ctx.broadcaster.broadcast({ groups: ctx.q.listEnabledGroups(), campaignFor: campaign, trigger: 'manual' });
  const failures = results.filter((r) => r.status !== 'sent');
  assert.deepEqual(failures, [], `all sends succeeded (${JSON.stringify(failures)})`);

  const byKind = results.reduce((acc, r) => { acc[r.senderKind] = (acc[r.senderKind] || 0) + 1; return acc; }, {});
  assert.equal(byKind.bot, 2, 'both legacy groups went via the bot');
  assert.equal(byKind.user, 1, 'the imported group went via the user account');
  assert.equal(mt.sent.length, 1);
  assert.equal(bot.sent.length, 2);
  assert.ok(results.every((r) => r.status === 'sent'));
});
