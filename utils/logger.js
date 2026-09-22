'use strict';

/**
 * Minimal logger that never prints secrets.
 *
 * Two layers of defence:
 *  1. Pattern matching, for anything token-shaped.
 *  2. An explicit secret registry — the real BOT_TOKEN, TELEGRAM_API_HASH and
 *     TELEGRAM_USER_SESSION are registered at boot, so even if one ends up
 *     inside an error message or an object dump it is replaced before output.
 */

const TOKEN_PATTERN = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g;

// Exact secret values, longest first so a secret containing another is
// redacted before its substring.
const secrets = [];

/** Registers a value that must never be printed. Safe to call repeatedly. */
function registerSecret(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  // Short values would cause absurd over-redaction of ordinary text.
  if (trimmed.length < 8) return false;
  if (secrets.includes(trimmed)) return false;
  secrets.push(trimmed);
  secrets.sort((a, b) => b.length - a.length);
  return true;
}

function registerSecrets(values = []) {
  return values.map(registerSecret).filter(Boolean).length;
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clearSecrets() {
  secrets.length = 0;
}

function redact(value) {
  if (value === undefined || value === null) return '';
  let text;
  if (typeof value === 'string') text = value;
  else if (value instanceof Error) text = value.message;
  else {
    try {
      text = JSON.stringify(value);
    } catch (_) {
      text = String(value);
    }
  }
  text = String(text);
  for (const secret of secrets) {
    if (text.includes(secret)) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return text.replace(TOKEN_PATTERN, '[REDACTED]');
}

/** Masks a phone number for display: +9647XXXXXX12 */
function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/[^\d+]/g, '');
  if (digits.length < 6) return '***';
  return `${digits.slice(0, 4)}${'*'.repeat(Math.max(0, digits.length - 6))}${digits.slice(-2)}`;
}

function line(scope, parts) {
  return `[${scope}] ${parts.map(redact).join(' ')}`.trimEnd();
}

function makeLogger(scope) {
  return {
    info: (...parts) => console.log(line(scope, parts)),
    warn: (...parts) => console.warn(line(scope, parts)),
    error: (...parts) => console.error(line(scope, parts)),
  };
}

module.exports = { makeLogger, redact, line, registerSecret, registerSecrets, clearSecrets, maskPhone, escapeForRegex };
