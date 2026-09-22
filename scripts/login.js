#!/usr/bin/env node
'use strict';

/**
 * ONE-TIME LOCAL LOGIN — run this on your own computer, never on a server.
 *
 *   npm run login:user
 *
 * It asks for your phone number, the login code Telegram sends you, and your
 * 2FA password if your account has one. It then prints the resulting session
 * string ONCE so you can paste it into Railway as TELEGRAM_USER_SESSION.
 *
 * Deliberately NOT implemented anywhere in this project:
 *   - logging in through the admin bot (you would be typing your code and 2FA
 *     password into a Telegram chat, where they are stored in message history)
 *   - saving the phone number, login code or 2FA password to disk or SQLite
 *   - writing the session anywhere automatically
 *
 * Nothing typed here is persisted by this script. The session it prints is a
 * full credential for your Telegram account: treat it like a password.
 */

const readline = require('readline');
const { Writable } = require('stream');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (!hidden) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(String(answer).trim());
      });
      return;
    }
    // Hidden input: echo nothing, so a code or password never appears on screen
    // or in a terminal scrollback that someone else might read.
    let muted = false;
    const mutedOut = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding);
        callback();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: mutedOut, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(String(answer).trim());
    });
    muted = true;
  });
}

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

async function main() {
  try {
    require('dotenv').config();
  } catch (_) {
    // dotenv is optional.
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  ACC STORE Advertiser — one-time Telegram user login');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Run this on your OWN COMPUTER, not on Railway.');
  console.log('  Use the dedicated advertising account, not your personal one.');
  console.log('');

  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID || '', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';

  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
    fail(
      'TELEGRAM_API_ID and TELEGRAM_API_HASH must be set first.\n\n'
      + '   1. Sign in at https://my.telegram.org with the advertising account\n'
      + '   2. Open "API development tools" and create an application\n'
      + '   3. Put the values in your local .env:\n\n'
      + '      TELEGRAM_API_ID=1234567\n'
      + '      TELEGRAM_API_HASH=your_api_hash_here\n'
    );
  }

  let TelegramClient;
  let StringSession;
  try {
    ({ TelegramClient } = require('teleproto'));
    ({ StringSession } = require('teleproto/sessions'));
  } catch (error) {
    fail(`Could not load the MTProto client. Run "npm install" first.\n   (${error.message})`);
  }

  // An empty StringSession means "log in from scratch".
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
    floodSleepThreshold: 0,
  });

  let session = null;
  try {
    await client.start({
      phoneNumber: () => ask('📱 Phone number (with country code, e.g. +9647XXXXXXXXX): '),
      phoneCode: () => ask('🔢 Login code Telegram just sent you: ', { hidden: true }),
      password: () => ask('🔐 Two-factor password (leave empty if you have none): ', { hidden: true }),
      onError: (error) => {
        console.error(`\n⚠️  ${error.message}`);
        // Returning false lets the client re-prompt instead of aborting.
        return false;
      },
    });

    const me = await client.getMe();
    session = String(client.session.save());

    console.log('');
    console.log('✅ Authorised as '
      + (me?.username ? `@${me.username}` : (me?.firstName || 'your account'))
      + ` (id ${me?.id})`);
    console.log('');
    console.log('──────────────────────────────────────────────────────────────');
    console.log('  TELEGRAM_USER_SESSION — copy the line below');
    console.log('──────────────────────────────────────────────────────────────');
    console.log('');
    console.log(session);
    console.log('');
    console.log('──────────────────────────────────────────────────────────────');
    console.log('');
    console.log('  ⚠️  This string is a FULL credential for that Telegram');
    console.log('      account. Anyone holding it can act as the account.');
    console.log('');
    console.log('  • Paste it into Railway as TELEGRAM_USER_SESSION');
    console.log('  • Do NOT commit it, paste it into chat, or screenshot it');
    console.log('  • Clear your terminal afterwards (e.g. `clear` / Cmd+K)');
    console.log('  • If it ever leaks: Telegram → Settings → Devices →');
    console.log('    terminate that session, then run this command again');
    console.log('');
  } catch (error) {
    fail(`Login failed: ${error.message}`);
  } finally {
    // Always drop the connection; the session is already printed.
    try {
      await client.disconnect();
      if (typeof client.destroy === 'function') await client.destroy();
    } catch (_) {
      // Nothing useful to do while exiting.
    }
  }

  // Exit explicitly: the MTProto client keeps handles that would otherwise
  // hold the process open after a successful login.
  process.exit(0);
}

main().catch((error) => {
  console.error(`\n❌ Unexpected error: ${error.message}\n`);
  process.exit(1);
});
