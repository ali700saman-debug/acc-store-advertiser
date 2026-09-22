'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { openDatabase, closeDatabase, integrityCheck, detectPersistence, MIGRATIONS } = require('../database/db');
const { createQueries } = require('../database/queries');
const { createShutdown } = require('../services/shutdown');
const { ensureDefaultCampaign } = require('../database/seed');
const { redact } = require('../utils/logger');
const configModule = require('../config');
const { makeTempDbPath, testConfig, GROUP_ID } = require('./helpers');

test('26. a freshly migrated database passes the integrity check', (t) => {
  const dbPath = makeTempDbPath('integrity');
  const { db } = openDatabase({ dbPath });
  t.after(() => { closeDatabase(db); fs.rmSync(dbPath, { force: true }); });

  assert.equal(integrityCheck(db).ok, true);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const expected of ['settings', 'campaigns', 'groups', 'group_campaigns', 'ad_deliveries', 'audit_log', 'migrations']) {
    assert.ok(tables.includes(expected), `${expected} table exists`);
  }
});

test('26b. integrity still holds after heavy write traffic', (t) => {
  const dbPath = makeTempDbPath('integrity2');
  const { db } = openDatabase({ dbPath });
  const q = createQueries(db);
  t.after(() => { closeDatabase(db); fs.rmSync(dbPath, { force: true }); });

  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech', type: 'supergroup' });
  for (let i = 0; i < 500; i += 1) {
    const claim = q.claimDelivery({ key: `load-${i}`, campaignId: null, chatId: GROUP_ID });
    q.markDeliverySent(claim.delivery.id, i);
  }

  assert.equal(integrityCheck(db).ok, true);
  assert.equal(q.deliveryStats({}).sentTotal, 500);
});

test('24b. reopening the database preserves every row (no boot-time wipe)', (t) => {
  const dbPath = makeTempDbPath('persist');
  t.after(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));

  const first = openDatabase({ dbPath });
  const q1 = createQueries(first.db);
  ensureDefaultCampaign(q1, testConfig());
  q1.registerGroup({ chat_id: GROUP_ID, title: 'Tech Group', type: 'supergroup' });
  q1.updateGroup(GROUP_ID, { interval_minutes: 720, next_send_at: '2026-10-01T00:00:00.000Z' });
  q1.setSetting('default_interval_minutes', '180');
  closeDatabase(first.db);

  const second = openDatabase({ dbPath });
  const q2 = createQueries(second.db);
  t.after(() => closeDatabase(second.db));

  assert.equal(second.existed, true, 'the existing file was reused, not recreated');
  assert.deepEqual(second.appliedMigrations, [], 'no migration re-ran on the second boot');
  assert.equal(q2.countGroups(), 1);
  assert.equal(q2.getGroup(GROUP_ID).interval_minutes, 720);
  assert.equal(q2.getGroup(GROUP_ID).next_send_at, '2026-10-01T00:00:00.000Z');
  assert.equal(q2.getSetting('default_interval_minutes'), '180');
  assert.equal(q2.countCampaigns(), 1);
});

test('24c. migrations are additive and tracked by id', (t) => {
  const dbPath = makeTempDbPath('migrations');
  const first = openDatabase({ dbPath });
  t.after(() => { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); });

  assert.deepEqual(first.appliedMigrations, MIGRATIONS.map((m) => m.id));
  const applied = first.db.prepare('SELECT id FROM migrations').all().map((r) => r.id);
  assert.deepEqual(applied, MIGRATIONS.map((m) => m.id));
  closeDatabase(first.db);

  const second = openDatabase({ dbPath });
  assert.deepEqual(second.appliedMigrations, [], 'already-applied migrations are skipped');
  closeDatabase(second.db);
});

test('4b. persistent storage detection distinguishes a volume from the app directory', () => {
  assert.equal(detectPersistence(path.join(process.cwd(), 'data', 'advertiser.db')), false);
  assert.equal(detectPersistence(makeTempDbPath('volume')), true, 'a directory outside the app counts as persistent');
});

