# ACC STORE Advertiser

A private, admin-controlled Telegram bot that posts advertisements for your main
ACC STORE bot into groups **you** have explicitly registered.

This is a standalone project. It does not read, write or depend on the main ACC
STORE bot in any way — it only links to it.

---

## Safety model

The bot advertises **only** in groups on its allowlist. A group joins that list
through exactly one path:

1. You manually add the advertising bot to the Telegram group.
2. The bot is given permission to send messages there.
3. An admin listed in `ADMIN_IDS` sends `/register_group` inside that group.

The bot never discovers groups, never joins on its own, never scrapes, never
uses a user account, and never messages a chat that is not registered. Admin
authentication is by numeric Telegram user ID only — usernames are ignored,
since they can be changed.

---

## Requirements

- Node.js 18 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A persistent volume (on Railway) for the SQLite database

---

## Quick start (local)

```bash
cd acc-store-advertiser
npm install
cp .env.example .env      # then edit .env
# for local runs set DB_PATH=./data/advertiser.db
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

## 2. Set ADMIN_IDS

1. Open [@userinfobot](https://t.me/userinfobot) and send it any message.
2. It replies with your numeric ID, e.g. `123456789`.
3. Set the variable, comma separated for multiple admins:

```
ADMIN_IDS=123456789,987654321
```

Anyone not in this list gets a single neutral reply
(`This bot is for ACC STORE administration.`) and no access to any control.

## 3. Register a group

1. Add the advertising bot to the group.
2. Make sure it can send messages (in a restricted group, make it an admin or
   grant "Send Messages").
3. Send `/register_group` in that group as an admin.

The bot verifies it can actually post, then replies
`✅ Group registered successfully.` and the group appears under
**Admin Panel → 👥 Groups**. Sending the command again replies
`ℹ️ This group is already registered.`

To stop advertising there, send `/unregister_group` in the group or use
**Groups → Remove Group** in the panel.

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
| `BOT_TOKEN` | ✅ | — | Advertising bot token from BotFather |
| `ADMIN_IDS` | ✅ | — | Comma-separated numeric Telegram user IDs |
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
   ```

4. **Start command** — `npm start` (already set in `railway.json`).
5. **Deploy**, then check the logs for:

   ```
   [Advertiser] starting
   [Database] path: /data/advertiser.db
   [Database] persistent: YES
   [Scheduler] enabled (checking every 60s)
   [Groups] 0 registered (0 enabled)
   [Campaigns] 1 active
   ```

   If it says `persistent: NO`, the volume is not mounted at `/data` — fix that
   before registering groups, or your data will be lost on the next deploy.

6. Open a private chat with the bot and send `/start`.

The bot uses long polling, so it needs no public domain. On deploy Railway sends
`SIGTERM`; the bot stops the scheduler, stops polling, checkpoints the WAL and
closes SQLite cleanly.

---

## Telegram permissions the bot needs

In every advertising group the bot must be a member and be able to **send
messages**. That is the only mandatory permission.

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
│   ├── sendnow.js           # manual broadcast flows
│   ├── stats.js             # statistics
│   └── callbacks.js         # callback router and input handling
├── services/
│   ├── telegram.js          # send wrapper, 429 retry, error classification
│   ├── broadcaster.js       # idempotent delivery, rate limiting
│   ├── scheduler.js         # due-group tick loop
│   ├── policy.js            # interval / quiet-hours / timezone resolution
│   └── shutdown.js          # SIGTERM / SIGINT handling
├── utils/
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
    └── database.test.js
```

---

## Database tables

| Table | Purpose |
|---|---|
| `settings` | Key/value globals: pause flag, default interval, timezone, quiet hours, store URL, default campaign |
| `campaigns` | Campaign content: text, media type + `file_id`, button, parse mode, language label, enabled, timestamps |
| `groups` | Registered groups: chat id, title, type, username, enabled, interval, campaign, rotation, `last_send_at`, `next_send_at`, `last_message_id`, quiet hours, delete-previous, delivery problem |
| `group_campaigns` | Ordered rotation list per group |
| `ad_deliveries` | Every send attempt with a unique `idempotency_key`, status, Telegram message id and error code |
| `audit_log` | Admin actions: `admin_id`, action, target, timestamp |
| `migrations` | Applied migration ids (additive only) |

No secrets are ever stored in the database.

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
└── ⚙️ Settings ──── default interval / quiet hours / timezone / store URL /
                      default campaign / pause / resume / audit log
```

---

## Tests

78 tests covering admin authentication, group registration, the campaign
editor, scheduling, duplicate prevention, rate limiting, error handling,
persistence and clean shutdown.

```bash
npm test
```
