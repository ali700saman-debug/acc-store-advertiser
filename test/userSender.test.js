'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { createApp } = require('../index');
const { ensureDefaultCampaign } = require('../database/seed');
const { createUserSender, classifyUserError, markedChatId, withDeadline, REASONS, STATUS } = require('../services/userSender');
const { renderCampaign } = require('../services/render');
const logger = require('../utils/logger');
const configModule = require('../config');
const {
  FakeBot, FakeMTProtoClient, fakeDialog, makeTempDbPath, testConfig, openTestDb,
  privateMessage, callbackQuery, ADMIN_ID, STRANGER_ID,
} = require('./helpers');

/** Boots the real app graph with a fake bot AND a fake MTProto client. */
function boot({ overrides = {}, clientOptions = {}, client = null, connect = true } = {}) {
  const dbPath = makeTempDbPath('sender');
  const { dbInfo, q, close } = openTestDb(dbPath);
  const config = testConfig(overrides);
  const bot = new FakeBot();
  const mt = client || new FakeMTProtoClient(clientOptions);

  const ctx = createApp({ bot, config, dbInfo, createClient: () => mt });
  ctx.botInfo = { id: 777, username: 'AD_SENDER_9_bot' };
  ensureDefaultCampaign(q, config);

  return {
    bot, mt, ctx, q, config,
    connect: () => ctx.userSender.connect(),
    cleanup: () => { close(); fs.rmSync(dbPath, { force: true }); },
    ready: connect ? ctx.userSender.connect() : Promise.resolve(null),
  };
}

test('2. a valid user session connects and reports the account safely', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  const status = await h.ready;

  assert.equal(status.connected, true);
  assert.equal(status.status, STATUS.CONNECTED);
  assert.equal(status.account.username, 'ad_sender');
  // No credential may ever appear in the status object.
  const serialised = JSON.stringify(status);
  assert.equal(serialised.includes(h.config.userSession), false);
  assert.equal(serialised.includes(h.config.userApiHash), false);
  assert.equal(/phone/i.test(serialised), false);
});

test('18 & 1. an invalid session leaves the admin bot fully working', async (t) => {
  const h = boot({ clientOptions: { authorized: false }, connect: false });
  t.after(h.cleanup);

  const status = await h.ctx.userSender.connect();
  assert.equal(status.connected, false);
  assert.equal(status.status, STATUS.UNAVAILABLE);

  // The admin panel must still respond normally.
  await h.bot.feedMessage(privateMessage('/start'));
  const panel = h.bot.lastMessage();
  assert.match(panel.text, /ACC STORE Advertiser/);
  assert.match(panel.text, /User sender: 🔴 Unavailable/);
  assert.ok(panel.options.reply_markup, 'admin keyboard still present');

  await h.bot.feedMessage(privateMessage('/status'));
  assert.match(h.bot.lastMessage().text, /Advertiser Status/);
});

test('18b. a client that throws on connect does not crash the app', async (t) => {
  const client = new FakeMTProtoClient();
  client.failNext(new Error('ECONNRESET: could not reach Telegram'), { times: 5 });
  const h = boot({ client, connect: false });
  t.after(h.cleanup);

  const status = await h.ctx.userSender.connect();
  assert.equal(status.connected, false);
  assert.equal(status.status, STATUS.UNAVAILABLE);

  await h.bot.feedMessage(privateMessage('/start'));
  assert.match(h.bot.lastMessage().text, /ACC STORE Advertiser/);
});

test('18c. a missing session is reported as not configured, not as a crash', async (t) => {
  const h = boot({ overrides: { TELEGRAM_USER_SESSION: '' }, connect: false });
  t.after(h.cleanup);

  const status = await h.ctx.userSender.connect();
  assert.equal(status.status, STATUS.NOT_CONFIGURED);
  assert.match(status.reason, /TELEGRAM_USER_SESSION is missing/);
});

