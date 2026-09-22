'use strict';

/**
 * ⚙️ Sender Account panel and the "Import My Groups" flow.
 *
 * Import reads ONLY the dialog list of the authenticated user account — the
 * chats it has already been joined to by hand. Nothing is joined, searched
 * for, resolved from an invite link, or discovered. Selecting a chat here is
 * what puts it on the allowlist; membership alone never does.
 */

const { cb, button } = require('../utils/keyboard');
const { renderPanel, esc, paginate, pagerRow } = require('./common');
const { truncate } = require('../utils/html');
const { STATUS } = require('../services/userSender');
const { formatDateTime, formatInterval } = require('../utils/time');
const policy = require('../services/policy');

const IMPORT_PAGE_SIZE = 8;
const SESSION_TYPE = 'sndr_import';

const STATUS_LABEL = {
  [STATUS.CONNECTED]: '🟢 Connected',
  [STATUS.CONNECTING]: '🟡 Connecting…',
  [STATUS.DISCONNECTED]: '⚪ Disconnected',
  [STATUS.UNAVAILABLE]: '🔴 Unavailable',
  [STATUS.NOT_CONFIGURED]: '⚙️ Not configured',
  [STATUS.DISABLED]: '⏸ Disabled',
};

/** Safe account description. Never includes phone, api hash or session. */
function describeAccount(status) {
  if (!status.account) return '—';
  const parts = [];
  if (status.account.firstName) parts.push(status.account.firstName);
  if (status.account.username) parts.push(`@${status.account.username}`);
  return parts.length ? parts.join(' ') : `id ${status.account.id}`;
}

async function showSenderPanel(ctx, { chatId, messageId, note = null }) {
  const status = ctx.userSender ? ctx.userSender.getStatus() : { status: STATUS.NOT_CONFIGURED, connected: false, reason: 'User sender not initialised', account: null };
  const joined = ctx.senderCache?.joinedGroups;
  const timezone = policy.getTimezone(ctx.q, ctx.config);
  const floodUntil = ctx.q.getFloodWaitUntil();

  const lines = [
    '⚙️ <b>Sender Account</b>',
    '',
    `👤 User sender: ${STATUS_LABEL[status.status] || status.status}`,
    `📱 Account: ${esc(describeAccount(status))}`,
    `👥 Joined groups: ${Number.isFinite(joined) ? joined : '—'}`,
    `📣 Registered advertising groups: ${ctx.q.countGroupsBySender('user')}`,
  ];

  if (ctx.q.countGroupsBySender('bot') > 0) {
    lines.push(`🤖 Legacy bot-delivered groups: ${ctx.q.countGroupsBySender('bot')}`);
  }
  if (!status.connected && status.reason) {
    lines.push('', `⚠️ ${esc(status.reason)}`);
  }
  if (floodUntil && new Date(floodUntil) > new Date()) {
    lines.push('', `⏳ Telegram rate limit: sending held until ${formatDateTime(floodUntil, timezone)}`);
  }
  if (!status.connected) {
    lines.push(
      '',
      'Generate a session locally with <code>npm run login:user</code>, then set',
      '<code>TELEGRAM_USER_SESSION</code> in Railway and redeploy.'
    );
  }
  if (note) lines.push('', note);

  const keyboard = [
    [button('🔄 Reconnect', cb('sndr', 'rc')), button('🔐 Check Session', cb('sndr', 'cs'))],
    [button('👥 Import My Groups', cb('sndr', 'imp', '0'))],
    [button('⬅️ Back', cb('home', 'open'))],
  ];

  return renderPanel(ctx, { chatId, messageId, text: lines.join('\n'), keyboard });
}

/** Fetches the account's own dialogs and caches them for the select flow. */
async function loadDialogs(ctx, userId, { force = false } = {}) {
  const existing = ctx.sessions.get(userId);
  if (!force && existing?.type === SESSION_TYPE && Array.isArray(existing.dialogs)) {
    return { ok: true, session: existing };
  }

  const result = await ctx.userSender.listGroups({ limit: 300 });
  if (!result.ok) {
    return { ok: false, reason: result.friendly || result.reason };
  }

  ctx.senderCache = { ...(ctx.senderCache || {}), joinedGroups: result.groups.length + result.hidden, fetchedAt: new Date().toISOString() };

  const session = ctx.sessions.set(userId, {
    type: SESSION_TYPE,
    dialogs: result.groups,
    hidden: result.hidden,
    selected: existing?.type === SESSION_TYPE ? existing.selected || [] : [],
  });
  return { ok: true, session };
}

