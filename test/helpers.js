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
