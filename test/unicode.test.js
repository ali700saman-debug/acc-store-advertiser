'use strict';

/**
 * Regression tests for the production failure:
 *
 *   400 Bad Request: inline keyboard button text must be encoded in UTF-8
 *
 * A group title with an emoji straddling the truncation offset produced a
 * lone surrogate, which is not encodable as UTF-8. One bad label rejects the
 * WHOLE keyboard, so Import My Groups failed entirely.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { safeButtonLabel, sanitizeUnicode, truncateGraphemes, graphemeLength, isValidUtf8 } = require('../utils/text');
const { button } = require('../utils/keyboard');
const { esc, truncate } = require('../utils/html');
const { createApp } = require('../index');
const { ensureDefaultCampaign } = require('../database/seed');
const {
  FakeBot, FakeMTProtoClient, fakeDialog, makeTempDbPath, testConfig, openTestDb, callbackQuery,
} = require('./helpers');

/** Asserts a string is something Telegram can actually accept. */
function assertTelegramSafe(value, label) {
  assert.equal(typeof value, 'string', `${label}: is a string`);
  assert.equal(isValidUtf8(value), true, `${label}: encodes as UTF-8`);
  const hasLoneSurrogate = [...value].some((ch) => {
    const code = ch.codePointAt(0);
    return code >= 0xD800 && code <= 0xDFFF;
  });
  assert.equal(hasLoneSurrogate, false, `${label}: no lone surrogate`);
  assert.equal(JSON.parse(JSON.stringify(value)), value, `${label}: survives JSON round trip`);
}

// The exact production shape: emoji at the truncation boundary.
const EMOJI_AT_BOUNDARY = 'Digital Market Iraq — بغداد 🛒🔥 Subscriptions Group';

test('1. the original bug: slicing by code unit produced invalid UTF-8', () => {
  // Reproduce what the old implementation did.
  const broken = `${EMOJI_AT_BOUNDARY.slice(0, 29)}…`;
  assert.equal(isValidUtf8(broken), false, 'the old slice really was invalid');

  // And the fix.
  assertTelegramSafe(safeButtonLabel(EMOJI_AT_BOUNDARY, { max: 30 }), 'sanitized');
});

test('1b. an invalid Unicode title does not crash the sanitizer', () => {
  const nasty = [
    'Broken \uD83D title',                 // lone high surrogate
    'Broken \uDE00 title',                 // lone low surrogate
    '\uD800\uD800\uD800',                  // consecutive high surrogates
    '\uDFFF',                              // bare low surrogate
    'mix 😀 ok \uD83D bad',      // valid pair AND a lone surrogate
    'null\u0000byte\u0007bell',            // control characters
    'evil‮txt.exe',                   // bidi override
  ];
  for (const input of nasty) {
    const label = safeButtonLabel(input, { max: 26 });
    assertTelegramSafe(label, JSON.stringify(input));
    assert.ok(label.length > 0, 'never empty');
  }
});

test('2. Kurdish (ckb) titles work', () => {
  const title = 'کۆمەڵەی فرۆشتنی ئەکاونت و بەشداریی دیجیتاڵی لە هەولێر';
  const label = safeButtonLabel(title, { max: 26 });
  assertTelegramSafe(label, 'kurdish');
  assert.ok(label.startsWith('کۆمەڵەی'), 'Kurdish script preserved');
  // Short Kurdish titles must not be altered at all.
  assert.equal(safeButtonLabel('گرووپی هەولێر', { max: 26 }), 'گرووپی هەولێر');
});

test('3. Arabic titles work', () => {
  const title = 'مجموعة الاشتراكات الرقمية في بغداد للبيع والشراء';
  const label = safeButtonLabel(title, { max: 26 });
  assertTelegramSafe(label, 'arabic');
  assert.ok(label.startsWith('مجموعة'), 'Arabic script preserved');
  assert.equal(safeButtonLabel('سوق بغداد', { max: 26 }), 'سوق بغداد');
});

test('4. Vietnamese titles work, including combining diacritics', () => {
  const title = 'Nhóm mua bán tài khoản dịch vụ số Việt Nam giá rẻ';
  const label = safeButtonLabel(title, { max: 26 });
  assertTelegramSafe(label, 'vietnamese');
  assert.ok(label.startsWith('Nhóm mua'), 'diacritics preserved');

  // A decomposed form must not lose its combining mark when truncated.
  const decomposed = 'Việt Nam Group'.normalize('NFD');
  const short = safeButtonLabel(decomposed, { max: 4 });
  assertTelegramSafe(short, 'decomposed vietnamese');
});

