import { createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readStudioRecords } from './apply-studio-draft.mjs';
import { factsPath } from './studio-intake.mjs';
import { approvedIntakeChange, readIntakeReceipt } from './studio-receipt.mjs';

const { STUDIO_PUBLIC_KEY, STUDIO_RECEIPT, STUDIO_ID } = process.env;
try {
  const approved = readIntakeReceipt(createPublicKey(STUDIO_PUBLIC_KEY), JSON.parse(STUDIO_RECEIPT));
  if (approved.id !== STUDIO_ID) throw new Error('The requested ID does not match the signed receipt.');
  const { facts } = approvedIntakeChange(readStudioRecords(), approved);
  writeFileSync(new URL('../' + factsPath, import.meta.url), JSON.stringify(facts, null, 2) + '\n');
  console.log(`Staged approved intake change ${approved.id}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