test('18d. a hanging MTProto connect cannot stall startup', async (t) => {
  const dbPath = makeTempDbPath('hang');
  const { dbInfo, close } = openTestDb(dbPath);
  t.after(() => { close(); fs.rmSync(dbPath, { force: true }); });
  const config = testConfig({ USER_CONNECT_TIMEOUT_MS: '150' });
  const bot = new FakeBot();

  // A client whose connect never settles — a firewalled MTProto port.
  let disconnected = false;
  const hangingClient = {
    connect: () => new Promise(() => {}),
    isUserAuthorized: () => new Promise(() => {}),
    getMe: () => new Promise(() => {}),
    disconnect: async () => { disconnected = true; },
  };

  const ctx = createApp({ bot, config, dbInfo, createClient: () => hangingClient });
  const startedAt = Date.now();
  const status = await ctx.userSender.connect();
  const elapsed = Date.now() - startedAt;

  assert.equal(status.connected, false);
  assert.equal(status.status, STATUS.UNAVAILABLE);
  assert.match(status.reason, /Could not reach Telegram in time/);
  assert.ok(elapsed < 3000, `gave up promptly (${elapsed}ms)`);
  assert.equal(disconnected, true, 'the half-open client was dropped');

  // And the admin panel is fully usable.
  await bot.feedMessage(privateMessage('/start'));
  assert.match(bot.lastMessage().text, /ACC STORE Advertiser/);
});

test('18e. withDeadline rejects with a TIMEOUT marker', async () => {
  await assert.rejects(
    () => withDeadline(new Promise(() => {}), 50, 'test op'),
    (error) => {
      assert.equal(error.errorMessage, 'TIMEOUT');
      assert.match(error.message, /test op timed out/);
      return true;
    }
  );
  assert.equal(await withDeadline(Promise.resolve('fine'), 1000), 'fine');
});

test('3. secrets never appear in logs', async (t) => {
  const h = boot({ connect: false });
  t.after(() => { h.cleanup(); logger.clearSecrets(); });
  logger.registerSecrets(configModule.secretValues(h.config));

  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    h.mt.failNext(new Error(`auth failed with session ${h.config.userSession} and hash ${h.config.userApiHash}`), { times: 3 });
    await h.ctx.userSender.connect();
    // Force the secrets through the logger the way a leak would.
    h.ctx.logger.info(`session=${h.config.userSession}`);
    h.ctx.logger.error(`hash=${h.config.userApiHash}`);
  } finally {
    Object.assign(console, original);
  }

  const output = lines.join('\n');
  assert.ok(output.length > 0, 'something was logged');
  assert.equal(output.includes(h.config.userSession), false, 'session not logged');
  assert.equal(output.includes(h.config.userApiHash), false, 'api hash not logged');
  assert.ok(output.includes('[REDACTED]'), 'secrets were redacted');
});

test('3b. the session is never written to SQLite', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  await h.ready;
  h.q.registerUserGroup({ chat_id: -1001234567890, title: 'G', peer_type: 'channel', access_hash: '123' });
  h.q.recordAudit(ADMIN_ID, 'sender.reconnect', null, 'connected');

  const tables = h.ctx.dbInfo.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  let dump = '';
  for (const table of tables) {
    dump += JSON.stringify(h.ctx.dbInfo.db.prepare(`SELECT * FROM ${table.name}`).all());
  }

  assert.equal(dump.includes(h.config.userSession), false, 'no session in any table');
  assert.equal(dump.includes(h.config.userApiHash), false, 'no api hash in any table');
  assert.equal(dump.includes(h.config.botToken), false, 'no bot token in any table');
});

test('3c. /status never leaks a credential', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  await h.ready;

  await h.bot.feedMessage(privateMessage('/status'));
  const text = h.bot.lastMessage().text;

  assert.match(text, /User sender: 🟢 Connected/);
  assert.equal(text.includes(h.config.userSession), false);
  assert.equal(text.includes(h.config.userApiHash), false);
  assert.equal(String(h.config.userApiId) === '' ? false : text.includes(String(h.config.userApiId)), false);
});

