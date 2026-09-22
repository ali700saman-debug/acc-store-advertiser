'use strict';

/**
 * MTProto USER ACCOUNT sender.
 *
 * This is the only component that talks to Telegram as a normal user account.
 * It exists to post advertisements to groups the account has ALREADY been
 * joined to manually, and which an admin has explicitly selected in the panel.
 *
 * It deliberately does NOT implement: joining chats, resolving invite links,
 * searching for groups, reading other people's messages, or any bypass of a
 * rate limit Telegram asks for.
 *
 * The client is injected (`createClient`) so the whole module is testable
 * without a real Telegram connection.
 */

const fs = require('fs');
const path = require('path');

const { makeLogger } = require('../utils/logger');

const STATUS = {
  DISABLED: 'disabled',
  NOT_CONFIGURED: 'not_configured',
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  UNAVAILABLE: 'unavailable',
};

const REASONS = {
  FLOOD_WAIT: 'FLOOD_WAIT',
  SLOWMODE_WAIT: 'SLOWMODE_WAIT',
  PEER_FLOOD: 'PEER_FLOOD',
  WRITE_FORBIDDEN: 'WRITE_FORBIDDEN',
  BANNED_IN_CHAT: 'BANNED_IN_CHAT',
  PEER_INVALID: 'PEER_INVALID',
  NOT_MEMBER: 'NOT_MEMBER',
  SESSION_INVALID: 'SESSION_INVALID',
  MEDIA_UNAVAILABLE: 'MEDIA_UNAVAILABLE',
  SENDER_UNAVAILABLE: 'SENDER_UNAVAILABLE',
  NETWORK: 'NETWORK',
  UNKNOWN: 'UNKNOWN',
};

const FRIENDLY = {
  [REASONS.FLOOD_WAIT]: 'Telegram asked the account to wait (flood limit)',
  [REASONS.SLOWMODE_WAIT]: 'Group slow mode is active',
  [REASONS.PEER_FLOOD]: 'Account is temporarily limited by Telegram for spam',
  [REASONS.WRITE_FORBIDDEN]: 'The account is not allowed to send messages here',
  [REASONS.BANNED_IN_CHAT]: 'The account is banned in this chat',
  [REASONS.PEER_INVALID]: 'Chat could not be resolved by the account',
  [REASONS.NOT_MEMBER]: 'The account is not a member of this chat',
  [REASONS.SESSION_INVALID]: 'The user session is invalid or was revoked',
  [REASONS.MEDIA_UNAVAILABLE]: 'Campaign media file is not available locally',
  [REASONS.SENDER_UNAVAILABLE]: 'User sender is not connected',
  [REASONS.NETWORK]: 'Network error contacting Telegram',
  [REASONS.UNKNOWN]: 'Unknown MTProto error',
};

/** Reasons that will not resolve by simply retrying this group later. */
const PERMANENT = new Set([
  REASONS.WRITE_FORBIDDEN,
  REASONS.BANNED_IN_CHAT,
  REASONS.PEER_INVALID,
  REASONS.NOT_MEMBER,
  REASONS.MEDIA_UNAVAILABLE,
]);

function errorText(error) {
  return String(error?.errorMessage || error?.message || error || '').toUpperCase();
}

/**
 * Classifies an MTProto error.
 *
 * `scope` matters: FLOOD_WAIT and PEER_FLOOD apply to the whole ACCOUNT and
 * must gate every send, while SLOWMODE_WAIT applies only to one CHAT.
 */