test('25c. SIGTERM closes the database cleanly and leaves state intact', (t) => {
  const dbPath = makeTempDbPath('sigterm');
  t.after(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));

  // Run the real shutdown path in a child process and actually signal it.
  const script = `
    const { openDatabase } = require(${JSON.stringify(path.join(__dirname, '..', 'database', 'db'))});
    const { createQueries } = require(${JSON.stringify(path.join(__dirname, '..', 'database', 'queries'))});
    const { createShutdown, install } = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'shutdown'))});
    const dbInfo = openDatabase({ dbPath: ${JSON.stringify(dbPath)} });
    const q = createQueries(dbInfo.db);
    q.registerGroup({ chat_id: ${GROUP_ID}, title: 'Tech', type: 'supergroup' });
    const claim = q.claimDelivery({ key: 'before-sigterm', campaignId: null, chatId: ${GROUP_ID} });
    q.markDeliverySent(claim.delivery.id, 55);
    const scheduler = { stopped: false, stop() { this.stopped = true; } };
    const bot = { stopPolling: async () => {} };
    install(createShutdown({ scheduler, bot, dbInfo }));
    setInterval(() => {}, 1000);
    process.send ? process.send('ready') : console.log('ready');
  `;
  const scriptPath = path.join(path.dirname(dbPath), 'sigterm-child.js');
  fs.writeFileSync(scriptPath, script);

  const { spawnSync } = require('child_process');
  const wrapper = `
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [${JSON.stringify(scriptPath)}], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => {
      if (String(d).includes('ready')) child.kill('SIGTERM');
    });
    child.on('exit', (code) => { console.log('EXIT_CODE=' + code); process.exit(0); });
  `;
  const wrapperPath = path.join(path.dirname(dbPath), 'sigterm-wrapper.js');
  fs.writeFileSync(wrapperPath, wrapper);

  const result = spawnSync(process.execPath, [wrapperPath], { encoding: 'utf8', timeout: 15000 });
  assert.match(result.stdout, /EXIT_CODE=0/, `clean exit expected, got: ${result.stdout} ${result.stderr}`);

  // The database must be reusable and complete after the signal.
  const reopened = openDatabase({ dbPath });
  const q = createQueries(reopened.db);
  assert.equal(integrityCheck(reopened.db).ok, true, 'no corruption after SIGTERM');
  assert.equal(q.countGroups(), 1);
  assert.equal(q.deliveryStats({}).sentTotal, 1, 'the write made before the signal survived');
  closeDatabase(reopened.db);
});

test('25d. shutdown stops the scheduler before closing the database', async (t) => {
  const dbPath = makeTempDbPath('shutdown-order');
  const dbInfo = openDatabase({ dbPath });
  t.after(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));

  const order = [];
  const scheduler = { stop: () => order.push('scheduler') };
  const bot = { stopPolling: async () => order.push('polling') };
  let exitCode = null;

  const shutdown = createShutdown({ scheduler, bot, dbInfo, exit: (code) => { exitCode = code; } });
  await shutdown('SIGTERM');
  order.push('db-closed');

  assert.deepEqual(order, ['scheduler', 'polling', 'db-closed']);
  assert.equal(exitCode, 0);
  assert.equal(dbInfo.db.open, false, 'the connection is actually closed');

  // Repeated signals are ignored rather than double-closing.
  assert.equal(await shutdown('SIGTERM'), false);
});

test('3b. secrets never reach the logs or the database', (t) => {
  const dbPath = makeTempDbPath('secrets');
  const { db } = openDatabase({ dbPath });
  const q = createQueries(db);
  t.after(() => { closeDatabase(db); fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); });

  // Assembled at runtime so no token-shaped literal ever sits in the source.
  const token = ['7123456789', 'AAHnot-a-real-token-used-only-by-this-test'].join(':');
  assert.equal(redact(`starting with ${token}`), 'starting with [REDACTED]');
  assert.equal(redact(new Error(`bad token ${token}`)), 'bad token [REDACTED]');

  ensureDefaultCampaign(q, testConfig());
  q.registerGroup({ chat_id: GROUP_ID, title: 'Tech', type: 'supergroup' });
  q.recordAudit(1, 'settings.pause', null, 'paused');

  // Dump every text value in the database and make sure no token shape exists.
  const dump = execFileSync(process.execPath, ['-e', `
    const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
    const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    let out = '';
    for (const t of tables) out += JSON.stringify(db.prepare('SELECT * FROM ' + t.name).all());
    console.log(out);
  `], { encoding: 'utf8' });

  const tokenShape = /\d{6,12}:[A-Za-z0-9_-]{30,}/;
  assert.equal(tokenShape.test(`stored ${token} here`), true, 'sanity: the detector recognises a token');
  assert.equal(tokenShape.test(dump), false, 'no bot-token-shaped value stored');
  assert.equal(dump.includes('BOT_TOKEN'), false);
});

test('2d. configuration refuses to boot without a token or admin ids', () => {
  assert.deepEqual(configModule.validate(configModule.build({ ADMIN_IDS: '1' })), ['BOT_TOKEN is missing.']);
  assert.deepEqual(
    configModule.validate(configModule.build({ BOT_TOKEN: 'x' })),
    ['ADMIN_IDS is missing or contains no valid numeric IDs.']
  );
  assert.deepEqual(configModule.validate(testConfig()), []);
});

test('2e. ADMIN_IDS parsing ignores usernames and junk', () => {
  assert.deepEqual(configModule.parseAdminIds('111, 222 333'), [111, 222, 333]);
  assert.deepEqual(configModule.parseAdminIds('@someuser,abc,-5,0'), []);
  assert.deepEqual(configModule.parseAdminIds(''), []);
  assert.deepEqual(configModule.parseAdminIds(undefined), []);
});
