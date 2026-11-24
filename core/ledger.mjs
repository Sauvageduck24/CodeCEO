// Traceability (decision ledger) and horizontal communication (mailboxes).
import crypto from 'node:crypto';
import { appendJsonl, readJsonl, writeText } from './util.mjs';
import { storePath } from './config.mjs';

const now = () => new Date().toISOString();
const rid = () => crypto.randomBytes(3).toString('hex');

export function record(root, entry) {
  const e = { ts: now(), ...entry };
  appendJsonl(storePath(root, 'ledger.jsonl'), e);
  return e;
}

export const readLedger = (root) => readJsonl(storePath(root, 'ledger.jsonl'));

export function decision(root, { agent, summary, why = '', files = [], run = null }) {
  return record(root, { type: 'decision', id: rid(), agent, summary, why, files, run });
}

/** Everything the ledger knows about a file: decisions and changes that touched it. */
export function whyFile(root, file) {
  return readLedger(root).filter((e) => e.file === file || e.files?.includes(file));
}

// ── mailboxes ────────────────────────────────────────────────────────────────
const inboxFile = (root, id) => storePath(root, 'inbox', `${id}.jsonl`);

export function send(root, { from, to, kind = 'request', subject, body = '', files = [] }) {
  const msg = { id: rid(), ts: now(), from, to, kind, subject, body, files, status: 'open' };
  appendJsonl(inboxFile(root, to), msg);
  record(root, { type: 'message', id: msg.id, from, to, kind, subject });
  return msg;
}

export function inbox(root, id, { all = false } = {}) {
  // an ack is appended as {id, status:'done'}; last write wins
  const state = new Map();
  for (const m of readJsonl(inboxFile(root, id))) state.set(m.id, { ...(state.get(m.id) ?? {}), ...m });
  const list = [...state.values()];
  return all ? list : list.filter((m) => m.status === 'open');
}

export function ack(root, id, msgId, note = '') {
  appendJsonl(inboxFile(root, id), { id: msgId, status: 'done', ackAt: now(), note });
  record(root, { type: 'ack', id: msgId, agent: id, note });
}

export function clearInbox(root, id) {
  writeText(inboxFile(root, id), '');
}
