import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readStudioRecords } from './apply-studio-draft.mjs';
import { studioVersion } from './studio-draft.mjs';
import { signIntakeReceipt, verifyIntakeChange } from './studio-receipt.mjs';
import { renderPracticeSummary } from './sync-and-check.mjs';

const factsPath = 'practice-records/practices/graphdozer-sandbox/website-facts.json';
const insurancePath = 'practice-records/practices/graphdozer-sandbox/insurance.json';
const generatedFacts = 'src/data/website-facts.generated.json';

test('signed intake receipts verify the whole candidate commit and reject unauthorized changes', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'graphdozer-approval-test-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const repo = join(folder, 'repo');
  mkdirSync(repo);
  const capture = join(folder, 'output');
  function run(command, args) {
    const fd = openSync(capture, 'w');
    try {
      const result = spawnSync(command, args, { cwd: repo, stdio: ['ignore', fd, 'inherit'] });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, args.join(' '));
      return readFileSync(capture, 'utf8');
    } finally {
      closeSync(fd);
    }
  }
  const git = (...args) => run('git', args);

  function write(path, contents) {
    const file = join(repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  function commit(message) {
    git('add', '--all');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD').trim();
  }
  function render(facts, insurance) {
    const factsText = JSON.stringify(facts, null, 2) + '\n';
    write(factsPath, factsText);
    write(generatedFacts, factsText);
    write('public/llms.txt', renderPracticeSummary(facts, insurance));
  }
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Studio test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');

  const current = readStudioRecords();
  const facts = JSON.parse(current.factsText);
  const insurance = JSON.parse(current.insuranceText);
  write(insurancePath, current.insuranceText);
  render(facts, insurance);
  const base = commit('Base');
  const records = readStudioRecords(repo);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const id = randomUUID();
  const now = Date.now();
  const next = facts.pricing.intake < 500 ? facts.pricing.intake + 5 : 495;
  const draft = { version: studioVersion(records.factsText, records.insuranceText), changes: { pricing: { intake: next } } };
  const receipt = signIntakeReceipt(privateKey, { id, approvedAt: new Date(now).toISOString(), draft }, records);
  const approvedFacts = { ...facts, pricing: { ...facts.pricing, intake: next } };
  const approvedMessage = `Apply intake fee\n\nStudio-Approval: ${id}`;

  function proposal(baseCommit, createFiles) {
    git('checkout', '-q', '--detach', baseCommit);
    render(approvedFacts, insurance);
    createFiles?.();
    return commit(approvedMessage);
  }

  const valid = proposal(base);
  const verify = (candidate, signed = receipt, checkBase = base, clock = now) =>
    verifyIntakeChange(git, checkBase, candidate, publicKey, signed, clock);
  assert.equal(verify(valid), id);
  const keyFile = join(folder, 'public.pem');
  const receiptFile = join(folder, 'receipt.json');
  writeFileSync(keyFile, publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(receiptFile, JSON.stringify(receipt));
  const script = fileURLToPath(new URL('./studio-receipt.mjs', import.meta.url));
  assert.match(run(process.execPath, [script, keyFile, receiptFile, base, valid]), new RegExp(id));
  assert.throws(() => verify(valid, {}), /signed approval receipt is required/);
  const payload = JSON.parse(Buffer.from(receipt.payload, 'base64url'));
  const forged = { ...receipt, payload: Buffer.from(JSON.stringify({ ...payload, next: 500 })).toString('base64url') };
  assert.throws(() => verify(valid, forged), /Invalid approval signature/);
  assert.throws(() => verify(valid, receipt, base, now + 86_400_000), /expired/);

  const renamed = proposal(base, () => render({ ...approvedFacts, practiceName: 'Other practice' }, insurance));
  assert.throws(() => verify(renamed), /website-facts.json does not match the signed approval/);
  const changedLayout = proposal(base, () => write('src/pages/index.astro', '<h1>Different title</h1>'));
  assert.throws(() => verify(changedLayout), /Unapproved file/);
  const changedSummary = proposal(base, () => write('public/llms.txt', 'Different summary\n'));
  assert.throws(() => verify(changedSummary), /llms.txt does not match the signed approval/);

  git('checkout', '-q', '--detach', base);
  write(insurancePath, current.insuranceText + '\n');
  const newer = commit('Change the underlying record');
  assert.throws(() => verify(proposal(newer), receipt, newer), /changed since this draft started/);

  git('checkout', '-q', '--detach', valid);
  render(facts, insurance);
  const reverted = commit('Restore the previous fee');
  assert.throws(() => verify(proposal(reverted), receipt, reverted), /already been used/);
});