function classifyUserError(error) {
  const text = errorText(error);
  const name = String(error?.className || error?.constructor?.name || '');
  const seconds = Number.isFinite(error?.seconds) ? Number(error.seconds) : null;

  const base = { code: name || null, description: String(error?.message || text), waitSeconds: seconds };

  if (name === 'FloodWaitError' || /^FLOOD_WAIT/.test(text)) {
    return { ...base, reason: REASONS.FLOOD_WAIT, scope: 'account', permanent: false, friendly: FRIENDLY[REASONS.FLOOD_WAIT] };
  }
  if (name === 'SlowModeWaitError' || /^SLOWMODE_WAIT/.test(text)) {
    return { ...base, reason: REASONS.SLOWMODE_WAIT, scope: 'chat', permanent: false, friendly: FRIENDLY[REASONS.SLOWMODE_WAIT] };
  }
  if (name === 'PeerFloodError' || /PEER_FLOOD/.test(text)) {
    // Telegram's anti-spam signal. Never retry hard against this.
    return { ...base, reason: REASONS.PEER_FLOOD, scope: 'account', permanent: false, friendly: FRIENDLY[REASONS.PEER_FLOOD] };
  }
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|AUTH_KEY_INVALID|USER_DEACTIVATED/.test(text)
    || /AuthKeyUnregistered|SessionRevoked|SessionExpired|AuthKeyInvalid/.test(name)) {
    return { ...base, reason: REASONS.SESSION_INVALID, scope: 'account', permanent: true, friendly: FRIENDLY[REASONS.SESSION_INVALID] };
  }
  if (/CHAT_WRITE_FORBIDDEN|CHAT_SEND_.*FORBIDDEN|TOPIC_CLOSED/.test(text)) {
    return { ...base, reason: REASONS.WRITE_FORBIDDEN, scope: 'chat', permanent: true, friendly: FRIENDLY[REASONS.WRITE_FORBIDDEN] };
  }
  if (/USER_BANNED_IN_CHANNEL|CHAT_RESTRICTED/.test(text)) {
    return { ...base, reason: REASONS.BANNED_IN_CHAT, scope: 'chat', permanent: true, friendly: FRIENDLY[REASONS.BANNED_IN_CHAT] };
  }
  if (/CHANNEL_PRIVATE|CHAT_ID_INVALID|PEER_ID_INVALID|CHANNEL_INVALID/.test(text)) {
    return { ...base, reason: REASONS.PEER_INVALID, scope: 'chat', permanent: true, friendly: FRIENDLY[REASONS.PEER_INVALID] };
  }
  if (/USER_NOT_PARTICIPANT|CHAT_GUEST_SEND_FORBIDDEN/.test(text)) {
    return { ...base, reason: REASONS.NOT_MEMBER, scope: 'chat', permanent: true, friendly: FRIENDLY[REASONS.NOT_MEMBER] };
  }
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|SOCKET|NETWORK|DISCONNECT|TIMEOUT/.test(text)) {
    return { ...base, reason: REASONS.NETWORK, scope: 'account', permanent: false, friendly: FRIENDLY[REASONS.NETWORK] };
  }
  return { ...base, reason: REASONS.UNKNOWN, scope: 'chat', permanent: false, friendly: FRIENDLY[REASONS.UNKNOWN] };
}

/**
 * Entity -> Bot API style marked chat id (-100<id> for channels/supergroups,
 * -<id> for basic groups).
 *
 * Computed here rather than via the library's own helper so that the id space
 * is explicit, shared with the bot-registered groups, and testable without
 * constructing library internals.
 */
function markedChatId(entity) {
  if (!entity || entity.id === undefined || entity.id === null) return null;
  const raw = String(entity.id).replace(/^-/, '');
  if (!/^\d+$/.test(raw)) return null;
  if (entity.className === 'Chat') return -Number(raw);
  if (entity.className === 'Channel') return -Number(`100${raw}`);
  return null;
}

/** Bot-API style marked id -> MTProto peer components. */
function peerPartsFromChatId(chatId, peerType) {
  const asString = String(chatId);
  if (peerType === 'channel' || asString.startsWith('-100')) {
    return { kind: 'channel', id: asString.replace(/^-100/, '') };
  }
  if (asString.startsWith('-')) {
    return { kind: 'chat', id: asString.slice(1) };
  }
  return { kind: 'user', id: asString };
}

/** The default real client factory. Kept isolated so tests never load it. */
function defaultCreateClient({ apiId, apiHash, session, connectionRetries = 3, timeoutMs = 30000 }) {
  // Required lazily: a missing/unused MTProto dependency must never break boot.
  const { TelegramClient, Logger } = require('teleproto');
  const { StringSession } = require('teleproto/sessions');
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries,
    timeout: Math.ceil(timeoutMs / 1000),
    // Supplied at construction: the library logs its banner before any
    // setLogLevel call could take effect.
    baseLogger: new Logger('error'),
    // Always surface flood waits to our own queue instead of sleeping inside
    // the library, so deferral is recorded in SQLite and visible to the admin.
    floodSleepThreshold: 0,
    autoReconnect: true,
  });
  // The library logs to stdout directly, bypassing our redacting logger.
  // Keep it at 'error' so nothing it prints can leak past redaction.
  if (typeof client.setLogLevel === 'function') client.setLogLevel('error');
  return client;
}