test('5. emoji titles work, including ZWJ sequences and flags', () => {
  assertTelegramSafe(safeButtonLabel('🛒🔥💎🎯🚀🎁💰📦🌟⚡', { max: 26 }), 'emoji only');

  // A ZWJ family and a regional-indicator flag are single user-perceived
  // characters and must never be split.
  const family = 'Family 👨‍👩‍👧‍👦 Group 🇮🇶';
  const label = safeButtonLabel(family, { max: 26 });
  assertTelegramSafe(label, 'zwj + flag');
  assert.ok(label.includes('👨‍👩‍👧‍👦'), 'ZWJ family kept intact');

  // Cutting right at the flag must not leave half a flag.
  for (let max = 1; max <= 20; max += 1) {
    assertTelegramSafe(safeButtonLabel(family, { max }), `flag cut at ${max}`);
  }
});

test('5b. a Spanish title works', () => {
  const label = safeButtonLabel('Grupo de suscripciones digitales en español — ofertas', { max: 26 });
  assertTelegramSafe(label, 'spanish');
  assert.ok(label.startsWith('Grupo de'));
});

test('6. very long titles are shortened by character, not by byte', () => {
  const longAscii = 'X'.repeat(500);
  const asciiLabel = safeButtonLabel(longAscii, { max: 26 });
  assert.equal(graphemeLength(asciiLabel), 26);
  assertTelegramSafe(asciiLabel, 'long ascii');

  // 300 emoji is 1200 bytes; truncation must count characters, not bytes.
  const longEmoji = '🎯'.repeat(300);
  const emojiLabel = safeButtonLabel(longEmoji, { max: 26 });
  assert.equal(graphemeLength(emojiLabel), 26, 'counted as 26 characters');
  assert.ok(Buffer.byteLength(emojiLabel, 'utf8') > 26, 'and it really is more than 26 bytes');
  assertTelegramSafe(emojiLabel, 'long emoji');

  const longArabic = 'مجموعة '.repeat(100);
  assertTelegramSafe(safeButtonLabel(longArabic, { max: 26 }), 'long arabic');
});

test('6b. empty or whitespace-only titles fall back to a readable name', () => {
  assert.equal(safeButtonLabel(''), 'Unnamed group');
  assert.equal(safeButtonLabel('   \n\t  '), 'Unnamed group');
  assert.equal(safeButtonLabel(null), 'Unnamed group');
  assert.equal(safeButtonLabel(undefined), 'Unnamed group');
  assert.equal(safeButtonLabel('\uD800'), 'Unnamed group', 'a title of only broken data');
  assert.equal(safeButtonLabel('', { fallback: 'No name' }), 'No name');
});

test('6c. every button built by the keyboard helper is Telegram-safe', () => {
  const inputs = [EMOJI_AT_BOUNDARY, 'Broken \uD83D title', '', '🎯'.repeat(300), 'کۆمەڵە', null];
  for (const input of inputs) {
    const built = button(input, 'ns:action');
    assertTelegramSafe(built.text, `button(${JSON.stringify(input)})`);
  }
  // Ordinary static labels are untouched.
  assert.equal(button('✅ Add Selected (3)', 'x:y').text, '✅ Add Selected (3)');
  assert.equal(button('⬅️ Back', 'x:y').text, '⬅️ Back');
});

test('6d. message bodies are sanitized too', () => {
  // A bad title in message TEXT is rejected the same way as in a button.
  assertTelegramSafe(esc('Group \uD83D broken <b>x</b>'), 'escaped body');
  assert.equal(esc('<b>').includes('&lt;'), true, 'still escapes HTML');
  assertTelegramSafe(truncate(EMOJI_AT_BOUNDARY, 30), 'truncate()');
  assert.equal(sanitizeUnicode('plain text'), 'plain text', 'clean text is untouched');
});

test('6e. truncateGraphemes never splits a surrogate pair at any length', () => {
  const mixed = 'a🛒b🔥c👨‍👩‍👧d🇮🇶e';
  for (let max = 0; max <= graphemeLength(mixed) + 3; max += 1) {
    assertTelegramSafe(truncateGraphemes(mixed, max), `max=${max}`);
  }
});

