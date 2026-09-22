'use strict';

/** Timezone-aware time helpers. No external dependencies. */

const MINUTE_MS = 60 * 1000;

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string' && value) return new Date(value);
  return new Date();
}

function nowIso(now = new Date()) {
  return toDate(now).toISOString();
}

function addMinutes(date, minutes) {
  return new Date(toDate(date).getTime() + minutes * MINUTE_MS);
}

/** Calendar/clock parts of `date` as seen inside `timezone`. */
function zonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(toDate(date))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour % 24,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Offset (ms) of `timezone` from UTC at the given instant. */
function zoneOffsetMs(date, timezone) {
  const d = toDate(date);
  const p = zonedParts(d, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** Converts a wall-clock time inside `timezone` into a real UTC instant. */
function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, timezone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offset = zoneOffsetMs(new Date(naive), timezone);
  let result = new Date(naive - offset);
  // One refinement pass covers DST transitions.
  offset = zoneOffsetMs(result, timezone);
  result = new Date(naive - offset);
  return result;
}

/** Minutes elapsed since local midnight. */
function minutesOfDay(date, timezone) {
  const p = zonedParts(date, timezone);
  return p.hour * 60 + p.minute;
}

/** "22:30" -> 1350. Returns null when unparsable. */
function parseHHMM(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function formatHHMM(minutes) {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = String(Math.floor(total / 60)).padStart(2, '0');
  const m = String(total % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/** Local "HH:MM" clock string for an instant. */
function formatClock(date, timezone) {
  if (!date) return '—';
  const p = zonedParts(date, timezone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Local "YYYY-MM-DD HH:MM" for an instant. */
function formatDateTime(date, timezone) {
  if (!date) return '—';
  const p = zonedParts(date, timezone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Quiet hours are a half-open local window [start, end).
 * Equal start/end means "no quiet window at all".
 */
function isWithinQuietHours(date, timezone, startHHMM, endHHMM) {
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  if (start === null || end === null || start === end) return false;
  const current = minutesOfDay(date, timezone);
  if (start < end) return current >= start && current < end;
  // Window wraps past midnight (e.g. 22:00 -> 08:00).
  return current >= start || current < end;
}

/**
 * If `date` falls inside quiet hours, returns the first instant after the
 * window closes. Otherwise returns `date` unchanged. Ads are delayed, never
 * discarded.
 */
function nextAllowedTime(date, timezone, startHHMM, endHHMM) {
  const target = toDate(date);
  if (!isWithinQuietHours(target, timezone, startHHMM, endHHMM)) return target;
  const end = parseHHMM(endHHMM);
  const p = zonedParts(target, timezone);
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const candidate = zonedTimeToUtc(
      {
        year: p.year,
        month: p.month,
        day: p.day + dayOffset,
        hour: Math.floor(end / 60),
        minute: end % 60,
      },
      timezone
    );
    if (candidate.getTime() > target.getTime()) return candidate;
  }
  return target;
}

/** Human readable interval: 360 -> "6 hours". */
function formatInterval(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value % 1440 === 0) {
    const days = value / 1440;
    return days === 1 ? '1 day' : `${days} days`;
  }
  if (value % 60 === 0) {
    const hours = value / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return value === 1 ? '1 minute' : `${value} minutes`;
}

/** Accepts "90", "2h", "1d", "90m". Returns minutes or null. */
function parseIntervalInput(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim().toLowerCase();
  const match = text.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2] || 'm';
  if (/^d/.test(unit)) return amount * 1440;
  if (/^h/.test(unit)) return amount * 60;
  return amount;
}

module.exports = {
  MINUTE_MS,
  toDate,
  nowIso,
  addMinutes,
  zonedParts,
  zoneOffsetMs,
  zonedTimeToUtc,
  minutesOfDay,
  parseHHMM,
  formatHHMM,
  formatClock,
  formatDateTime,
  isWithinQuietHours,
  nextAllowedTime,
  formatInterval,
  parseIntervalInput,
};
