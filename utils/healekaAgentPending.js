/**
 * Short-lived pending / draft actions for Healeka AI (confirm-before-mutate).
 * Keyed by hospitalId:userId. TTL 10 minutes.
 */

const crypto = require("crypto");

const TTL_MS = 10 * 60 * 1000;
/** @type {Map<string, object>} */
const byUser = new Map();
/** @type {Map<string, string>} actionId -> userKey */
const actionIndex = new Map();

function userKey(hospitalId, userId) {
  return `${hospitalId}:${userId}`;
}

function purgeExpired(entry, key) {
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    byUser.delete(key);
    if (entry.id) actionIndex.delete(entry.id);
    return null;
  }
  return entry;
}

function getDraft(hospitalId, userId) {
  const key = userKey(hospitalId, userId);
  return purgeExpired(byUser.get(key), key);
}

function setDraft(hospitalId, userId, data) {
  const key = userKey(hospitalId, userId);
  const prev = purgeExpired(byUser.get(key), key);
  if (prev?.id) actionIndex.delete(prev.id);

  const id = data.id || crypto.randomBytes(8).toString("hex");
  const entry = {
    ...data,
    id,
    hospitalId: String(hospitalId),
    userId: String(userId),
    expiresAt: Date.now() + TTL_MS,
    updatedAt: Date.now(),
  };
  byUser.set(key, entry);
  actionIndex.set(id, key);
  return entry;
}

function clearDraft(hospitalId, userId) {
  const key = userKey(hospitalId, userId);
  const prev = byUser.get(key);
  if (prev?.id) actionIndex.delete(prev.id);
  byUser.delete(key);
}

function getByActionId(actionId, hospitalId, userId) {
  const key = actionIndex.get(actionId);
  if (!key) return null;
  const expected = userKey(hospitalId, userId);
  if (key !== expected) return null;
  return purgeExpired(byUser.get(key), key);
}

function toClientPending(entry) {
  if (!entry || entry.status !== "ready") return undefined;
  return {
    id: entry.id,
    type: entry.type,
    summary: entry.summary,
    payloadPreview: entry.payloadPreview || entry.payload,
  };
}

module.exports = {
  getDraft,
  setDraft,
  clearDraft,
  getByActionId,
  toClientPending,
  TTL_MS,
};
