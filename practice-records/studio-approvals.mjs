import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { applyStudioDraft, StudioDraftError } from './studio-draft.mjs';

const buildLeaseMs = 5 * 60_000;

export function openStudioApprovals(file) {
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      draft TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      claim TEXT,
      lease_end INTEGER,
      review TEXT
    ) STRICT;
  `);
  const insert = db.prepare(`
    INSERT INTO approvals (id, fingerprint, owner, approved_at, draft)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (fingerprint) DO NOTHING
  `);
  const find = db.prepare('SELECT id, status FROM approvals WHERE fingerprint = ?');
  const reopen = db.prepare(`
    UPDATE approvals SET status = 'queued', review = NULL, approved_at = ?
    WHERE fingerprint = ? AND status IN ('failed', 'stale')
  `);
  const get = db.prepare('SELECT id, status, review FROM approvals WHERE id = ?');
  const queue = db.prepare(`
    SELECT id, approved_at AS approvedAt FROM approvals
    WHERE status = 'queued' OR (status = 'building' AND lease_end <= ?)
    ORDER BY approved_at, id LIMIT 100
  `);
  const claim = db.prepare(`
    UPDATE approvals SET status = 'building', claim = ?, lease_end = ?
    WHERE id = ? AND (status IN ('queued', 'failed') OR (status = 'building' AND lease_end <= ?))
    RETURNING draft, approved_at AS approvedAt
  `);
  const finish = db.prepare(`
    UPDATE approvals SET status = ?, review = ?, claim = NULL, lease_end = NULL
    WHERE id = ? AND claim = ?
  `);

  return {
    save(owner, records, draft) {
      const { facts, insurance, changed } = applyStudioDraft(records, draft);
      if (!changed.length) throw new StudioDraftError('Make a change before stamping the draft.');
      const fingerprint = createHash('sha256').update(JSON.stringify([owner, draft.version, facts, insurance])).digest('hex');
      const time = new Date().toISOString();
      const result = insert.run(randomUUID(), fingerprint, owner, time, JSON.stringify(draft));
      if (!result.changes) reopen.run(time, fingerprint);
      return { ...find.get(fingerprint), created: result.changes === 1 };
    },
    pending() {
      return queue.all(Date.now());
    },
    get(id) {
      const row = get.get(id);
      if (!row) return null;
      return { id: row.id, status: row.status, review: JSON.parse(row.review ?? 'null') };
    },
    claim(id) {
      const now = Date.now();
      const token = randomUUID();
      const row = claim.get(token, now + buildLeaseMs, id, now);
      return row ? { token, approvedAt: row.approvedAt, draft: JSON.parse(row.draft) } : null;
    },
    finish(id, token, status, review) {
      return finish.run(status, JSON.stringify(review), id, token).changes === 1;
    },
    close() {
      db.close();
    },
  };
}
