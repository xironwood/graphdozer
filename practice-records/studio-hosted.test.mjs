import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { onRequest } from '../functions/studio/[[path]].js';
import { readStudioRecords } from './apply-studio-draft.mjs';
import { studioVersion } from './studio-draft.mjs';
import { approvedIntakeChange, readIntakeReceipt } from './studio-receipt.mjs';
import { factsPath, insurancePath } from './studio-intake.mjs';

test('hosted Studio protects the page and dispatches an exact signed intake approval', async (t) => {
  const origin = 'https://graphdozer.com';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const env = {
    STUDIO_OWNER_PASSWORD: 'test-owner-password',
    STUDIO_SIGNING_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    STUDIO_GITHUB_TOKEN: 'test-dispatch-token',
  };
  const records = readStudioRecords();
  const oldFee = JSON.parse(records.factsText).pricing.intake;
  const intake = oldFee === 500 ? 495 : oldFee + 5;
  const version = studioVersion(records.factsText, records.insuranceText);
  const draft = { version, changes: { pricing: { intake } } };
  const sha = 'a'.repeat(40);
  const dispatches = [];
  let rateLimitMain = false;
  const warning = t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/git/ref/heads/main')) {
      assert.equal(options.headers.Authorization, 'Bearer ' + env.STUDIO_GITHUB_TOKEN);
      if (rateLimitMain) {
        return new Response('GitHub response details', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      }
      return Response.json({ object: { sha } });
    }
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      assert.equal(new Headers(options.headers).has('Authorization'), false);
      if (url.endsWith(`/${sha}/${factsPath}`)) return new Response(records.factsText);
      if (url.endsWith(`/${sha}/${insurancePath}`)) return new Response(records.insuranceText);
    }
    assert.ok(url.endsWith('/actions/workflows/studio-intake.yml/dispatches'));
    assert.equal(options.headers.Authorization, 'Bearer ' + env.STUDIO_GITHUB_TOKEN);
    dispatches.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  });

  const authorization = 'Basic ' + btoa('owner:' + env.STUDIO_OWNER_PASSWORD);
  const visit = (request) => onRequest({ request, env, next: () => new Response('Studio') });
  const stamp = (body, headers = {}) => visit(new Request(origin + '/studio/api/approvals', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: origin, Authorization: authorization, ...headers },
  }));
  assert.equal((await visit(new Request(origin + '/studio/'))).status, 401);
  const page = await visit(new Request(origin + '/studio/', { headers: { Authorization: authorization } }));
  assert.equal(await page.text(), 'Studio');
  assert.equal(page.headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await stamp(draft, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await stamp({ ...draft, version: '0'.repeat(64) })).status, 409);
  assert.equal((await stamp({ ...draft, changes: { ...draft.changes, practiceName: 'Different Practice' } })).status, 422);
  assert.equal(dispatches.length, 0);

  rateLimitMain = true;
  const unavailable = await stamp(draft);
  assert.equal(unavailable.status, 502);
  assert.match((await unavailable.json()).error, /Your draft is still open/);
  assert.deepEqual(warning.mock.calls.map(({ arguments: args }) => args), [
    ['Studio approval failed: read main: HTTP 403 (rate limit)'],
  ]);
  assert.equal(dispatches.length, 0);
  rateLimitMain = false;

  const first = await stamp(draft);
  assert.equal(first.status, 202);
  const { id } = await first.json();
  assert.equal((await (await stamp(draft)).json()).id, id);
  assert.equal(dispatches[0].ref, 'main');
  const signed = readIntakeReceipt(publicKey, dispatches[0].inputs);
  assert.equal(signed.id, id);
  assert.equal(signed.previous, oldFee);
  assert.equal(approvedIntakeChange(records, signed).facts.pricing.intake, intake);
});
