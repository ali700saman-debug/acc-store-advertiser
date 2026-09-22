'use strict';

/**
 * Short-lived, in-memory conversation state for multi-step admin flows
 * ("send me the new text", "send me a photo"). Deliberately not persisted:
 * a restart should cancel half-finished edits, never replay them.
 */

const TTL_MS = 15 * 60 * 1000;

function createSessions({ ttlMs = TTL_MS } = {}) {
  const store = new Map();

  const api = {};

  api.set = (userId, state) => {
    store.set(Number(userId), { ...state, createdAt: Date.now() });
    return state;
  };

  api.get = (userId) => {
    const entry = store.get(Number(userId));
    if (!entry) return null;
    if (Date.now() - entry.createdAt > ttlMs) {
      store.delete(Number(userId));
      return null;
    }
    return entry;
  };

  api.clear = (userId) => store.delete(Number(userId));

  api.patch = (userId, fields) => {
    const current = api.get(userId);
    if (!current) return null;
    const next = { ...current, ...fields };
    store.set(Number(userId), next);
    return next;
  };

  api.size = () => store.size;

  return api;
}

module.exports = { createSessions, TTL_MS };
