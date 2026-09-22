'use strict';

/**
 * All SQL lives here. Every function is a plain method on an object built
 * around one better-sqlite3 connection, which keeps handlers and services
 * free of SQL and makes them trivial to test against a temporary database.
 */

const SETTING_DEFAULTS = {
  paused: '0',
  default_interval_minutes: null, // falls back to config
  timezone: null,
  main_store_bot_url: null,
  default_campaign_id: null,
  quiet_enabled: '0',
  quiet_start: '00:00',
  quiet_end: '08:00',
  // ISO timestamp until which ALL user-account sending is held because
  // Telegram returned an account-level FLOOD_WAIT.
  flood_wait_until: null,
};

const GROUP_UPDATABLE = new Set([
  'title', 'type', 'username', 'enabled', 'interval_minutes', 'campaign_id',
  'rotation_enabled', 'last_campaign_id', 'last_send_at', 'next_send_at',
  'last_message_id', 'delete_previous', 'quiet_enabled', 'quiet_start',
  'quiet_end', 'can_send', 'delivery_problem', 'last_error', 'last_error_at',
  'sender_kind', 'peer_type', 'access_hash', 'peer_checked_at',
]);

const CAMPAIGN_UPDATABLE = new Set([
  'name', 'text', 'media_type', 'media_file_id', 'button_text', 'button_url',
  'parse_mode', 'language', 'enabled', 'media_local_path',
]);

function nowIso() {
  return new Date().toISOString();
}

function buildUpdate(table, keyColumn, allowed, fields) {
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!entries.length) return null;
  const assignments = entries.map(([key]) => `${key} = @${key}`);
  const params = Object.fromEntries(entries);
  return { sql: `UPDATE ${table} SET ${assignments.join(', ')} WHERE ${keyColumn} = @__key`, params };
}