test('4. Import My Groups lists only the account\'s own existing dialogs', async (t) => {
  const h = boot({
    clientOptions: {
      dialogs: [
        fakeDialog({ id: 1000000001, title: 'Digital Market Iraq' }),
        fakeDialog({ id: 1000000002, title: 'Software Marketplace' }),
        fakeDialog({ id: 900000003, title: 'Old Basic Group', basicGroup: true }),
      ],
    },
  });
  t.after(h.cleanup);
  await h.ready;

  const result = await h.ctx.userSender.listGroups();

  assert.equal(result.ok, true);
  assert.deepEqual(result.groups.map((g) => g.title), ['Digital Market Iraq', 'Software Marketplace', 'Old Basic Group']);
  assert.deepEqual(result.groups.map((g) => g.chatId), [-1001000000001, -1001000000002, -900000003]);
  assert.equal(result.groups[0].peerType, 'channel');
  assert.equal(result.groups[2].peerType, 'chat');
  // 64-bit access hash preserved as a string.
  assert.equal(result.groups[0].accessHash, '7418529637418529637');
});

test('4b. ineligible chats are excluded from the import list', async (t) => {
  const h = boot({
    clientOptions: {
      dialogs: [
        fakeDialog({ id: 1000000001, title: 'Eligible Group' }),
        fakeDialog({ id: 1000000002, title: 'Left Group', left: true }),
        fakeDialog({ id: 1000000003, title: 'Read Only', defaultBannedRights: { sendMessages: true } }),
        fakeDialog({ id: 1000000004, title: 'I Am Muted', bannedRights: { sendMessages: true } }),
        fakeDialog({ id: 1000000005, title: 'Broadcast Channel', megagroup: false, broadcast: true }),
        fakeDialog({ id: 900000006, title: 'Migrated', basicGroup: true, migratedTo: { channelId: 1 } }),
      ],
    },
  });
  t.after(h.cleanup);
  await h.ready;

  const result = await h.ctx.userSender.listGroups();

  assert.deepEqual(result.groups.map((g) => g.title), ['Eligible Group']);
  assert.ok(result.hidden >= 3, `hidden chats reported (${result.hidden})`);
});

test('4c. a read-only group is still offered when the account is an admin there', async (t) => {
  const h = boot({
    clientOptions: {
      dialogs: [fakeDialog({ id: 1000000007, title: 'Announcements', defaultBannedRights: { sendMessages: true }, adminRights: { postMessages: true } })],
    },
  });
  t.after(h.cleanup);
  await h.ready;

  const result = await h.ctx.userSender.listGroups();
  assert.deepEqual(result.groups.map((g) => g.title), ['Announcements']);
});

test('4d. broadcast channels appear only when ALLOW_CHANNELS is enabled', async (t) => {
  const h = boot({
    overrides: { ALLOW_CHANNELS: 'true' },
    clientOptions: { dialogs: [fakeDialog({ id: 1000000008, title: 'My Channel', megagroup: false, broadcast: true })] },
  });
  t.after(h.cleanup);
  await h.ready;

  const result = await h.ctx.userSender.listGroups();
  assert.deepEqual(result.groups.map((g) => g.type), ['channel']);
});

