'use strict';

/** Test doubles and fixtures shared by every test file. */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDatabase, closeDatabase } = require('../database/db');
const { createQueries } = require('../database/queries');
const configModule = require('../config');

const ADMIN_ID = 111111;
const OTHER_ADMIN_ID = 222222;
const STRANGER_ID = 999999;
const GROUP_ID = -1001234567890;

/** In-memory stand-in for node-telegram-bot-api. */
class FakeBot {
  constructor() {
    this.sent = [];
    this.edits = [];
    this.answers = [];
    this.deleted = [];
    this.polling = false;
    this._textHandlers = [];
    this._handlers = new Map();
    this._failures = [];
    this._chatMembers = new Map();
    this._nextMessageId = 1000;
  }

  // ---- registration surface used by the handlers
  onText(pattern, handler) {
    this._textHandlers.push([pattern, handler]);
  }

  on(event, handler) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(handler);
  }

  async emit(event, payload) {
    for (const handler of this._handlers.get(event) || []) {
      // eslint-disable-next-line no-await-in-loop
      await handler(payload);
    }
  }

  /** Feeds an incoming message through onText matchers and message listeners. */
  async feedMessage(msg) {
    if (typeof msg.text === 'string') {
      for (const [pattern, handler] of this._textHandlers) {
        pattern.lastIndex = 0;
        const match = pattern.exec(msg.text);
        // eslint-disable-next-line no-await-in-loop
        if (match) await handler(msg, match);
      }
    }
    await this.emit('message', msg);
    await new Promise((resolve) => setImmediate(resolve));
  }

  async feedCallback(query) {
    await this.emit('callback_query', query);
    await new Promise((resolve) => setImmediate(resolve));
  }

  // ---- failure injection
  /** Makes the next matching send throw `error`. */
  failNext(error, { times = 1 } = {}) {
    this._failures.push({ error, remaining: times });
  }

  _maybeFail() {
    const failure = this._failures[0];
    if (!failure) return;
    failure.remaining -= 1;
    if (failure.remaining <= 0) this._failures.shift();
    throw failure.error;
  }

  setChatMember(chatId, member) {
    this._chatMembers.set(Number(chatId), member);
  }

  // ---- Telegram API surface
  async sendMessage(chatId, text, options = {}) {
    this._maybeFail();
    const message = { message_id: this._nextMessageId++, chat: { id: chatId }, text, options, method: 'sendMessage' };
    this.sent.push(message);
    return message;
  }

  async sendPhoto(chatId, fileId, options = {}) {
    this._maybeFail();
    const message = { message_id: this._nextMessageId++, chat: { id: chatId }, fileId, options, method: 'sendPhoto' };
    this.sent.push(message);
    return message;
  }

  async sendVideo(chatId, fileId, options = {}) {
    return this.sendPhotoLike('sendVideo', chatId, fileId, options);
  }

  async sendAnimation(chatId, fileId, options = {}) {
    return this.sendPhotoLike('sendAnimation', chatId, fileId, options);
  }

  async sendPhotoLike(method, chatId, fileId, options) {
    this._maybeFail();
    const message = { message_id: this._nextMessageId++, chat: { id: chatId }, fileId, options, method };
    this.sent.push(message);
    return message;
  }

  async editMessageText(text, options = {}) {
    this.edits.push({ text, options });
    return { message_id: options.message_id, text };
  }

  async answerCallbackQuery(id, options = {}) {
    this.answers.push({ id, ...options });
    return true;
  }

  async deleteMessage(chatId, messageId) {
    this.deleted.push({ chatId, messageId: Number(messageId) });
    return true;
  }

  /**
   * Stands in for the Bot API file download used to cache campaign media so
   * the MTProto user account can upload it.
   */
  async downloadFile(fileId, targetDir) {
    this._maybeFail();
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, `${String(fileId).slice(0, 24)}.bin`);
    fs.writeFileSync(target, Buffer.from(`fake-media-for-${fileId}`));
    this.downloads = this.downloads || [];
    this.downloads.push({ fileId, target });
    return target;
  }

  async getChat(chatId) {
    return { id: Number(chatId), type: 'supergroup', title: 'Fake Group' };
  }

  async getChatMember(chatId, userId) {
    return this._chatMembers.get(Number(chatId)) || { status: 'administrator', user: { id: userId } };
  }

  async getMe() {
    return { id: 777, username: 'AccStoreAdvertiserBot', is_bot: true };
  }

  async startPolling() {
    this.polling = true;
  }

  async stopPolling() {
    this.polling = false;
  }

  // ---- assertions helpers
  messagesTo(chatId) {
    return this.sent.filter((m) => Number(m.chat.id) === Number(chatId));
  }

  lastMessage() {
    return this.sent[this.sent.length - 1];
  }

  allText() {
    return [...this.sent.map((m) => m.text || m.options?.caption || ''), ...this.edits.map((e) => e.text)].join('\n');
  }

  reset() {
    this.sent = [];
    this.edits = [];
    this.answers = [];
    this.deleted = [];
  }
}

/**
 * In-memory stand-in for a teleproto TelegramClient.
 * Records what was sent so tests can assert the user account was used.
 */
class FakeMTProtoClient {
  constructor({ authorized = true, me = null, dialogs = [] } = {}) {
    this.authorized = authorized;
    this.me = me || { id: 5550001, firstName: 'Ad', username: 'ad_sender', premium: false };
    this.dialogs = dialogs;
    this.sent = [];
    this.uploads = [];
    this.deleted = [];
    this.connected = false;
    this.disconnectCount = 0;
    this._failures = [];
    // Methods a selfbot would need. They exist ONLY so tests can prove the
    // product never calls them.
    this.joinCalls = [];
  }

