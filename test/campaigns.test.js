'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { createApp } = require('../index');
const { ensureDefaultCampaign, DEFAULT_CAMPAIGN_NAME } = require('../database/seed');
const campaignsHandler = require('../handlers/campaigns');
const { buildCampaignMessage } = require('../services/telegram');
const {
  FakeBot, makeTempDbPath, testConfig, openTestDb,
  privateMessage, callbackQuery, ADMIN_ID, GROUP_ID,
} = require('./helpers');

function boot(overrides = {}) {
  const dbPath = makeTempDbPath('campaign');
  const { dbInfo, q, close } = openTestDb(dbPath);
  const config = testConfig(overrides);
  const bot = new FakeBot();
  const ctx = createApp({ bot, config, dbInfo });
  ctx.botInfo = { id: 777, username: 'AdvertiserBot' };
  ensureDefaultCampaign(q, config);
  return { bot, ctx, q, config, cleanup: () => { close(); fs.rmSync(dbPath, { force: true }); } };
}

test('11a. the default ACC STORE campaign is seeded with the env store URL', (t) => {
  const { q, cleanup } = boot();
  t.after(cleanup);

  const campaign = q.findCampaignByName(DEFAULT_CAMPAIGN_NAME);
  assert.ok(campaign);
  assert.match(campaign.text, /ACC STORE/);
  assert.equal(campaign.button_url, 'https://t.me/ExampleStoreBot', 'URL comes from MAIN_STORE_BOT_URL, never hardcoded');
  assert.equal(String(q.getSetting('default_campaign_id')), String(campaign.id));
});

test('11b. seeding again never duplicates or overwrites admin edits', (t) => {
  const { q, config, cleanup } = boot();
  t.after(cleanup);
  const campaign = q.findCampaignByName(DEFAULT_CAMPAIGN_NAME);
  q.updateCampaign(campaign.id, { text: 'My own edited advertisement' });

  ensureDefaultCampaign(q, config);

  assert.equal(q.countCampaigns(), 1);
  assert.equal(q.getCampaign(campaign.id).text, 'My own edited advertisement');
});

test('8. admin can create a campaign from the panel', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);

  await bot.feedCallback(callbackQuery('c:new'));
  await bot.feedMessage(privateMessage('Ramadan Promo'));

  const created = q.findCampaignByName('Ramadan Promo');
  assert.ok(created);
  assert.equal(created.enabled, 0, 'new campaigns start disabled until content is added');
  assert.equal(q.countCampaigns(), 2);
});

test('9. admin can edit campaign text, with preview and explicit save', async (t) => {
  const { bot, ctx, q, cleanup } = boot();
  t.after(cleanup);
  const campaign = q.listCampaigns()[0];

  await bot.feedCallback(callbackQuery(`c:edit:${campaign.id}:text`));
  assert.match(bot.lastMessage().text, /Send me the new advertisement text/);

  bot.reset();
  await bot.feedMessage(privateMessage('<b>New offer</b> today only'));

  // Nothing is written until Save is pressed.
  assert.equal(q.getCampaign(campaign.id).text, campaign.text, 'not saved before confirmation');
  assert.ok(bot.sent.some((m) => m.text === '<b>New offer</b> today only'), 'preview rendered the real message');
  const saveRow = bot.lastMessage().options.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.deepEqual(saveRow, ['✅ Save', '❌ Cancel']);

  await bot.feedCallback(callbackQuery('c:save'));
  assert.equal(q.getCampaign(campaign.id).text, '<b>New offer</b> today only');
  assert.equal(ctx.sessions.get(ADMIN_ID), null, 'edit session is cleared');
});

test('9b. cancelling an edit discards the pending value', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  const campaign = q.listCampaigns()[0];
  const original = campaign.text;

  await bot.feedCallback(callbackQuery(`c:edit:${campaign.id}:text`));
  await bot.feedMessage(privateMessage('Throwaway text'));
  await bot.feedCallback(callbackQuery('c:cancel'));

  assert.equal(q.getCampaign(campaign.id).text, original);
});

test('9c. invalid HTML is rejected before it can break every send', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  const campaign = q.listCampaigns()[0];
  const original = campaign.text;

  await bot.feedCallback(callbackQuery(`c:edit:${campaign.id}:text`));
  bot.reset();
  await bot.feedMessage(privateMessage('<b>broken'));

  assert.equal(q.getCampaign(campaign.id).text, original);
  assert.match(bot.allText(), /Unclosed HTML tag/);
});

test('10. media is stored as a Telegram file_id and reused, never re-uploaded', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  const campaign = q.listCampaigns()[0];

  await bot.feedCallback(callbackQuery(`c:setmedia:${campaign.id}`));
  await bot.feedMessage({
    message_id: 9,
    chat: { id: ADMIN_ID, type: 'private' },
    from: { id: ADMIN_ID },
    photo: [{ file_id: 'SMALL_ID' }, { file_id: 'AgACAgQAAxkBAAI-BEST_QUALITY' }],
  });
  await bot.feedCallback(callbackQuery('c:save'));

  const saved = q.getCampaign(campaign.id);
  assert.equal(saved.media_type, 'photo');
  assert.equal(saved.media_file_id, 'AgACAgQAAxkBAAI-BEST_QUALITY', 'highest-resolution file_id kept');

  // The stored id is handed straight back to Telegram on send.
  const plan = buildCampaignMessage(saved);
  assert.equal(plan.method, 'sendPhoto');
  assert.equal(plan.fileId, 'AgACAgQAAxkBAAI-BEST_QUALITY');
});

