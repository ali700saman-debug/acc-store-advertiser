'use strict';

/**
 * Minimal logger that never prints secrets. Any value resembling a bot token
 * is redacted before it reaches stdout.
 */

const TOKEN_PATTERN = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g;

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
  return String(text).replace(TOKEN_PATTERN, '[REDACTED]');
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

module.exports = { makeLogger, redact, line };