function createQueries(db) {
  const api = {};

  // ---------------------------------------------------------------- settings
  const selectSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @updated_at)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  api.getSetting = (key, fallback = undefined) => {
    const row = selectSetting.get(key);
    if (row && row.value !== null && row.value !== undefined) return row.value;
    if (fallback !== undefined) return fallback;
    return SETTING_DEFAULTS[key] ?? null;
  };

  api.setSetting = (key, value) => {
    upsertSetting.run({ key, value: value === null || value === undefined ? null : String(value), updated_at: nowIso() });
    return api.getSetting(key);
  };

  api.getAllSettings = () => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const out = { ...SETTING_DEFAULTS };
    for (const row of rows) out[row.key] = row.value;
    return out;
  };

  api.isPaused = () => api.getSetting('paused', '0') === '1';
  api.setPaused = (paused) => api.setSetting('paused', paused ? '1' : '0');

  // --------------------------------------------------------------- campaigns
  const insertCampaign = db.prepare(`
    INSERT INTO campaigns (name, text, media_type, media_file_id, button_text, button_url, parse_mode, language, enabled, created_at, updated_at)
    VALUES (@name, @text, @media_type, @media_file_id, @button_text, @button_url, @parse_mode, @language, @enabled, @created_at, @updated_at)
  `);

  api.createCampaign = (data = {}) => {
    const ts = nowIso();
    const info = insertCampaign.run({
      name: data.name || 'Untitled campaign',
      text: data.text || '',
      media_type: data.media_type || null,
      media_file_id: data.media_file_id || null,
      button_text: data.button_text || null,
      button_url: data.button_url || null,
      parse_mode: data.parse_mode || 'HTML',
      language: data.language || 'mixed',
      enabled: data.enabled === 0 || data.enabled === false ? 0 : 1,
      created_at: ts,
      updated_at: ts,
    });
    return api.getCampaign(info.lastInsertRowid);
  };

  api.getCampaign = (id) => db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(id)) || null;
  api.listCampaigns = () => db.prepare('SELECT * FROM campaigns ORDER BY id ASC').all();
  api.listEnabledCampaigns = () => db.prepare('SELECT * FROM campaigns WHERE enabled = 1 ORDER BY id ASC').all();
  api.countCampaigns = () => db.prepare('SELECT COUNT(*) AS n FROM campaigns').get().n;
  api.countEnabledCampaigns = () => db.prepare('SELECT COUNT(*) AS n FROM campaigns WHERE enabled = 1').get().n;
  api.findCampaignByName = (name) => db.prepare('SELECT * FROM campaigns WHERE name = ?').get(String(name)) || null;

  api.updateCampaign = (id, fields = {}) => {
    const update = buildUpdate('campaigns', 'id', CAMPAIGN_UPDATABLE, { ...fields, updated_at: nowIso() });
    if (!update) return api.getCampaign(id);
    // updated_at is not in the allow-list on purpose; append it explicitly.
    const sql = update.sql.replace(' WHERE id = @__key', ', updated_at = @__updated_at WHERE id = @__key');
    db.prepare(sql).run({ ...update.params, __key: Number(id), __updated_at: nowIso() });
    return api.getCampaign(id);
  };

  api.deleteCampaign = (id) => {
    const campaignId = Number(id);
    return db.transaction(() => {
      db.prepare('DELETE FROM group_campaigns WHERE campaign_id = ?').run(campaignId);
      db.prepare('UPDATE groups SET campaign_id = NULL WHERE campaign_id = ?').run(campaignId);
      db.prepare('UPDATE groups SET last_campaign_id = NULL WHERE last_campaign_id = ?').run(campaignId);
      const info = db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
      if (api.getSetting('default_campaign_id') === String(campaignId)) api.setSetting('default_campaign_id', null);
      return info.changes > 0;
    })();
  };

  // ------------------------------------------------------------------ groups
  const insertGroup = db.prepare(`
    INSERT INTO groups (chat_id, title, type, username, registered_at, registered_by, enabled, next_send_at)
    VALUES (@chat_id, @title, @type, @username, @registered_at, @registered_by, 1, @next_send_at)
  `);

  api.getGroup = (chatId) => db.prepare('SELECT * FROM groups WHERE chat_id = ?').get(Number(chatId)) || null;
  api.listGroups = () => db.prepare('SELECT * FROM groups ORDER BY title COLLATE NOCASE ASC, chat_id ASC').all();
  api.listEnabledGroups = () => db.prepare('SELECT * FROM groups WHERE enabled = 1 ORDER BY title COLLATE NOCASE ASC').all();
  api.countGroups = () => db.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
  api.countEnabledGroups = () => db.prepare('SELECT COUNT(*) AS n FROM groups WHERE enabled = 1').get().n;
  api.countProblemGroups = () => db.prepare('SELECT COUNT(*) AS n FROM groups WHERE delivery_problem = 1').get().n;

  /** Returns { created, group }. Never registers the same chat twice. */
  api.registerGroup = (data) => {
    const chatId = Number(data.chat_id);
    const existing = api.getGroup(chatId);
    if (existing) return { created: false, group: existing };
    insertGroup.run({
      chat_id: chatId,
      title: data.title || '',
      type: data.type || 'group',
      username: data.username || null,
      registered_at: nowIso(),
      registered_by: data.registered_by ? Number(data.registered_by) : null,
      next_send_at: data.next_send_at || nowIso(),
    });
    return { created: true, group: api.getGroup(chatId) };
  };

  /**
   * Registers a group the MTProto USER ACCOUNT is already a member of.
   * `access_hash` is stored as text (64-bit value, unsafe as a JS number).
   */
  api.registerUserGroup = (data) => {
    const chatId = Number(data.chat_id);
    const existing = api.getGroup(chatId);
    if (existing) {
      // Re-importing an existing group refreshes its peer data only.
      api.updateGroup(chatId, {
        title: data.title || existing.title,
        username: data.username ?? existing.username,
        sender_kind: 'user',
        peer_type: data.peer_type || existing.peer_type,
        access_hash: data.access_hash === undefined || data.access_hash === null ? existing.access_hash : String(data.access_hash),
        peer_checked_at: nowIso(),
      });
      return { created: false, group: api.getGroup(chatId) };
    }
    insertGroup.run({
      chat_id: chatId,
      title: data.title || '',
      type: data.type || 'supergroup',
      username: data.username || null,
      registered_at: nowIso(),
      registered_by: data.registered_by ? Number(data.registered_by) : null,
      next_send_at: data.next_send_at || nowIso(),
    });
    api.updateGroup(chatId, {
      sender_kind: 'user',
      peer_type: data.peer_type || null,
      access_hash: data.access_hash === undefined || data.access_hash === null ? null : String(data.access_hash),
      peer_checked_at: nowIso(),
    });
    return { created: true, group: api.getGroup(chatId) };
  };

  api.listGroupsBySender = (senderKind) =>
    db.prepare('SELECT * FROM groups WHERE sender_kind = ? ORDER BY title COLLATE NOCASE ASC').all(String(senderKind));

  api.countGroupsBySender = (senderKind) =>
    db.prepare('SELECT COUNT(*) AS n FROM groups WHERE sender_kind = ?').get(String(senderKind)).n;

  /** Chat ids already on the allowlist — used to mark the import list. */
  api.registeredChatIds = () => new Set(db.prepare('SELECT chat_id FROM groups').all().map((r) => r.chat_id));

  // ------------------------------------------------- account-level flood gate
  /**
   * Telegram FLOOD_WAIT applies to the whole account, so it gates every
   * user-account send rather than a single group.
   */
  api.getFloodWaitUntil = () => api.getSetting('flood_wait_until');

  api.setFloodWaitUntil = (isoOrNull) => api.setSetting('flood_wait_until', isoOrNull);

  api.isFloodGated = (now = new Date()) => {
    const until = api.getFloodWaitUntil();
    if (!until) return false;
    return new Date(until).getTime() > now.getTime();
  };

  api.updateGroup = (chatId, fields = {}) => {
    const update = buildUpdate('groups', 'chat_id', GROUP_UPDATABLE, fields);
    if (!update) return api.getGroup(chatId);
    db.prepare(update.sql).run({ ...update.params, __key: Number(chatId) });
    return api.getGroup(chatId);
  };

  api.removeGroup = (chatId) => {
    const id = Number(chatId);
    return db.transaction(() => {
      db.prepare('DELETE FROM group_campaigns WHERE chat_id = ?').run(id);
      return db.prepare('DELETE FROM groups WHERE chat_id = ?').run(id).changes > 0;
    })();
  };

  /** Telegram group -> supergroup upgrades change the chat id. */
  api.migrateChatId = (oldChatId, newChatId) =>
    db.transaction(() => {
      const target = api.getGroup(newChatId);
      if (target) {
        api.removeGroup(oldChatId);
        return target;
      }
      db.prepare('UPDATE groups SET chat_id = ?, type = ? WHERE chat_id = ?').run(Number(newChatId), 'supergroup', Number(oldChatId));
      db.prepare('UPDATE group_campaigns SET chat_id = ? WHERE chat_id = ?').run(Number(newChatId), Number(oldChatId));
      return api.getGroup(newChatId);
    })();

  /**
   * Groups whose scheduled slot has arrived. Only enabled, registered groups
   * are ever returned — this is the single source of automated recipients.
   */
  api.dueGroups = (nowIsoString, limit = 50) =>
    db
      .prepare(
        `SELECT * FROM groups
         WHERE enabled = 1 AND next_send_at IS NOT NULL AND next_send_at <= ?
         ORDER BY next_send_at ASC LIMIT ?`
      )
      .all(String(nowIsoString), Number(limit));

  api.recordGroupError = (chatId, { message, problem = true } = {}) =>
    api.updateGroup(chatId, {
      last_error: message ? String(message).slice(0, 400) : null,
      last_error_at: nowIso(),
      delivery_problem: problem ? 1 : 0,
      can_send: problem ? 0 : 1,
    });

  api.clearGroupError = (chatId) =>
    api.updateGroup(chatId, { last_error: null, last_error_at: null, delivery_problem: 0, can_send: 1 });

  // ------------------------------------------------------- campaign rotation
  api.getGroupCampaignIds = (chatId) =>
    db
      .prepare('SELECT campaign_id FROM group_campaigns WHERE chat_id = ? ORDER BY position ASC, campaign_id ASC')
      .all(Number(chatId))
      .map((row) => row.campaign_id);

  api.setGroupCampaigns = (chatId, campaignIds = []) =>
    db.transaction(() => {
      db.prepare('DELETE FROM group_campaigns WHERE chat_id = ?').run(Number(chatId));
      const insert = db.prepare('INSERT INTO group_campaigns (chat_id, campaign_id, position) VALUES (?, ?, ?)');
      campaignIds.forEach((campaignId, index) => insert.run(Number(chatId), Number(campaignId), index));
      return api.getGroupCampaignIds(chatId);
    })();

  api.toggleGroupCampaign = (chatId, campaignId) => {
    const current = api.getGroupCampaignIds(chatId);
    const id = Number(campaignId);
    const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
    return api.setGroupCampaigns(chatId, next);
  };

  // -------------------------------------------------------------- deliveries
  const insertDelivery = db.prepare(`
    INSERT INTO ad_deliveries (idempotency_key, campaign_id, chat_id, scheduled_for, status, trigger_type, created_at)
    VALUES (@idempotency_key, @campaign_id, @chat_id, @scheduled_for, 'pending', @trigger_type, @created_at)
    ON CONFLICT(idempotency_key) DO NOTHING
  `);

  /**
   * Reserves a delivery slot. Returns { claimed:false } when this exact
   * scheduled advertisement was already claimed — the guarantee that a
   * restart, duplicate tick or retry can never send the same ad twice.
   */
  api.claimDelivery = ({ key, campaignId, chatId, scheduledFor = null, trigger = 'scheduled' }) => {
    const info = insertDelivery.run({
      idempotency_key: String(key),
      campaign_id: campaignId === null || campaignId === undefined ? null : Number(campaignId),
      chat_id: Number(chatId),
      scheduled_for: scheduledFor,
      trigger_type: trigger,
      created_at: nowIso(),
    });
    if (info.changes === 0) {
      return { claimed: false, delivery: api.getDeliveryByKey(key) };
    }
    return { claimed: true, delivery: api.getDelivery(info.lastInsertRowid) };
  };

  api.getDelivery = (id) => db.prepare('SELECT * FROM ad_deliveries WHERE id = ?').get(Number(id)) || null;
  api.getDeliveryByKey = (key) => db.prepare('SELECT * FROM ad_deliveries WHERE idempotency_key = ?').get(String(key)) || null;

  /**
   * Releases a claimed slot that was never actually sent, so a deferred
   * advertisement can be retried instead of being lost. Only ever removes a
   * row that is still 'pending' — a 'sent' row stays as the duplicate guard.
   */
  api.releaseDelivery = (id) =>
    db.prepare("DELETE FROM ad_deliveries WHERE id = ? AND status = 'pending'").run(Number(id)).changes > 0;

  api.markDeliverySent = (id, messageId) =>
    db
      .prepare("UPDATE ad_deliveries SET status = 'sent', sent_at = ?, telegram_message_id = ?, error_code = NULL, error_message = NULL WHERE id = ?")
      .run(nowIso(), messageId === undefined || messageId === null ? null : Number(messageId), Number(id));

  api.markDeliveryFailed = (id, { code, message } = {}) =>
    db
      .prepare("UPDATE ad_deliveries SET status = 'failed', error_code = ?, error_message = ? WHERE id = ?")
      .run(code ? String(code) : null, message ? String(message).slice(0, 400) : null, Number(id));

  api.recentDeliveries = (limit = 10) =>
    db
      .prepare(
        `SELECT d.*, g.title AS group_title, c.name AS campaign_name
         FROM ad_deliveries d
         LEFT JOIN groups g ON g.chat_id = d.chat_id
         LEFT JOIN campaigns c ON c.id = d.campaign_id
         WHERE d.status != 'pending'
         ORDER BY d.id DESC LIMIT ?`
      )
      .all(Number(limit));

  api.deliveryStats = ({ todayStart, weekStart } = {}) => {
    const count = (sql, ...params) => db.prepare(sql).get(...params).n;
    return {
      sentToday: todayStart ? count("SELECT COUNT(*) AS n FROM ad_deliveries WHERE status='sent' AND sent_at >= ?", todayStart) : 0,
      sentWeek: weekStart ? count("SELECT COUNT(*) AS n FROM ad_deliveries WHERE status='sent' AND sent_at >= ?", weekStart) : 0,
      sentTotal: count("SELECT COUNT(*) AS n FROM ad_deliveries WHERE status='sent'"),
      failedTotal: count("SELECT COUNT(*) AS n FROM ad_deliveries WHERE status='failed'"),
      failedWeek: weekStart ? count("SELECT COUNT(*) AS n FROM ad_deliveries WHERE status='failed' AND created_at >= ?", weekStart) : 0,
    };
  };

  /** Housekeeping so the delivery table cannot grow without bound. */
  api.pruneDeliveries = (beforeIso, keepMinimum = 500) => {
    const total = db.prepare('SELECT COUNT(*) AS n FROM ad_deliveries').get().n;
    if (total <= keepMinimum) return 0;
    return db.prepare('DELETE FROM ad_deliveries WHERE created_at < ? AND id NOT IN (SELECT id FROM ad_deliveries ORDER BY id DESC LIMIT ?)')
      .run(String(beforeIso), Number(keepMinimum)).changes;
  };

  // --------------------------------------------------------------- audit log
  api.recordAudit = (adminId, action, target = null, details = null) =>
    db
      .prepare('INSERT INTO audit_log (admin_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(adminId ? Number(adminId) : null, String(action), target === null ? null : String(target), details === null ? null : String(details).slice(0, 400), nowIso());

  api.listAudit = (limit = 15) =>
    db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Number(limit));

  return api;
}

module.exports = { createQueries, SETTING_DEFAULTS };