  failNext(error, { times = 1 } = {}) {
    this._failures.push({ error, remaining: times });
  }

  _maybeFail() {
    const failure = this._failures[0];
    if (!failure) return;
    failure.remaining -= 1;
    if (failure.remaining <= 0) this._failures.shift();
    throw failure.error;
  }

  async connect() {
    this._maybeFail();
    this.connected = true;
    return true;
  }

  async disconnect() {
    this.connected = false;
    this.disconnectCount += 1;
    return true;
  }

  async isUserAuthorized() {
    return this.authorized;
  }

  async getMe() {
    this._maybeFail();
    return this.me;
  }

  async getDialogs() {
    this._maybeFail();
    return this.dialogs;
  }

  async getEntity(peer) {
    this._maybeFail();
    return { className: 'Channel', left: false, bannedRights: null, peer };
  }

  async sendMessage(peer, options) {
    this._maybeFail();
    const message = { id: 9000 + this.sent.length, peer, options, method: 'sendMessage' };
    this.sent.push(message);
    return message;
  }

  async sendFile(peer, options) {
    this._maybeFail();
    const message = { id: 9500 + this.sent.length, peer, options, method: 'sendFile' };
    this.sent.push(message);
    return message;
  }

  async uploadFile(options) {
    this._maybeFail();
    const handle = { name: 'uploaded', index: this.uploads.length };
    this.uploads.push(options);
    return handle;
  }

  async deleteMessages(peer, ids) {
    this.deleted.push({ peer, ids });
    return true;
  }

  // Never used by this project; present purely to assert that.
  async invoke(request) {
    const name = request?.className || '';
    if (/JoinChannel|ImportChatInvite|AddChatUser|CheckChatInvite/.test(name)) {
      this.joinCalls.push(name);
    }
    this._maybeFail();
    return {};
  }
}

/** Dialog fixture shaped like a teleproto Dialog for a supergroup. */
function fakeDialog({
  id = 1234567890, title = 'Test Group', username = null, megagroup = true,
  broadcast = false, left = false, basicGroup = false,
  defaultBannedRights = null, bannedRights = null, adminRights = null, creator = false,
  migratedTo = null, accessHash = '7418529637418529637', participantsCount = 42,
} = {}) {
  const bigInt = require('big-integer');
  const { Api } = require('teleproto');
  // Real Api objects, so the fixtures behave like genuine teleproto entities.
  const entity = basicGroup
    ? new Api.Chat({
      id: bigInt(String(id)), title, photo: null, participantsCount, date: 0, version: 0,
      left, migratedTo, defaultBannedRights, adminRights, creator,
    })
    : new Api.Channel({
      id: bigInt(String(id)), title, photo: null, date: 0, version: 0,
      username, megagroup, broadcast, left,
      accessHash: bigInt(String(accessHash)), defaultBannedRights, bannedRights, adminRights, creator, participantsCount,
    });
  return { entity, title };
}

/** Builds a Telegram API error shaped like node-telegram-bot-api throws. */
function telegramError(code, description, parameters) {
  const error = new Error(`ETELEGRAM: ${code} ${description}`);
  error.code = 'ETELEGRAM';
  error.response = { body: { ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) } };
  return error;
}

function makeTempDbPath(label = 'advertiser') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)), 'advertiser.db');
}

function testConfig(overrides = {}) {
  return configModule.build({
    // Assembled at runtime so no token-shaped literal ever sits in the source.
    BOT_TOKEN: ['123456', 'TEST-VALUE-NOT-A-REAL-TOKEN-000000000'].join(':'),
    ADMIN_IDS: `${ADMIN_ID},${OTHER_ADMIN_ID}`,
    MAIN_STORE_BOT_URL: 'https://t.me/ExampleStoreBot',
    DEFAULT_AD_INTERVAL_MINUTES: '360',
    TZ: 'Asia/Baghdad',
    SEND_DELAY_MS: '1',
    SCHEDULER_TICK_MS: '60000',
    // MTProto credentials are fake and assembled at runtime so no
    // credential-shaped literal ever sits in the source.
    TELEGRAM_API_ID: '1234567',
    TELEGRAM_API_HASH: ['abcdef0123456789', 'abcdef0123456789'].join(''),
    TELEGRAM_USER_SESSION: ['1AAAAA', 'fake-test-session-value-not-real'].join(''),
    USER_SEND_DELAY_MS: '1',
    ...overrides,
  });
}

/** Opens a fresh database plus query layer at `dbPath`. */
function openTestDb(dbPath) {
  const dbInfo = openDatabase({ dbPath });
  return { dbInfo, q: createQueries(dbInfo.db), close: () => closeDatabase(dbInfo.db) };
}

/** Message fixtures. */
function privateMessage(text, { from = ADMIN_ID } = {}) {
  return { message_id: 1, text, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false } };
}

function groupMessage(text, { from = ADMIN_ID, chatId = GROUP_ID, type = 'supergroup', title = 'Tech Marketplace' } = {}) {
  return { message_id: 2, text, chat: { id: chatId, type, title }, from: { id: from, is_bot: false } };
}

function callbackQuery(data, { from = ADMIN_ID, chatId = from, messageId = 500 } = {}) {
  return { id: `cbq-${Math.random().toString(36).slice(2)}`, data, from: { id: from }, message: { message_id: messageId, chat: { id: chatId, type: 'private' } } };
}

module.exports = {
  FakeBot,
  FakeMTProtoClient,
  fakeDialog,
  telegramError,
  makeTempDbPath,
  testConfig,
  openTestDb,
  privateMessage,
  groupMessage,
  callbackQuery,
  ADMIN_ID,
  OTHER_ADMIN_ID,
  STRANGER_ID,
  GROUP_ID,
};