// ---------------------------------------------------------------- end to end

function boot({ dialogs = [] } = {}) {
  const dbPath = makeTempDbPath('unicode');
  const { dbInfo, q, close } = openTestDb(dbPath);
  const config = testConfig();
  const bot = new FakeBot();
  const mt = new FakeMTProtoClient({ dialogs });
  const ctx = createApp({ bot, config, dbInfo, createClient: () => mt });
  ctx.botInfo = { id: 777, username: 'AD_SENDER_9_bot' };
  ensureDefaultCampaign(q, config);
  return { bot, mt, ctx, q, cleanup: () => { close(); fs.rmSync(dbPath, { force: true }); } };
}

test('1c. Import My Groups renders a valid keyboard for hostile titles', async (t) => {
  const h = boot({
    dialogs: [
      fakeDialog({ id: 1000000001, title: EMOJI_AT_BOUNDARY }),
      fakeDialog({ id: 1000000002, title: 'کۆمەڵەی فرۆشتنی ئەکاونت دیجیتاڵی لە هەولێر' }),
      fakeDialog({ id: 1000000003, title: 'مجموعة الاشتراكات الرقمية في بغداد' }),
      fakeDialog({ id: 1000000004, title: 'Nhóm mua bán tài khoản dịch vụ số' }),
      fakeDialog({ id: 1000000005, title: 'Broken \uD83D title' }),
      fakeDialog({ id: 1000000006, title: '' }),
      fakeDialog({ id: 1000000007, title: '🎯'.repeat(300) }),
      fakeDialog({ id: 1000000008, title: '👨‍👩‍👧‍👦 Family 🇮🇶 Market' }),
    ],
  });
  t.after(h.cleanup);
  await h.ctx.userSender.connect();

  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));

  const panel = h.bot.edits[h.bot.edits.length - 1];
  assert.ok(panel, 'the import panel rendered instead of failing');
  assertTelegramSafe(panel.text, 'panel body');

  const keyboard = panel.options.reply_markup.inline_keyboard;
  assert.ok(keyboard.length > 0, 'keyboard has rows');
  for (const row of keyboard) {
    for (const btn of row) {
      assertTelegramSafe(btn.text, `button "${btn.text}"`);
    }
  }
  // The whole payload must serialise, which is what the Bot API does.
  assertTelegramSafe(JSON.stringify(panel.options.reply_markup), 'serialised keyboard');
});

test('1d. a group list of hostile titles also renders safely', async (t) => {
  const h = boot();
  t.after(h.cleanup);
  for (const [i, title] of [EMOJI_AT_BOUNDARY, 'Broken \uD83D title', '🎯'.repeat(300), ''].entries()) {
    h.q.registerUserGroup({ chat_id: -100200000000 - i, title, type: 'supergroup', peer_type: 'channel', access_hash: '1' });
  }

  await h.bot.feedCallback(callbackQuery('g:list:0'));

  const panel = h.bot.edits[h.bot.edits.length - 1];
  for (const row of panel.options.reply_markup.inline_keyboard) {
    for (const btn of row) assertTelegramSafe(btn.text, btn.text);
  }
});

test('1e. the import summary body is safe for hostile titles', async (t) => {
  const h = boot({ dialogs: [fakeDialog({ id: 1000000001, title: 'Broken \uD83D \uDE00 market 🛒' })] });
  t.after(h.cleanup);
  await h.ctx.userSender.connect();

  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:0'));
  await h.bot.feedCallback(callbackQuery('sndr:add'));

  const panel = h.bot.edits[h.bot.edits.length - 1];
  assertTelegramSafe(panel.text, 'summary body');
  assert.match(panel.text, /Added 1 group/);
});

test('1f. the stored group title is NOT modified, only the display label', async (t) => {
  const original = 'Market 🛒🔥 بغداد Group With A Very Long Name Indeed';
  const h = boot({ dialogs: [fakeDialog({ id: 1000000001, title: original })] });
  t.after(h.cleanup);
  await h.ctx.userSender.connect();

  await h.bot.feedCallback(callbackQuery('sndr:imp:0'));
  await h.bot.feedCallback(callbackQuery('sndr:t:0:0'));
  await h.bot.feedCallback(callbackQuery('sndr:add'));

  assert.equal(h.q.getGroup(-1001000000001).title, original, 'full title kept in the database');
});
