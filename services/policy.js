'use strict';

/**
 * Resolves the effective settings for a group: interval, quiet hours and
 * timezone. Group values override global settings, which override env config.
 * Shared by the scheduler and the admin panel so both always agree.
 */

const { addMinutes, nextAllowedTime, isWithinQuietHours, parseHHMM } = require('../utils/time');

function getTimezone(q, config) {
  return q.getSetting('timezone') || config.timezone;
}

function getDefaultIntervalMinutes(q, config) {
  const stored = Number.parseInt(q.getSetting('default_interval_minutes') ?? '', 10);
  const value = Number.isFinite(stored) && stored > 0 ? stored : config.defaultIntervalMinutes;
  return Math.max(config.minIntervalMinutes, value);
}

/** Clamps any admin-provided interval to the safety minimum. */
function clampInterval(minutes, config) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(config.minIntervalMinutes, Math.round(value));
}

function resolveIntervalMinutes(q, config, group) {
  const groupValue = Number(group?.interval_minutes);
  if (Number.isFinite(groupValue) && groupValue > 0) {
    return Math.max(config.minIntervalMinutes, groupValue);
  }
  return getDefaultIntervalMinutes(q, config);
}

/** Per-group quiet hours fall back to the global window. */
function resolveQuiet(q, group) {
  if (group && group.quiet_enabled) {
    return { enabled: true, start: group.quiet_start || '00:00', end: group.quiet_end || '08:00', source: 'group' };
  }
  if (q.getSetting('quiet_enabled', '0') === '1') {
    return {
      enabled: true,
      start: q.getSetting('quiet_start', '00:00') || '00:00',
      end: q.getSetting('quiet_end', '08:00') || '08:00',
      source: 'global',
    };
  }
  return { enabled: false, start: null, end: null, source: 'none' };
}

function quietIsValid(quiet) {
  if (!quiet?.enabled) return false;
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  return start !== null && end !== null && start !== end;
}

/** True when advertising is not allowed at `date`. */
function inQuietHours(date, quiet, timezone) {
  if (!quietIsValid(quiet)) return false;
  return isWithinQuietHours(date, timezone, quiet.start, quiet.end);
}

/**
 * Next send time = from + interval, pushed past any quiet window.
 * An ad due during quiet hours is delayed, never dropped.
 */
function computeNextSendAt(from, intervalMinutes, quiet, timezone) {
  const candidate = addMinutes(from, intervalMinutes);
  if (!quietIsValid(quiet)) return candidate;
  return nextAllowedTime(candidate, timezone, quiet.start, quiet.end);
}

/** Pushes an already-due instant out of the current quiet window. */
function deferPastQuietHours(date, quiet, timezone) {
  if (!quietIsValid(quiet)) return date;
  return nextAllowedTime(date, timezone, quiet.start, quiet.end);
}

module.exports = {
  getTimezone,
  getDefaultIntervalMinutes,
  clampInterval,
  resolveIntervalMinutes,
  resolveQuiet,
  quietIsValid,
  inQuietHours,
  computeNextSendAt,
  deferPastQuietHours,
};