/**
 * Races a promise against a deadline.
 *
 * Connecting must never be able to hang: if the network stalls, the admin bot
 * still has to finish booting. Telegram MTProto uses raw TCP, which can block
 * for a long time behind a firewall with no error at all.
 */
async function withDeadline(promise, ms, label = 'operation') {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms`);
      error.errorMessage = 'TIMEOUT';
      reject(error);
    }, ms);
    // Deliberately NOT unref'd: the timer must be able to fire even when
    // nothing else is keeping the event loop alive. It is always cleared in
    // the finally block below, so it never delays shutdown.
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createUserSender({ config, logger = makeLogger('User Sender'), createClient = defaultCreateClient } = {}) {
  const service = {};

  let client = null;
  let status = STATUS.DISCONNECTED;
  let reason = null;
  let me = null;
  let lastConnectedAt = null;

  const setStatus = (next, why = null) => {
    status = next;
    reason = why;
  };

  service.isConnected = () => status === STATUS.CONNECTED && Boolean(client);

  /** Safe status for the admin panel. Never includes any credential. */
  service.getStatus = () => ({
    status,
    connected: service.isConnected(),
    reason,
    lastConnectedAt,
    account: me
      ? { id: me.id, firstName: me.firstName || null, username: me.username || null, premium: Boolean(me.premium) }
      : null,
  });

  /**
   * Connects the user account. Never throws: a bad session must leave the
   * admin bot fully usable, with the problem visible in the panel.
   */
  service.connect = async () => {
    if (!config.userSenderEnabled) {
      setStatus(STATUS.DISABLED, 'USER_SENDER_ENABLED is false');
      return service.getStatus();
    }
    const missing = require('../config').validateUserSender(config);
    if (missing.length) {
      setStatus(STATUS.NOT_CONFIGURED, missing.join(' '));
      return service.getStatus();
    }

    setStatus(STATUS.CONNECTING);
    const deadline = config.userConnectTimeoutMs;
    try {
      client = createClient({
        apiId: config.userApiId,
        apiHash: config.userApiHash,
        session: config.userSession,
        timeoutMs: deadline,
      });

      // The whole handshake shares one deadline, so boot cannot stall.
      await withDeadline(client.connect(), deadline, 'MTProto connect');

      const authorized = await withDeadline(client.isUserAuthorized(), deadline, 'authorization check');
      if (!authorized) {
        setStatus(STATUS.UNAVAILABLE, FRIENDLY[REASONS.SESSION_INVALID]);
        logger.warn('unavailable: session is not authorized (regenerate it with npm run login:user)');
        await service.disconnect();
        setStatus(STATUS.UNAVAILABLE, FRIENDLY[REASONS.SESSION_INVALID]);
        return service.getStatus();
      }

      me = await withDeadline(client.getMe(), deadline, 'getMe');
      lastConnectedAt = new Date().toISOString();
      setStatus(STATUS.CONNECTED);
      logger.info('MTProto session loaded');
      logger.info(`connected as ${me?.username ? `@${me.username}` : me?.firstName || 'user account'}`);
      return service.getStatus();
    } catch (error) {
      const timedOut = String(error?.errorMessage) === 'TIMEOUT';
      const info = classifyUserError(error);
      const friendly = timedOut ? 'Could not reach Telegram in time' : info.friendly;
      // Drop the half-open client so it cannot hold the process open.
      try {
        if (client) {
          await client.disconnect();
          if (typeof client.destroy === 'function') await client.destroy();
        }
      } catch (_) {
        // Already broken; nothing useful to do.
      }
      client = null;
      setStatus(STATUS.UNAVAILABLE, friendly);
      // Never include the session; the logger also redacts it as a backstop.
      logger.warn(`unavailable: ${timedOut ? 'connect timed out' : info.reason}`);
      return service.getStatus();
    }
  };

  service.reconnect = async () => {
    await service.disconnect();
    return service.connect();
  };

  service.disconnect = async () => {
    if (!client) {
      setStatus(STATUS.DISCONNECTED);
      return false;
    }
    try {
      await client.disconnect();
      if (typeof client.destroy === 'function') await client.destroy();
    } catch (error) {
      logger.warn(`disconnect: ${classifyUserError(error).reason}`);
    } finally {
      client = null;
      setStatus(STATUS.DISCONNECTED);
    }
    return true;
  };

  /** Confirms the session still works. Returns a safe result object. */
  service.checkSession = async () => {
    if (!service.isConnected()) {
      const result = await service.connect();
      return { ok: result.connected, status: result.status, reason: result.reason, account: result.account };
    }
    try {
      me = await client.getMe();
      return { ok: true, status, reason: null, account: service.getStatus().account };
    } catch (error) {
      const info = classifyUserError(error);
      if (info.reason === REASONS.SESSION_INVALID) setStatus(STATUS.UNAVAILABLE, info.friendly);
      return { ok: false, status, reason: info.friendly, account: null };
    }
  };

  /**
   * Lists the groups the USER ACCOUNT is already a member of.
   *
   * This reads the account's own dialog list — nothing is joined, searched for
   * or discovered. Chats where sending is clearly not permitted are reported
   * separately rather than offered for selection.
   */
  service.listGroups = async ({ limit = 200 } = {}) => {
    if (!service.isConnected()) {
      return { ok: false, reason: REASONS.SENDER_UNAVAILABLE, friendly: FRIENDLY[REASONS.SENDER_UNAVAILABLE], groups: [], hidden: 0 };
    }
    let dialogs;
    try {
      dialogs = await client.getDialogs({ limit });
    } catch (error) {
      const info = classifyUserError(error);
      if (info.reason === REASONS.SESSION_INVALID) setStatus(STATUS.UNAVAILABLE, info.friendly);
      return { ok: false, reason: info.reason, friendly: info.friendly, groups: [], hidden: 0 };
    }

    const groups = [];
    let hidden = 0;

    for (const dialog of dialogs || []) {
      const entity = dialog?.entity;
      if (!entity) continue;

      const isBasicGroup = entity.className === 'Chat';
      const isChannel = entity.className === 'Channel';
      const isSupergroup = isChannel && Boolean(entity.megagroup);
      const isBroadcast = isChannel && Boolean(entity.broadcast);

      // Only real groups. Broadcast channels only when explicitly allowed.
      if (!isBasicGroup && !isSupergroup && !(isBroadcast && config.allowChannels)) continue;
      // A basic group that was migrated appears again as its supergroup.
      if (isBasicGroup && entity.migratedTo) continue;
      // Not a member any more.
      if (entity.left) { hidden += 1; continue; }

      // Sending clearly forbidden: either everyone is banned from sending and
      // we are not an admin, or this account specifically is restricted.
      const ownRestriction = Boolean(entity.bannedRights?.sendMessages);
      const everyoneRestricted = Boolean(entity.defaultBannedRights?.sendMessages);
      const isPrivileged = Boolean(entity.creator || entity.adminRights);
      if (ownRestriction || (everyoneRestricted && !isPrivileged)) { hidden += 1; continue; }

      const chatId = markedChatId(entity);
      if (!Number.isSafeInteger(chatId)) {
        hidden += 1;
        continue;
      }

      groups.push({
        chatId,
        title: entity.title || String(chatId),
        username: entity.username || null,
        type: isBasicGroup ? 'group' : isSupergroup ? 'supergroup' : 'channel',
        peerType: isBasicGroup ? 'chat' : 'channel',
        // Kept as a string: a 64-bit access hash is not a safe JS number.
        accessHash: entity.accessHash === undefined || entity.accessHash === null ? null : String(entity.accessHash),
        participants: Number.isFinite(entity.participantsCount) ? entity.participantsCount : null,
      });
    }

    return { ok: true, groups, hidden, total: (dialogs || []).length };
  };

  /** Builds an InputPeer from the values stored in SQLite. */
  service.buildInputPeer = (group) => {
    const { Api } = require('teleproto');
    const bigInt = require('big-integer');
    const parts = peerPartsFromChatId(group.chat_id, group.peer_type);

    if (parts.kind === 'channel') {
      if (!group.access_hash) {
        const error = new Error('PEER_ID_INVALID: missing access_hash for channel peer');
        error.errorMessage = 'PEER_ID_INVALID';
        throw error;
      }
      return new Api.InputPeerChannel({ channelId: bigInt(parts.id), accessHash: bigInt(String(group.access_hash)) });
    }
    if (parts.kind === 'chat') {
      return new Api.InputPeerChat({ chatId: bigInt(parts.id) });
    }
    const error = new Error('PEER_ID_INVALID: advertising to private chats is not supported');
    error.errorMessage = 'PEER_ID_INVALID';
    throw error;
  };

  /**
   * Verifies the account can currently reach a peer, before it is added to
   * the allowlist. Returns { ok, reason, friendly }.
   */
  service.verifyPeer = async (group) => {
    if (!service.isConnected()) {
      return { ok: false, reason: REASONS.SENDER_UNAVAILABLE, friendly: FRIENDLY[REASONS.SENDER_UNAVAILABLE] };
    }
    try {
      const peer = service.buildInputPeer(group);
      const entity = await client.getEntity(peer);
      if (entity?.left) {
        return { ok: false, reason: REASONS.NOT_MEMBER, friendly: FRIENDLY[REASONS.NOT_MEMBER] };
      }
      if (entity?.bannedRights?.sendMessages) {
        return { ok: false, reason: REASONS.WRITE_FORBIDDEN, friendly: FRIENDLY[REASONS.WRITE_FORBIDDEN] };
      }
      return { ok: true, reason: null, friendly: 'Account can post here', entity };
    } catch (error) {
      const info = classifyUserError(error);
      return { ok: false, reason: info.reason, friendly: info.friendly };
    }
  };

  /**
   * Uploads a media file once so one file can be reused across a whole batch
   * instead of being re-uploaded per group.
   */
  service.uploadMedia = async (localPath) => {
    if (!service.isConnected()) throw Object.assign(new Error('sender unavailable'), { errorMessage: 'SENDER_UNAVAILABLE' });
    if (!localPath || !fs.existsSync(localPath)) {
      throw Object.assign(new Error('media file missing'), { errorMessage: 'MEDIA_UNAVAILABLE' });
    }
    const { CustomFile } = require('teleproto/client/uploads');
    const stats = fs.statSync(localPath);
    return client.uploadFile({
      file: new CustomFile(path.basename(localPath), stats.size, localPath),
      workers: 1,
    });
  };

  /**
   * Sends one rendered campaign plan to one group as the user account.
   * `uploadedFile` lets a batch reuse a single upload.
   */
  service.send = async (group, plan, { uploadedFile = null } = {}) => {
    if (!service.isConnected()) {
      throw Object.assign(new Error(FRIENDLY[REASONS.SENDER_UNAVAILABLE]), { errorMessage: 'SENDER_UNAVAILABLE' });
    }
    const peer = service.buildInputPeer(group);
    const parseMode = String(plan.parseMode || 'HTML').toLowerCase() === 'html' ? 'html' : undefined;

    if (plan.mediaType && (uploadedFile || plan.mediaLocalPath)) {
      const file = uploadedFile || plan.mediaLocalPath;
      if (!uploadedFile && !fs.existsSync(plan.mediaLocalPath)) {
        throw Object.assign(new Error(FRIENDLY[REASONS.MEDIA_UNAVAILABLE]), { errorMessage: 'MEDIA_UNAVAILABLE' });
      }
      const message = await client.sendFile(peer, {
        file,
        caption: plan.text,
        parseMode,
        forceDocument: false,
        // A GIF must keep its animation rather than become a video file.
        videoNote: false,
      });
      return { messageId: message?.id ?? null };
    }

    if (plan.mediaType && !plan.mediaLocalPath && !uploadedFile) {
      // A Bot API file_id is not usable over MTProto; the local copy is required.
      throw Object.assign(new Error(FRIENDLY[REASONS.MEDIA_UNAVAILABLE]), { errorMessage: 'MEDIA_UNAVAILABLE' });
    }

    const message = await client.sendMessage(peer, {
      message: plan.text,
      parseMode,
      linkPreview: false,
    });
    return { messageId: message?.id ?? null };
  };

  /** Deletes one of the account's own previous advertisements. Never throws. */
  service.deleteMessage = async (group, messageId) => {
    if (!service.isConnected() || !messageId) return false;
    try {
      const peer = service.buildInputPeer(group);
      await client.deleteMessages(peer, [Number(messageId)], { revoke: true });
      return true;
    } catch (error) {
      logger.warn(`deleteMessage: ${classifyUserError(error).reason}`);
      return false;
    }
  };

  /** Test seam: lets tests inspect or stub the underlying client. */
  service._setClient = (next, nextStatus = STATUS.CONNECTED) => {
    client = next;
    setStatus(nextStatus);
  };

  return service;
}

module.exports = {
  createUserSender,
  withDeadline,
  classifyUserError,
  peerPartsFromChatId,
  markedChatId,
  defaultCreateClient,
  STATUS,
  REASONS,
  FRIENDLY,
  PERMANENT,
};