test('5. nothing is ever auto-joined', async (t) => {
  const h = boot({
    clientOptions: { dialogs: [fakeDialog({ id: 1000000001, title: 'Group A' })] },
  });
  t.after(h.cleanup);
  await h.ready;

  // Exercise every discovery/import path there is.
  await h.ctx.userSender.listGroups();
  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:0'));
  await h.bot.feedCallback(callbackQuery('sndr:add'));

  assert.deepEqual(h.mt.joinCalls, [], 'no join-style request was ever issued');

  // And the capability is absent from the source, not merely unused.
  const source = ['services/userSender.js', 'handlers/sender.js', 'services/broadcaster.js', 'services/sendQueue.js']
    .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const forbidden of ['JoinChannel', 'ImportChatInvite', 'AddChatUser', 'CheckChatInvite', 'joinChat']) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not appear in the sending code`);
  }
});

test('6. selecting a group adds it to the allowlist with its peer data', async (t) => {
  const h = boot({
    clientOptions: {
      dialogs: [
        fakeDialog({ id: 1000000001, title: 'Digital Market Iraq', accessHash: '1111111111111111111' }),
        fakeDialog({ id: 1000000002, title: 'Software Marketplace' }),
      ],
    },
  });
  t.after(h.cleanup);
  await h.ready;

  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:0'));
  await h.bot.feedCallback(callbackQuery('sndr:add'));

  assert.equal(h.q.countGroups(), 1, 'only the ticked group was added');
  const group = h.q.getGroup(-1001000000001);
  assert.ok(group);
  assert.equal(group.title, 'Digital Market Iraq');
  assert.equal(group.sender_kind, 'user');
  assert.equal(group.peer_type, 'channel');
  assert.equal(group.access_hash, '1111111111111111111');
  // Safe default: an imported group is registered DISABLED so a bulk import
  // can never start advertising on its own.
  assert.equal(group.enabled, 0);
  assert.ok(group.next_send_at);
  assert.equal(h.q.getGroup(-1001000000002), null, 'the unticked group was NOT added');
});

test('7 & 14. unselected groups receive nothing, even though the account is in them', async (t) => {
  const h = boot({
    clientOptions: {
      dialogs: [
        fakeDialog({ id: 1000000001, title: 'Selected' }),
        fakeDialog({ id: 1000000002, title: 'Not Selected' }),
        fakeDialog({ id: 1000000003, title: 'Also Not Selected' }),
      ],
    },
  });
  t.after(h.cleanup);
  await h.ready;

  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:0'));
  await h.bot.feedCallback(callbackQuery('sndr:add'));

  // Enable only the imported group; the other two stay off the allowlist.
  h.q.updateGroup(-1001000000001, { enabled: 1 });

  const campaign = h.q.listCampaigns()[0];
  await h.bot.feedCallback(callbackQuery(`n:go:${campaign.id}:all`));

  const targets = h.mt.sent.map((m) => String(m.peer.channelId));
  assert.deepEqual(targets, ['1000000001'], 'only the allowlisted group was messaged');
  assert.equal(h.mt.sent.length, 1);
});

test('6b. a group already registered cannot be double-added', async (t) => {
  const h = boot({ clientOptions: { dialogs: [fakeDialog({ id: 1000000001, title: 'Group A' })] } });
  t.after(h.cleanup);
  await h.ready;

  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:0'));
  await h.bot.feedCallback(callbackQuery('sndr:add'));
  assert.equal(h.q.countGroups(), 1);

  // Tapping it again is refused, and the count stays at one.
  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:0'));
  await h.bot.feedCallback(callbackQuery('sndr:add'));
  assert.equal(h.q.countGroups(), 1);
});

test('8b. a group whose peer cannot be verified is skipped, not registered', async (t) => {
  const h = boot({ clientOptions: { dialogs: [fakeDialog({ id: 1000000001, title: 'Unreachable' })] } });
  t.after(h.cleanup);
  await h.ready;

  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:0'));
  // getEntity fails during verification.
  h.mt.failNext(Object.assign(new Error('CHANNEL_PRIVATE'), { errorMessage: 'CHANNEL_PRIVATE' }), { times: 3 });
  await h.bot.feedCallback(callbackQuery('sndr:add'));

  assert.equal(h.q.countGroups(), 0, 'unverifiable group not added to the allowlist');
  assert.match(h.bot.edits[h.bot.edits.length - 1].text, /Skipped/);
});

test('15. the Sender Account panel shows only safe information', async (t) => {
  const h = boot({ clientOptions: { dialogs: [fakeDialog({ id: 1000000001, title: 'G' })] } });
  t.after(h.cleanup);
  await h.ready;

  await h.bot.feedCallback(callbackQuery('sndr:cs'));
  await h.bot.feedCallback(callbackQuery('sndr:home'));
  const text = h.bot.edits[h.bot.edits.length - 1].text;

  assert.match(text, /Sender Account/);
  assert.match(text, /User sender: 🟢 Connected/);
  assert.match(text, /@ad_sender/);
  assert.match(text, /Joined groups: 1/);
  assert.match(text, /Registered advertising groups: 0/);
  assert.equal(text.includes(h.config.userSession), false);
  assert.equal(text.includes(h.config.userApiHash), false);
});

test('15b. Reconnect and Check Session are admin-only', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  await h.ready;

  await h.bot.feedCallback(callbackQuery('sndr:rc', { from: STRANGER_ID }));
  await h.bot.feedCallback(callbackQuery('sndr:imp:0', { from: STRANGER_ID }));

  assert.match(h.bot.answers[0].text, /ACC STORE administration/);
  assert.equal(h.bot.edits.length, 0, 'no panel was rendered for a stranger');
});

test('11b. classifyUserError separates account-wide from chat-level waits', () => {
  const { FloodWaitError, SlowModeWaitError, PeerFloodError } = require('teleproto/errors');

  const flood = classifyUserError(new FloodWaitError({ request: {}, capture: 300 }));
  assert.equal(flood.reason, REASONS.FLOOD_WAIT);
  assert.equal(flood.scope, 'account');
  assert.equal(flood.waitSeconds, 300);

  const slow = classifyUserError(new SlowModeWaitError({ request: {}, capture: 45 }));
  assert.equal(slow.reason, REASONS.SLOWMODE_WAIT);
  assert.equal(slow.scope, 'chat');
  assert.equal(slow.waitSeconds, 45);

  const peer = classifyUserError(new PeerFloodError({ request: {} }));
  assert.equal(peer.reason, REASONS.PEER_FLOOD);
  assert.equal(peer.scope, 'account');
});

test('markedChatId matches the Bot API id space used by bot-registered groups', () => {
  assert.equal(markedChatId(fakeDialog({ id: 1234567890 }).entity), -1001234567890);
  assert.equal(markedChatId(fakeDialog({ id: 987654321, basicGroup: true }).entity), -987654321);
  assert.equal(markedChatId(null), null);
});

test('11. a user account cannot send inline buttons, so the link is appended', () => {
  const campaign = {
    text: '🛍 <b>ACC STORE</b>\nPremium subscriptions',
    button_text: '🛒 Open ACC STORE',
    button_url: 'https://t.me/MyMainStoreBot',
    parse_mode: 'HTML',
  };

  const asBot = renderCampaign(campaign, { senderKind: 'bot' });
  assert.deepEqual(asBot.buttons, [[{ text: '🛒 Open ACC STORE', url: 'https://t.me/MyMainStoreBot' }]]);
  assert.equal(asBot.linkAppended, false);
  assert.equal(asBot.text.includes('https://t.me/MyMainStoreBot'), false, 'bot keeps the URL in the button only');

  const asUser = renderCampaign(campaign, { senderKind: 'user' });
  assert.equal(asUser.buttons, null, 'no fake inline keyboard for a user account');
  assert.equal(asUser.linkAppended, true);
  assert.match(asUser.text, /🛒 Open ACC STORE:\nhttps:\/\/t\.me\/MyMainStoreBot$/);
  assert.match(asUser.text, /^🛍 <b>ACC STORE<\/b>/, 'original text preserved');
});

test('11c. the preview shows the user-account version, button-free', async (t) => {
  const h = boot({ clientOptions: { dialogs: [fakeDialog({ id: 1000000001, title: 'G' })] } });
  t.after(h.cleanup);
  await h.ready;
  h.q.registerUserGroup({ chat_id: -1001000000001, title: 'G', peer_type: 'channel', access_hash: '1' });
  const campaign = h.q.listCampaigns()[0];

  h.bot.reset();
  await h.bot.feedCallback(callbackQuery(`c:prev:${campaign.id}`));

  const header = h.bot.sent.find((m) => /Preview/.test(m.text || ''));
  assert.match(header.text, /as the USER ACCOUNT/);
  const preview = h.bot.sent.find((m) => (m.text || '').includes('https://t.me/ExampleStoreBot'));
  assert.ok(preview, 'the store link is visible in the message body');
  assert.equal(preview.options.reply_markup, undefined, 'no inline button in the user-account preview');
});

test('11d. the bot-account preview keeps the real inline button', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  await h.ready;
  const campaign = h.q.listCampaigns()[0];

  h.bot.reset();
  await h.bot.feedCallback(callbackQuery(`c:prev:${campaign.id}:bot`));

  const preview = h.bot.sent.find((m) => m.options?.reply_markup?.inline_keyboard?.[0]?.[0]?.url);
  assert.ok(preview, 'bot preview renders a tappable button');
  assert.equal(preview.options.reply_markup.inline_keyboard[0][0].url, 'https://t.me/ExampleStoreBot');
});