test('10b. GIF and video media are supported', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  const campaign = q.listCampaigns()[0];

  await bot.feedCallback(callbackQuery(`c:setmedia:${campaign.id}`));
  await bot.feedMessage({ message_id: 9, chat: { id: ADMIN_ID, type: 'private' }, from: { id: ADMIN_ID }, animation: { file_id: 'GIF_ID' } });
  await bot.feedCallback(callbackQuery('c:save'));
  assert.equal(q.getCampaign(campaign.id).media_type, 'animation');

  await bot.feedCallback(callbackQuery(`c:setmedia:${campaign.id}`));
  await bot.feedMessage({ message_id: 10, chat: { id: ADMIN_ID, type: 'private' }, from: { id: ADMIN_ID }, video: { file_id: 'VID_ID' } });
  await bot.feedCallback(callbackQuery('c:save'));
  assert.equal(q.getCampaign(campaign.id).media_type, 'video');
  assert.equal(q.getCampaign(campaign.id).media_file_id, 'VID_ID');
});

test('11. preview renders media, caption and inline button exactly as sent', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  const campaign = q.listCampaigns()[0];
  q.updateCampaign(campaign.id, { media_type: 'photo', media_file_id: 'PHOTO_ID' });

  bot.reset();
  await bot.feedCallback(callbackQuery(`c:prev:${campaign.id}`));

  const preview = bot.sent.find((m) => m.method === 'sendPhoto');
  assert.ok(preview, 'preview is sent as a real photo message');
  assert.equal(preview.fileId, 'PHOTO_ID');
  assert.match(preview.options.caption, /ACC STORE/);
  assert.equal(preview.options.reply_markup.inline_keyboard[0][0].url, 'https://t.me/ExampleStoreBot');
  assert.equal(preview.options.parse_mode, 'HTML');
});

test('8b. button text and URL are editable, and bad URLs are refused', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  const campaign = q.listCampaigns()[0];

  await bot.feedCallback(callbackQuery(`c:edit:${campaign.id}:burl`));
  bot.reset();
  await bot.feedMessage(privateMessage('javascript:alert(1)'));
  assert.match(bot.allText(), /must start with https/i);
  assert.equal(q.getCampaign(campaign.id).button_url, 'https://t.me/ExampleStoreBot');

  await bot.feedMessage(privateMessage('https://t.me/NewStoreBot'));
  await bot.feedCallback(callbackQuery('c:save'));
  assert.equal(q.getCampaign(campaign.id).button_url, 'https://t.me/NewStoreBot');
});

test('8c. campaigns can be enabled, disabled and deleted', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  const campaign = q.listCampaigns()[0];

  await bot.feedCallback(callbackQuery(`c:tog:${campaign.id}`));
  assert.equal(q.getCampaign(campaign.id).enabled, 0);

  await bot.feedCallback(callbackQuery(`c:rmc:${campaign.id}`));
  assert.equal(q.getCampaign(campaign.id), null);
  assert.equal(q.getSetting('default_campaign_id'), null, 'default pointer is cleared with the campaign');
});

test('8d. deleting a campaign does not orphan the groups using it', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  const campaign = q.listCampaigns()[0];
  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech', type: 'supergroup' });
  q.updateGroup(GROUP_ID, { campaign_id: campaign.id });

  await bot.feedCallback(callbackQuery(`c:rmc:${campaign.id}`));

  assert.ok(q.getGroup(GROUP_ID), 'group survives');
  assert.equal(q.getGroup(GROUP_ID).campaign_id, null);
});

test('19. a language label never changes the campaign text', async (t) => {
  const { bot, q, cleanup } = boot();
  t.after(cleanup);
  const campaign = q.listCampaigns()[0];
  const mixed = 'ACC STORE — متجر — cửa hàng';
  q.updateCampaign(campaign.id, { text: mixed });

  await bot.feedCallback(callbackQuery(`c:setlang:${campaign.id}:ar`));

  assert.equal(q.getCampaign(campaign.id).language, 'ar');
  assert.equal(q.getCampaign(campaign.id).text, mixed, 'text is never auto-translated');
});

test('9d. caption length limit is enforced when media is attached', (t) => {
  const { q, cleanup } = boot();
  t.after(cleanup);
  const campaign = q.listCampaigns()[0];
  q.updateCampaign(campaign.id, { media_type: 'photo', media_file_id: 'PHOTO_ID' });
  const withMedia = q.getCampaign(campaign.id);

  const tooLong = 'x'.repeat(1100);
  assert.equal(campaignsHandler.validateFieldValue('text', tooLong, withMedia).ok, false);
  assert.equal(campaignsHandler.validateFieldValue('text', tooLong, { ...withMedia, media_file_id: null }).ok, true);
});
