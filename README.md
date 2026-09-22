# ACC STORE Advertiser

A private, admin-controlled Telegram advertising manager for your main ACC
STORE bot.

Two Telegram identities, with clearly split jobs:

| | Identity | Job |
|---|---|---|
| 🤖 | **Admin bot** (`BOT_TOKEN`) | Your private control panel: dashboard, campaigns, groups, schedules, statistics, Send Now, settings. It does **not** need to be in any advertising group. |
| 👤 | **User account** (MTProto) | Posts the actual advertisements into groups the account has already joined. Nothing else. |

This is a standalone project. It does not read, write or depend on the main ACC
STORE bot in any way — it only links to it.

---

## ⚠️ Read this before using the user account

Automating a normal Telegram account to post advertisements is the pattern
Telegram most often **limits or bans accounts for**, and bulk messaging is
restricted under Telegram's API terms. This project is built to stay on the
conservative side of that line:

- it only posts to groups **you joined by hand**, in the official app;
- it only posts to groups **you explicitly ticked** in the admin panel;
- the minimum automatic interval is **60 minutes per group**;
- every send is serialised with a **20 second gap** by default;
- when Telegram says `FLOOD_WAIT` or `SLOWMODE_WAIT`, the wait is **obeyed
  exactly** — there is no bypass anywhere in the code.

Even so, **use a dedicated account you can afford to lose**, never your
personal one. If the account gets limited you will see `PEER_FLOOD` in the
admin panel; that is Telegram's anti-spam signal, and the right response is to
slow down or stop, not to push harder.

---

## Safety model

Advertisements go **only** to groups on the allowlist in SQLite. Being a member
of a group is never enough on its own. A group joins the allowlist through one
of exactly two paths:

**Preferred — user account**
1. You join the group yourself, in the official Telegram app, with the
   advertising account.
2. An admin opens ⚙️ Sender Account → 👥 Import My Groups.
3. The admin ticks that group and presses Add Selected.

**Legacy — bot delivery** (still supported, unchanged)
1. You add the admin bot to the group and let it send messages.
2. An admin sends `/register_group` inside that group.

The software never discovers groups, never joins anything, never resolves an
invite link, never scrapes, and never messages a chat that is not on the
allowlist. There is no join/import-invite call anywhere in the sending code —
a test asserts those API names are absent from the source, not merely unused.

Admin authentication is by numeric Telegram user ID only — usernames are
ignored, since they can be changed.

---

## Requirements

