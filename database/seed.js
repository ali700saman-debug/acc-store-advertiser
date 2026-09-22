'use strict';

/**
 * Creates the default ACC STORE advertisement on first boot only.
 * The store URL is never hardcoded — it comes from MAIN_STORE_BOT_URL.
 */

const DEFAULT_CAMPAIGN_NAME = 'ACC STORE Main Ad';

const DEFAULT_TEXT = [
  '🛍 <b>ACC STORE</b>',
  '',
  'Premium digital subscriptions and services available now.',
  '',
  '✅ Fast delivery',
  '✅ Competitive prices',
  '✅ New products regularly',
  '✅ Secure ordering through our Telegram bot',
  '',
  '👇 Browse available products:',
].join('\n');

const DEFAULT_BUTTON_TEXT = '🛒 Open ACC STORE';

/** Resolves the store link from settings, then env, then username. */
function resolveStoreUrl(q, config) {
  const stored = q.getSetting('main_store_bot_url');
  if (stored) return stored;
  if (config.mainStoreBotUrl) return config.mainStoreBotUrl;
  if (config.mainStoreBotUsername) return `https://t.me/${config.mainStoreBotUsername}`;
  return null;
}

/**
 * Idempotent: returns the existing default campaign when one is already
 * present, so a redeploy never duplicates or overwrites admin edits.
 */
function ensureDefaultCampaign(q, config, { logger } = {}) {
  const existingId = Number(q.getSetting('default_campaign_id'));
  if (Number.isFinite(existingId)) {
    const existing = q.getCampaign(existingId);
    if (existing) return { created: false, campaign: existing };
  }

  const byName = q.findCampaignByName(DEFAULT_CAMPAIGN_NAME);
  if (byName) {
    q.setSetting('default_campaign_id', byName.id);
    return { created: false, campaign: byName };
  }

  if (q.countCampaigns() > 0) {
    // Admin already created campaigns; adopt the first as the default.
    const first = q.listCampaigns()[0];
    q.setSetting('default_campaign_id', first.id);
    return { created: false, campaign: first };
  }

  const url = resolveStoreUrl(q, config);
  const campaign = q.createCampaign({
    name: DEFAULT_CAMPAIGN_NAME,
    text: DEFAULT_TEXT,
    button_text: url ? DEFAULT_BUTTON_TEXT : null,
    button_url: url,
    parse_mode: 'HTML',
    language: 'en',
    enabled: 1,
  });
  q.setSetting('default_campaign_id', campaign.id);
  if (logger) logger.info(`default campaign created (id ${campaign.id})${url ? '' : ' — no MAIN_STORE_BOT_URL set, button omitted'}`);
  return { created: true, campaign };
}

module.exports = { ensureDefaultCampaign, resolveStoreUrl, DEFAULT_CAMPAIGN_NAME, DEFAULT_TEXT, DEFAULT_BUTTON_TEXT };
