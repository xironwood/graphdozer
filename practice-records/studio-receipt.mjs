import { spawnSync } from 'node:child_process';
import { createPublicKey, sign, verify } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyStudioDraft } from './studio-draft.mjs';
import { factsPath, insurancePath, intakeScope, receiptLifetime } from './studio-intake.mjs';
import { renderPracticeSummary } from './sync-and-check.mjs';

const receiptId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const trailer = '%(trailers:key=Studio-Approval,valueonly)';

export function isIntakeDraft(draft) {
  return isDeepStrictEqual(draft.changes, { pricing: { intake: draft.changes?.pricing?.intake } });
}

export function signIntakeReceipt(key, { id, approvedAt, draft }, records) {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 signing key is required.');
  if (!receiptId.test(id) || !isIntakeDraft(draft)) throw new Error('The pilot signs intake-only approvals.');
  const { facts, changed } = applyStudioDraft(records, draft);
  if (!changed.length) throw new Error('The approved intake fee matches the base record.');
  const approved = Date.parse(approvedAt);
  if (!Number.isFinite(approved)) throw new Error('Invalid approval timestamp.');
  const payload = Buffer.from(JSON.stringify({
    scope: intakeScope, id, version: draft.version,
    previous: JSON.parse(records.factsText).pricing.intake,
    next: facts.pricing.intake,
    approved, expires: approved + receiptLifetime,
  }));
  return { payload: payload.toString('base64url'), signature: sign(null, payload, key).toString('base64url') };
}

export function readIntakeReceipt(key, receipt, now = Date.now()) {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 public key is required.');
  if (typeof receipt?.payload !== 'string' || typeof receipt?.signature !== 'string') {
    throw new Error('A signed approval receipt is required.');
  }
  const payload = Buffer.from(receipt.payload, 'base64url');
  const signature = Buffer.from(receipt.signature, 'base64url');
  if (payload.toString('base64url') !== receipt.payload || signature.toString('base64url') !== receipt.signature ||
      !verify(null, payload, key, signature)) throw new Error('Invalid approval signature.');
  const approved = JSON.parse(payload);
  if (approved.scope !== intakeScope || !receiptId.test(approved.id)) throw new Error('Approval is for a different site or field.');
  if (!Number.isFinite(approved.approved) || approved.approved > now || approved.expires !== approved.approved + receiptLifetime ||
      approved.expires <= now) throw new Error('Approval is expired or has an invalid timestamp.');
  return approved;
}

export function approvedIntakeChange(records, approved) {
  if (JSON.parse(records.factsText).pricing.intake !== approved.previous) throw new Error('The previous intake fee changed.');
  const { facts, insurance, changed } = applyStudioDraft(records, {
    version: approved.version, changes: { pricing: { intake: approved.next } },
  });
  if (!changed.length) throw new Error('The approved intake fee matches the base record.');
  return { facts, insurance };
}

export function verifyIntakeChange(git, baseRef, candidateRef, key, receipt, now = Date.now()) {
  const approved = readIntakeReceipt(key, receipt, now);
  const resolve = (ref) => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  const base = resolve(baseRef);
  const candidate = resolve(candidateRef);
  if (git('rev-list', '--parents', '-n1', candidate).trim() !== `${candidate} ${base}`) {
    throw new Error('Expected one candidate commit directly on the current base.');
  }
  if (git('log', '--fixed-strings', `--grep=${approved.id}`, `--format=${trailer}`, base).split(/\s+/).includes(approved.id)) {
    throw new Error('This approval has already been used.');
  }
  if (git('show', '-s', `--format=${trailer}`, candidate).trim() !== approved.id) {
    throw new Error('Candidate commit must have a Studio-Approval trailer with this receipt ID.');
  }

  const factsText = git('show', `${base}:${factsPath}`);
  const insuranceText = git('show', `${base}:${insurancePath}`);
  const { facts, insurance } = approvedIntakeChange({ factsText, insuranceText }, approved);

  const expectedFacts = JSON.stringify(facts, null, 2) + '\n';
  const allowed = new Map([
    [factsPath, expectedFacts],
    ['src/data/website-facts.generated.json', expectedFacts],
    ['public/llms.txt', renderPracticeSummary(facts, insurance)],
  ]);
  const diff = git('diff', '--raw', '--no-ext-diff', '--no-renames', '-z', base, candidate).split('\0');
  for (let index = 0; index < diff.length - 1; index += 2) {
    const [metadata, path] = diff.slice(index, index + 2);
    if (!allowed.has(path) || !/^:100644 100644 [a-f0-9]+ [a-f0-9]+ M$/.test(metadata)) {
      throw new Error(`Unapproved file or mode change in ${path}.`);
    }
  }
  for (const [path, expected] of allowed) {
    if (git('show', `${candidate}:${path}`) !== expected) throw new Error(`${path} does not match the signed approval.`);
  }
  return approved.id;
}

function main(args) {
  if (args.length !== 4) {
    throw new Error('Usage: node <trusted-path>/studio-receipt.mjs <public-key.pem> <receipt.json> <main-commit> <candidate-commit>');
  }
  const [keyFile, receiptFile, baseRef, candidateRef] = args;
  const key = createPublicKey(readFileSync(keyFile));
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  const scratch = mkdtempSync(join(tmpdir(), 'studio-verify-'));
  const capture = join(scratch, 'git-output');
  try {
    const git = (...arguments_) => {
      const output = openSync(capture, 'w');
      try {
        const run = spawnSync('git', ['--no-replace-objects', ...arguments_], { stdio: ['ignore', output, 'inherit'] });
        if (run.error) throw run.error;
        if (run.status !== 0) throw new Error(`Unable to read candidate with git ${arguments_[0]}.`);
        return readFileSync(capture, 'utf8');
      } finally {
        closeSync(output);
      }
    };
    console.log(`Verified Studio approval ${verifyIntakeChange(git, baseRef, candidateRef, key, receipt)}.`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