- Node.js 18 or newer (Railway runs this on Node 22)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A dedicated Telegram account for advertising, plus its `api_id` / `api_hash`
  from [my.telegram.org](https://my.telegram.org)
- A persistent volume (on Railway) for the SQLite database and cached media

---

## Quick start (local)

```bash
npm install
cp .env.example .env      # then edit .env
# for local runs set DB_PATH=./data/advertiser.db
npm run login:user        # once, to generate TELEGRAM_USER_SESSION
npm start
```

Run the test suite:

```bash
npm test
```

---

## 1. Create the bot with BotFather

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`.
3. Choose a display name, e.g. `ACC STORE Advertiser`.
4. Choose a username ending in `bot`, e.g. `AccStoreAdvertiserBot`.
5. Copy the token BotFather gives you — this is `BOT_TOKEN`.

Recommended BotFather settings for this bot:

- `/setprivacy` → select the bot → **Enable** (privacy mode on). The bot only
  needs to read commands, not every group message.
- `/setjoingroups` → **Enable**, so you can add it to groups.
- `/setcommands` → paste:

```
start - Open the admin panel
status - Show bot status
help - Show available commands
register_group - Register this group for advertising
unregister_group - Stop advertising in this group
groupid - Show this chat's id
```

Keep the token secret. It is never logged, never written to the database, and
never hardcoded.

## 1b. Generate the user session (once, locally)

The advertisements are sent by a normal Telegram account, which needs a
*session string*. You generate it **once, on your own computer**:

```bash
npm run login:user
```

It asks, interactively in your terminal:

1. 📱 phone number (with country code)
2. 🔢 the login code Telegram sends you
3. 🔐 your two-factor password, only if the account has one

The code and the password are typed with the echo turned off, are used only to
complete the login, and are **never stored** — not on disk, not in SQLite, not
in a log. On success the script prints the session string once:

```
──────────────────────────────────────────────────────────────
  TELEGRAM_USER_SESSION — copy the line below
──────────────────────────────────────────────────────────────

1AaBbCc...
```

Paste that into Railway as `TELEGRAM_USER_SESSION`, then clear your terminal.

**Prerequisite:** set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in your local
`.env` first. Get them from <https://my.telegram.org> → *API development
tools*, signed in as the advertising account.

### Why there is no login-by-chat

There is deliberately **no** way to log in through the admin bot. Sending your
login code or 2FA password to a Telegram chat would put both in message
history, on Telegram's servers, and in this project's database. Authentication
is CLI-only, on your own machine.

### If the session leaks or stops working

Telegram → **Settings → Devices** → terminate that session, then run
`npm run login:user` again and replace the Railway variable.

## 2. Set ADMIN_IDS

1. Open [@userinfobot](https://t.me/userinfobot) and send it any message.
2. It replies with your numeric ID, e.g. `123456789`.
3. Set the variable, comma separated for multiple admins:

```
ADMIN_IDS=123456789,987654321
```

Anyone not in this list gets a single neutral reply
(`This bot is for ACC STORE administration.`) and no access to any control.

## 3. Register groups

### Preferred: Import My Groups

1. In the **official Telegram app**, signed in as the advertising account,
   join the groups where advertising is permitted.
2. In the admin panel: **⚙️ Sender Account → 👥 Import My Groups**.
3. Tick the groups and press **✅ Add Selected**.

**Newly imported groups are registered DISABLED.** Importing never starts a
broadcast. Open 👥 Groups, check each one, then press ✅ Enable when you are
ready. Re-importing never changes a group you already enabled.

```
👥 Import My Groups

Groups the sender account is already in: 37
Hidden (left, or sending not permitted): 4

☑️ Digital Market Iraq
☐ Software Marketplace
✅ Subscriptions Group (registered)

[✅ Add Selected (1)]  [☐ Clear]
[🔄 Refresh list]      [⬅️ Back]
```

The list is read from the account's own dialog list — nothing is joined,
searched for or discovered. Chats the account has left, or where sending is
clearly forbidden, are filtered out and only counted.

Before a group is added, the account must **resolve the peer** and still be a
member with sending allowed; anything that fails verification is skipped and
reported, not registered. The group's MTProto peer identity (`peer_type` and
the 64-bit `access_hash`) is stored so the peer keeps resolving after a
restart, when the in-memory entity cache is empty.

### Legacy: bot delivery

Still supported for groups the *bot* posts to: add the bot, let it send
messages, then send `/register_group` there. Those groups keep `sender_kind =
'bot'` and keep their real inline buttons.

To stop advertising in a group, use **Groups → Remove Group** (or
`/unregister_group` for a bot-registered one).

### Blocked groups

If Telegram permanently refuses a group — `WRITE_FORBIDDEN` (the account may
not post there) or `BANNED_IN_CHAT` (the account is banned) — the group is
**blocked**: automatic sending is switched off for it, so the scheduler does
not retry it on every tick. Nothing is deleted; its campaign, interval,
settings and delivery history are all kept.

The group panel shows the reason. Fix the permission in Telegram, press
**🔐 Re-check Permission**, and if it succeeds the block clears — then press
**✅ Enable** to resume. A re-check never re-enables a group on its own.

A rate limit (`FLOOD_WAIT` / `SLOWMODE_WAIT`) is *not* a block: those groups
stay enabled and simply wait.

## 4. Create your first campaign

Open a private chat with the bot and send `/start`, then:

**📣 Campaigns → ➕ Create Campaign** → send a name.

From the campaign screen you can change everything without touching code:

| Button | What it does |
|---|---|
| 📝 Edit Text | Send new text (HTML supported), preview it, then Save |
| 🖼 Change Media | Send a photo, video or GIF — the Telegram `file_id` is stored and reused |
| 🔘 Change Button | Set the button label and URL, or apply the main store URL |
| 👁 Preview | Renders the ad exactly as groups will see it |
| ✅ Enable | Only enabled campaigns are ever sent |
| 🌐 Language | A label (`en`, `ar`, `vi`, `es`, `ckb`, `mixed`) — your text is never auto-translated |
| ☆ Make default | Groups without their own campaign use the default |

A default **ACC STORE Main Ad** campaign is created automatically on first boot,
using `MAIN_STORE_BOT_URL` for its button.

Every edit goes through **preview → ✅ Save / ❌ Cancel**, so nothing changes
until you confirm. Invalid HTML and invalid URLs are rejected before they can
break a live send.

## 5. Change the advertising interval

- **Per group**: **Groups → (group) → ⏱ Change Interval** — presets of 1, 2, 3,
  6, 12, 24 and 48 hours, plus a custom value (`90`, `4h`, `2d`).
- **Globally**: **⚙️ Settings → ⏱ Default Interval**. Groups without their own
  interval follow it.

The minimum is enforced at **60 minutes** (`MIN_INTERVAL_MINUTES`). Anything
lower is clamped — the bot cannot be configured to post every few seconds.
Changes take effect immediately, with no redeploy.

## 6. Send Now

**🚀 Send Now** → pick a campaign → pick a target:

1. **Send to one group** — goes out immediately.
2. **Send to selected groups** — tick groups, then confirm.
3. **Send to all enabled groups** — always shows a confirmation first:

```
⚠️ Send this campaign to 12 groups?
```

Sends are spaced by `SEND_DELAY_MS`, and you get a per-group result summary.
If advertising is paused, the confirmation says so and the button reads
**✅ Confirm (bypass pause)** — a manual send is an explicit override.

## 6b. How an advertisement is actually sent

```
Admin bot (panel)
      ↓
campaigns · scheduler · allowlist · delivery ledger   (SQLite)
      ↓
global send queue        ← one message at a time, 20s apart
      ↓
MTProto user account
      ↓
the groups you ticked
```

Routing is **per group**, from its `sender_kind` column:

- `user` → rendered for a user account, queued, sent over MTProto
- `bot` → rendered with a real inline button, sent by the bot (unchanged)

### Inline buttons: the one real difference

A **bot** may attach an inline keyboard to a message. A **normal user account
may not** — in MTProto, `reply_markup` is only honoured for bot accounts. There
is no legitimate way to fake a bot-style button from a user account, so this
project does not try.

Instead, for user-account sends the campaign link is appended to the message
body as visible, auto-linked text:

```
🛍 ACC STORE
Premium digital subscriptions and services available now.

🛒 Open ACC STORE:
https://t.me/YourStoreBot
```

The button label becomes the link label, so you still control the wording. If
the text would exceed Telegram's limit, the **body** is trimmed and the link is
always kept.

👁 **Preview** renders through this exact same code path, so what you see is
what the group gets. The preview header says which identity it is imitating
(`👤 as the USER ACCOUNT` / `🤖 as the BOT`) and offers a button to switch.

### Media

A Bot API `file_id` cannot be used over MTProto. So the first time a campaign
with media is sent by the user account, the file is downloaded once from the
Bot API to the persistent volume (next to the database) and uploaded from
there. The `file_id` is still kept and reused for bot sends and previews.

For a batch, the file is uploaded **once** and reused across every group in
that batch. If the file cannot be cached, the send **fails loudly** with
`MEDIA_UNAVAILABLE` and the group is flagged — it never silently posts the ad
without its image.

## 6c. Rate limits, FLOOD_WAIT and slow mode

Every user-account send goes through one global queue. Only one message is ever
in flight, and consecutive sends are separated by `USER_SEND_DELAY_MS`
(default 20s).

When Telegram asks the account to wait, the wait is obeyed exactly — never
shortened, never bypassed, never tight-looped:

| Telegram says | Scope | What happens |
|---|---|---|
| `FLOOD_WAIT_X` | **Account** | The whole queue is held for `X + 5s`. Stored in SQLite as `flood_wait_until`, so a restart still honours it. The scheduler skips every user group until it expires. |
| `SLOWMODE_WAIT_X` | **Chat** | Only that group is deferred by `X`. Other groups keep sending. |
| `PEER_FLOOD` | **Account** | Telegram's anti-spam signal, with no number attached. Backs off for hours and shows in the panel. No retry. |

A deferred advertisement is **never discarded**. The claimed delivery slot is
released so the same ad is retried at the new time, and a rate-limit wait is
not counted as a failure or shown as a broken group.

If a longer hold is already in place, a shorter one never replaces it.

## 7. Automatic scheduling

The scheduler wakes every 60 seconds only to **check** which groups are due.
For each registered group where `enabled = 1` and `next_send_at <= now`:

1. If the slot falls inside quiet hours, `next_send_at` is moved to the next
   allowed time — the ad is delayed, never dropped.
2. The group's campaign is resolved (rotation → fixed → global default).
3. The ad is sent, and `last_send_at = now`, `next_send_at = now + interval`.
4. On a transient failure the retry is in 15 minutes; on a permanent one the
   group is flagged with a delivery problem and moves to its next slot.

All scheduling state lives in SQLite, so a restart resumes exactly where it
stopped. **⚙️ Settings → ⏸ Pause All Advertising** stops automatic sending
globally while leaving the admin panel and manual sends available.

## 8. How duplicates are prevented

Every send — scheduled, manual or test — first claims a row in `ad_deliveries`
with a unique `idempotency_key`. Scheduled sends use a deterministic key:

```
s:<chat_id>:<scheduled_for>
```

The key has a `UNIQUE` constraint, and the claim is a single
`INSERT ... ON CONFLICT DO NOTHING`. If the row already exists the send is
skipped and reported as a duplicate. This holds across:

- a Railway restart or redeploy mid-send
- a process crash between sending and bookkeeping
- a duplicate scheduler tick
- a retry after an error

A crash *after* Telegram accepted the message but *before* the schedule was
advanced therefore cannot produce a second advertisement — this exact case is
covered by a test.

---

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `BOT_TOKEN` | ✅ | — | Admin bot token from BotFather |
| `ADMIN_IDS` | ✅ | — | Comma-separated numeric Telegram user IDs |
| `TELEGRAM_API_ID` | ✅ | — | From my.telegram.org, for the advertising account |
| `TELEGRAM_API_HASH` | ✅ | — | From my.telegram.org — **secret** |
| `TELEGRAM_USER_SESSION` | ✅ | — | From `npm run login:user` — **secret, treat as a password** |
| `USER_SEND_DELAY_MS` | | `20000` | Gap between consecutive user-account sends |
| `USER_SENDER_ENABLED` | | `true` | Set `false` to run the panel without user sending |
| `MEDIA_DIR` | | next to the DB | Where campaign media is cached for MTProto upload |
| `FLOOD_WAIT_MARGIN_SECONDS` | | `5` | Safety margin added to any wait Telegram asks for |
| `MAX_FLOOD_WAIT_SECONDS` | | `21600` | Cap on one hold (the wait is never shortened below Telegram's) |
| `DB_PATH` | | `/data/advertiser.db` | SQLite file path |
| `MAIN_STORE_BOT_URL` | | — | Link used by the default campaign button |
| `MAIN_STORE_BOT_USERNAME` | | — | Fallback used to build the URL |
| `DEFAULT_AD_INTERVAL_MINUTES` | | `360` | Default gap between ads |
| `MIN_INTERVAL_MINUTES` | | `60` | Hard floor for any interval |
| `TZ` | | `Asia/Baghdad` | Timezone for quiet hours and displayed times |
| `SCHEDULER_TICK_MS` | | `60000` | How often due groups are checked |
| `SEND_DELAY_MS` | | `3000` | Delay between group sends in a batch |
| `MAX_SENDS_PER_TICK` | | `25` | Cap on sends per scheduler tick |
| `MAX_RETRY_ATTEMPTS` | | `2` | Retries for 429 / transient errors |
| `SCHEDULER_ENABLED` | | `true` | Set `false` to run the panel without auto-sending |
| `ALLOW_CHANNELS` | | `false` | Allow registering channels as well as groups |

---

## Railway deployment

1. **Create the service** — New Project → Deploy from GitHub repo → pick this
   repository. If the project lives in a subdirectory, set the service **Root
   Directory** to `acc-store-advertiser`.
2. **Add a persistent volume** — Service → Settings → Volumes → New Volume,
   mount path **`/data`**. This is what survives redeploys.
3. **Set variables** — Service → Variables:

   ```
   BOT_TOKEN=...
   ADMIN_IDS=123456789
   DB_PATH=/data/advertiser.db
   MAIN_STORE_BOT_URL=https://t.me/YourStoreBot
   DEFAULT_AD_INTERVAL_MINUTES=360
   TZ=Asia/Baghdad
   NIXPACKS_NODE_VERSION=22

   TELEGRAM_API_ID=1234567
   TELEGRAM_API_HASH=...
   TELEGRAM_USER_SESSION=...
   USER_SEND_DELAY_MS=20000
   ```

   `TELEGRAM_API_HASH` and `TELEGRAM_USER_SESSION` are secrets. Paste them
   straight into Railway — never into a file in this repository.

4. **Start command** — `npm start` (already set in `railway.json`).
5. **Deploy**, then check the logs for:

   ```
   [Advertiser] starting
   [Database] path: /data/advertiser.db
   [Database] persistent: YES
   [Advertiser] admin bot connected as @AD_SENDER_9_bot
   [User Sender] MTProto session loaded
   [User Sender] connected as @your_ad_account
   [Scheduler] enabled (checking every 60s)
   [Groups] 0 registered (0 enabled) — 0 via user account, 0 via bot
   [Campaigns] 1 active
   ```

   If the session is missing or revoked you get this instead, and the **admin
   bot still starts normally**:

   ```
   [User Sender] unavailable — TELEGRAM_USER_SESSION is missing.
   [User Sender] admin bot continues; fix it from the panel or regenerate with npm run login:user
   ```

   The reason is shown in ⚙️ Sender Account, where 🔄 Reconnect and
   🔐 Check Session let you retry without a redeploy.

   If it says `persistent: NO`, the volume is not mounted at `/data` — fix that
   before registering groups, or your data will be lost on the next deploy.

6. Open a private chat with the bot and send `/start`.

The bot uses long polling, so it needs no public domain. On deploy Railway sends
`SIGTERM`; the bot stops the scheduler, stops polling, checkpoints the WAL and
closes SQLite cleanly.

---

## Telegram permissions needed

**For user-account groups (the normal case)** the admin bot does **not** need
to be in the group at all. The *user account* must be a member and allowed to
send messages. Optional delete-previous-ad needs the account to be able to
delete its own messages, which it always can.

**For legacy bot-delivered groups** the bot must be a member and be able to
**send messages**. That is the only mandatory permission.

- **Delete previous ad** (optional, off by default) additionally needs **Delete
  Messages**, which means making the bot an admin. It only ever deletes the
  message ID it recorded for its own previous advertisement.
- If a group restricts posting, grant the bot "Send Messages" or make it an
  admin.
- **Groups → 🔐 Check Permissions** verifies the current state at any time, and
  problems are shown on the group's detail screen.

Registration is refused up front if the bot cannot post.

---

## Project structure

```
acc-store-advertiser/
├── index.js                 # entry point: startup checks, wiring, shutdown
├── scripts/
│   └── login.js             # one-time local CLI login (npm run login:user)
├── package.json
├── railway.json / Procfile  # Railway deployment config
├── .env.example
├── config/
│   └── index.js             # env parsing and validation
├── database/
│   ├── db.js                # connection, additive migrations, integrity check
│   ├── queries.js           # all SQL
│   └── seed.js              # default ACC STORE campaign
├── handlers/
│   ├── common.js            # auth gate, panel rendering, pagination
│   ├── session.js           # in-memory multi-step edit state
│   ├── start.js             # dashboard, /status, /help
│   ├── groups.js            # /register_group and group management
│   ├── campaigns.js         # campaign editor and preview
│   ├── settings.js          # global settings
│   ├── sender.js            # Sender Account panel + Import My Groups
│   ├── sendnow.js           # manual broadcast flows
│   ├── stats.js             # statistics
│   └── callbacks.js         # callback router and input handling
├── services/
│   ├── telegram.js          # BOT send wrapper, 429 retry, error classification
│   ├── userSender.js        # MTProto USER ACCOUNT: connect, dialogs, send
│   ├── sendQueue.js         # global serialised queue + FLOOD_WAIT gate
│   ├── render.js            # per-sender rendering (inline button vs link)
│   ├── mediaStore.js        # caches bot file_id media for MTProto upload
│   ├── broadcaster.js       # idempotent delivery, per-group sender routing
│   ├── scheduler.js         # due-group tick loop
│   ├── policy.js            # interval / quiet-hours / timezone resolution
│   └── shutdown.js          # SIGTERM / SIGINT handling, disconnects both
├── utils/
│   ├── text.js              # Unicode-safe labels for the Bot API
│   ├── keyboard.js          # inline keyboards, stable callback data
│   ├── html.js              # Telegram HTML validation, URL validation
│   ├── time.js              # timezone-aware time and quiet-hour math
│   └── logger.js            # token-redacting logger
└── test/
    ├── helpers.js
    ├── admin.test.js
    ├── campaigns.test.js
    ├── scheduler.test.js
    ├── broadcaster.test.js
    ├── userSender.test.js    # MTProto connect, import, no-auto-join, secrets
    ├── unicode.test.js       # UTF-8 safe labels (Arabic/Kurdish/Vietnamese/emoji)
    ├── permissions.test.js   # callback timing, blocked groups, safe imports
    ├── queue.test.js         # FLOOD_WAIT, SLOWMODE_WAIT, serialisation
    ├── migration.test.js     # existing production data survives the upgrade
    └── database.test.js
```

---

## Database tables

| Table | Purpose |
|---|---|
| `settings` | Key/value globals: pause flag, default interval, timezone, quiet hours, store URL, default campaign |
| `campaigns` | Campaign content: text, media type + `file_id`, button, parse mode, language label, enabled, timestamps, `media_local_path` |
| `groups` | Registered groups: chat id, title, type, username, enabled, interval, campaign, rotation, `last_send_at`, `next_send_at`, `last_message_id`, quiet hours, delete-previous, delivery problem — plus `sender_kind`, `peer_type`, `access_hash`, `peer_checked_at` |
| `group_campaigns` | Ordered rotation list per group |
| `ad_deliveries` | Every send attempt with a unique `idempotency_key`, status, Telegram message id and error code |
| — | `groups` also carries `blocked_reason` / `blocked_at` for a permanently refused chat |
| `audit_log` | Admin actions: `admin_id`, action, target, timestamp |
| `migrations` | Applied migration ids (additive only) |

No secrets are ever stored in the database. `BOT_TOKEN`, `TELEGRAM_API_HASH`
and `TELEGRAM_USER_SESSION` live only in environment variables and in memory.
They are registered with the logger at boot, so even if one ended up inside an
error message it is replaced with `[REDACTED]` before output. A test dumps every
table and asserts none of them appears.

### Migrations

Additive only — `ALTER TABLE ... ADD COLUMN` guarded by a `PRAGMA table_info`
check, tracked by id in the `migrations` table. The database is never dropped or
recreated. `002_mtproto_user_sender` adds the MTProto peer columns; every existing group
defaults to `sender_kind = 'bot'` and keeps working exactly as before.
`003_permission_block` adds `blocked_reason` / `blocked_at`, both defaulting to
NULL, so no existing group is affected.

---

## Admin panel map

```
/start
├── 📣 Campaigns ──── create / edit text / media / button / preview / enable / delete
├── 👥 Groups ─────── enable / interval / campaign / rotation / quiet hours /
│                     delete-previous / check permissions / send test / remove
├── ➕ Add Group ──── instructions for /register_group
├── 📝 Default Advertisement
├── ⏱ Schedule ───── default interval
├── 🚀 Send Now ──── one group / selected groups / all enabled (with confirmation)
├── 📊 Statistics ── counts + recent deliveries
├── ⚙️ Settings ──── default interval / quiet hours / timezone / store URL /
│                     default campaign / pause / resume / audit log
└── ⚙️ Sender Account
    ├── 🔄 Reconnect
    ├── 🔐 Check Session
    └── 👥 Import My Groups
```

⚙️ Sender Account shows only safe information — connection state, first name
and username, joined-group count, registered-group count and any active rate
limit. Never a phone number, api hash, session or 2FA password.
```

---

## Text safety

Telegram group titles are arbitrary user content, and the Bot API rejects any
request containing text that is not valid UTF-8:

```
400 Bad Request: inline keyboard button text must be encoded in UTF-8
```

Slicing a title with `String.slice()` cuts by UTF-16 code unit, so a cut
landing inside an emoji leaves a lone surrogate — and because one bad label
rejects the whole keyboard, a single group could break an entire panel.

`utils/text.js` is the single sanitizer for anything shown to Telegram. It
removes unpaired surrogates, control characters and bidi overrides, applies
NFC normalisation, and truncates by **grapheme cluster** (via
`Intl.Segmenter`) so emoji, flags, ZWJ families and combining marks are never
split. Empty results fall back to `Unnamed group`.

It preserves Arabic, Kurdish, Vietnamese, Spanish and emoji — including ZWNJ
and ZWJ, which are meaningful in those scripts. It runs inside
`utils/keyboard.js`'s `button()` and inside `escapeHtml()`, so every button
label and every message body is covered by construction.

This is **display only**: the full original title stays in the database.

## Tests

161 tests covering admin authentication, group registration, the campaign
editor, scheduling, duplicate prevention, rate limiting, error handling,
persistence and clean shutdown — plus MTProto connection handling, secret
redaction, group import, no-auto-join guarantees, `FLOOD_WAIT` / `SLOWMODE_WAIT`
behaviour, queue serialisation, and an upgrade test against a database built at
the previous schema version — plus UTF-8 safety for Arabic, Kurdish,
Vietnamese, Spanish, emoji, ZWJ sequences, lone surrogates and very long
titles; callback acknowledgement ordering; and permanent-permission blocking
with recovery via re-check.

```bash
npm test
```
