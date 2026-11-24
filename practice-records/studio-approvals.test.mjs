import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { buildStudioDraft, readStudioRecords } from './apply-studio-draft.mjs';
import { createStudioServer } from './serve-studio.mjs';
import { openStudioApprovals } from './studio-approvals.mjs';
import { applyStudioDraft, studioVersion } from './studio-draft.mjs';

const origin = 'http://127.0.0.1:4321';
const owner = 'reviewer';
const ownerPassword = 'test-owner-password';
const agentToken = 'test-agent-token';
const ownerHeaders = {
  Origin: origin,
  Authorization: 'Basic ' + Buffer.from(`${owner}:${ownerPassword}`).toString('base64'),
};
const agentHeaders = { Authorization: `Bearer ${agentToken}` };
const approvalPath = '/studio/api/approvals';
const queuePath = '/studio-agent/approvals';
const applyPath = (id) => `${queuePath}/${id}/apply`;

function client(approvals, dependencyOverrides = {}) {
  const server = createStudioServer({ origin, owner, ownerPassword, agentToken, approvals, ...dependencyOverrides });
  const [handler] = server.listeners('request');
  return async (method, url, headers = {}, body) => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Readable.from(payload);
    req.method = method;
    req.url = url;
    req.headers = {
      host: new URL(origin).host,
      ...(payload.length ? { 'content-type': 'application/json', 'content-length': payload[0].length } : {}),
      ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
    };
    const response = {};
    const res = {
      writeHead(status, headers) { Object.assign(response, { status, headers }); },
      end(body) {
        response.body = typeof body === 'string' && response.headers['Content-Type'].includes('application/json')
          ? JSON.parse(body) : body;
      },
    };
    await handler(req, res);
    return response;
  };
}

function feeDraft(records) {
  const { intake } = JSON.parse(records.factsText).pricing;
  const amount = intake === 500 ? 495 : intake + 5;
  return {
    version: studioVersion(records.factsText, records.insuranceText),
    changes: { pricing: { intake: amount } },
  };
}

test('the owner stamps an exact draft and an agent applies it by receipt ID after reopening the store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-approvals-test-'));
  const file = join(directory, 'approvals.sqlite');
  let store = openStudioApprovals(file);
  let reviewDirectory;
  try {
    const records = readStudioRecords();
    const draft = feeDraft(records);
    const api = client(store);
    assert.equal((await api('POST', approvalPath, {}, draft)).status, 401);
    assert.equal((await api('POST', approvalPath, { ...ownerHeaders, Origin: 'https://elsewhere.test' }, draft)).status, 403);
    assert.equal((await api('POST', approvalPath, { ...ownerHeaders, Host: 'elsewhere.test' }, draft)).status, 403);
    assert.equal((await api('POST', approvalPath, agentHeaders, draft)).status, 401);
    assert.equal((await api('GET', queuePath, ownerHeaders)).status, 401);
    const rogue = { ...draft, changes: { ...draft.changes, practiceName: 'A different title' } };
    assert.equal((await api('POST', approvalPath, ownerHeaders, rogue)).status, 422);
    assert.deepEqual((await api('GET', queuePath, agentHeaders)).body.approvals, []);

    const saved = await api('POST', approvalPath, ownerHeaders, draft);
    assert.equal(saved.status, 201);
    const { id } = saved.body;
    assert.equal(saved.body.status, 'queued');
    const duplicate = await api('POST', approvalPath, ownerHeaders, draft);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.id, id);
    store.close();
    store = openStudioApprovals(file);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    let builds = 0;
    const apply = client(store, {
      signingKey: privateKey,
      async buildDraft(savedDraft) {
        builds++;
        assert.deepEqual(savedDraft, draft);
        const review = await buildStudioDraft(savedDraft);
        reviewDirectory = review.directory;
        return review;
      },
    });
    assert.deepEqual((await apply('GET', queuePath, agentHeaders)).body.approvals.map(({ id }) => id), [id]);
    assert.equal((await apply('POST', applyPath(id), ownerHeaders)).status, 401);
    assert.equal((await apply('POST', applyPath(id), agentHeaders, { pricing: { intake: 500 } })).status, 400);
    const running = apply('POST', applyPath(id), agentHeaders);
    assert.equal((await apply('POST', applyPath(id), agentHeaders)).status, 409);
    const result = await running;
    assert.equal(result.status, 200, result.body?.review?.error);
    assert.equal(result.body.status, 'ready');
    const { payload, signature } = result.body.review.signedReceipt;
    assert.ok(verify(null, Buffer.from(payload, 'base64url'), publicKey, Buffer.from(signature, 'base64url')));
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).id, id);
    assert.equal((await apply('POST', applyPath(id), agentHeaders)).status, 200);
    assert.equal(builds, 1);
    const diff = await readFile(result.body.review.diff, 'utf8');
    assert.ok(diff.includes(`"intake": ${draft.changes.pricing.intake}`));
    assert.ok(!diff.includes('insurance.json'));
    const log = await readFile(result.body.review.log, 'utf8');
    assert.match(log, /Compliance passed on 5 rendered public pages and public\/llms\.txt/);
    assert.match(log, /6 page\(s\) built/);
    assert.deepEqual(readStudioRecords(), records);
  } finally {
    store.close();
    if (reviewDirectory) await rm(reviewDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('the service rejects an approval when its underlying records moved, before or after stamping', async () => {
  const store = openStudioApprovals(':memory:');
  try {
    let records = readStudioRecords();
    const draft = feeDraft(records);
    const api = client(store, {
      readRecords: () => records,
      buildDraft: (saved) => applyStudioDraft(records, saved),
    });
    const saved = await api('POST', approvalPath, ownerHeaders, draft);
    assert.equal(saved.status, 201);
    records = { ...records, insuranceText: records.insuranceText + '\n' };
    const outdated = await api('POST', approvalPath, ownerHeaders, draft);
    assert.equal(outdated.status, 409);
    const apply = await api('POST', applyPath(saved.body.id), agentHeaders);
    assert.equal(apply.status, 409);
    assert.equal(apply.body.status, 'stale');
    assert.deepEqual((await api('GET', queuePath, agentHeaders)).body.approvals, []);
  } finally {
    store.close();
  }
});