async function showImportList(ctx, { chatId, messageId, userId, page = 0, force = false }) {
  if (!ctx.userSender || !ctx.userSender.isConnected()) {
    return showSenderPanel(ctx, { chatId, messageId, note: '⚠️ Connect the user account before importing groups.' });
  }

  const loaded = await loadDialogs(ctx, userId, { force });
  if (!loaded.ok) {
    return showSenderPanel(ctx, { chatId, messageId, note: `⚠️ Could not read the account's groups: ${esc(loaded.reason)}` });
  }

  const { dialogs, hidden, selected } = loaded.session;
  if (!dialogs.length) {
    return showSenderPanel(ctx, {
      chatId,
      messageId,
      note: '👥 The account is not a member of any eligible group yet. Join groups in the official Telegram app first, then import.',
    });
  }

  const registered = ctx.q.registeredChatIds();
  const chosen = new Set(selected);
  const pagination = paginate(dialogs, page, IMPORT_PAGE_SIZE);
  const offset = pagination.page * IMPORT_PAGE_SIZE;

  const keyboard = pagination.items.map((dialog, localIndex) => {
    const index = offset + localIndex;
    const already = registered.has(dialog.chatId);
    const mark = already ? '✅' : chosen.has(index) ? '☑️' : '☐';
    const suffix = already ? ' (registered)' : '';
    return [button(`${mark} ${truncate(dialog.title, 26)}${suffix}`, cb('sndr', 't', pagination.page, index))];
  });

  const pager = pagerRow(pagination, (p) => cb('sndr', 'imp', p));
  if (pager) keyboard.push(pager);
  keyboard.push([button(`✅ Add Selected (${chosen.size})`, cb('sndr', 'add')), button('☐ Clear', cb('sndr', 'clr'))]);
  keyboard.push([button('🔄 Refresh list', cb('sndr', 'ref')), button('⬅️ Back', cb('sndr', 'home'))]);

  const text = [
    '👥 <b>Import My Groups</b>',
    '',
    `Groups the sender account is already in: <b>${dialogs.length}</b>`,
    hidden ? `Hidden (left, or sending not permitted): ${hidden}` : null,
    '',
    'Tick the groups that may receive advertisements, then press Add Selected.',
    '',
    '<i>Only ticked groups are ever advertised in. Nothing is joined automatically.</i>',
  ]
    .filter(Boolean)
    .join('\n');

  return renderPanel(ctx, { chatId, messageId, text, keyboard });
}

/**
 * Adds the ticked groups to the allowlist, verifying each one first.
 * Returns a summary string for the admin.
 */
async function addSelectedGroups(ctx, userId) {
  const session = ctx.sessions.get(userId);
  if (!session || session.type !== SESSION_TYPE || !session.selected?.length) {
    return { ok: false, note: '⚠️ Nothing selected.' };
  }

  const timezone = policy.getTimezone(ctx.q, ctx.config);
  const interval = policy.getDefaultIntervalMinutes(ctx.q, ctx.config);
  const quiet = policy.resolveQuiet(ctx.q, null);

  const added = [];
  const skipped = [];

  for (const index of session.selected) {
    const dialog = session.dialogs[index];
    if (!dialog) continue;

    const candidate = {
      chat_id: dialog.chatId,
      title: dialog.title,
      type: dialog.type,
      username: dialog.username,
      peer_type: dialog.peerType,
      access_hash: dialog.accessHash,
      registered_by: userId,
      next_send_at: policy.computeNextSendAt(new Date(), interval, quiet, timezone).toISOString(),
    };

    // Confirm the account can still resolve and post to this peer.
    // eslint-disable-next-line no-await-in-loop
    const verified = await ctx.userSender.verifyPeer({
      chat_id: candidate.chat_id,
      peer_type: candidate.peer_type,
      access_hash: candidate.access_hash,
    });
    if (!verified.ok) {
      skipped.push(`${dialog.title} — ${verified.friendly}`);
      continue;
    }

    const { created } = ctx.q.registerUserGroup(candidate);
    ctx.q.recordAudit(userId, created ? 'group.import' : 'group.import_refresh', String(dialog.chatId), dialog.title);
    added.push(`${dialog.title}${created ? '' : ' (updated)'}`);
  }

  ctx.sessions.patch(userId, { selected: [] });

  const lines = [];
  if (added.length) lines.push(`✅ Added ${added.length} group${added.length === 1 ? '' : 's'}:`, ...added.map((t) => `• ${esc(t)}`));
  if (skipped.length) lines.push('', `⚠️ Skipped ${skipped.length}:`, ...skipped.map((t) => `• ${esc(t)}`));
  if (added.length) lines.push('', `⏱ Interval: ${formatInterval(interval)} (change per group under 👥 Groups)`);

  return { ok: true, note: lines.join('\n'), added: added.length, skipped: skipped.length };
}

module.exports = {
  showSenderPanel,
  showImportList,
  addSelectedGroups,
  loadDialogs,
  describeAccount,
  SESSION_TYPE,
  IMPORT_PAGE_SIZE,
  STATUS_LABEL,
};
