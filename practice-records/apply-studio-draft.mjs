import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyStudioDraft, StudioDraftError, studioVersion } from './studio-draft.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const records = 'practice-records/practices/graphdozer-sandbox';
const factsFile = `${records}/website-facts.json`;
const insuranceFile = `${records}/insurance.json`;
const reviewFiles = [factsFile, insuranceFile, 'src/data/website-facts.generated.json', 'src/data/insurance.generated.json', 'public/llms.txt'];

export function readStudioRecords(directory = root) {
  return {
    factsText: readFileSync(join(directory, factsFile), 'utf8'),
    insuranceText: readFileSync(join(directory, insuranceFile), 'utf8'),
  };
}

function versionOf({ factsText, insuranceText }) {
  return studioVersion(factsText, insuranceText);
}

function verifyVersion(directory, version) {
  if (versionOf(readStudioRecords(directory)) !== version) {
    throw new StudioDraftError('The practice records changed while preparing the review. Review a new draft.', 'stale');
  }
}

async function run(command, args, cwd, outputFile, acceptableStatuses) {
  const output = openSync(outputFile, 'w');
  try {
    const child = spawn(command, args, { cwd, stdio: ['ignore', output, output], signal: AbortSignal.timeout(120_000) });
    const [status, signal] = await once(child, 'close');
    if (!acceptableStatuses.includes(status)) {
      const log = readFileSync(outputFile, 'utf8').trim();
      throw new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${status}`}).${log ? `\n${log}` : ''}`);
    }
  } finally {
    closeSync(output);
  }
}

function copyReviewFiles(source, destination) {
  for (const path of reviewFiles) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(source, path), target);
  }
}

async function prepareReview(version, { facts, insurance, changed }) {
  const directory = mkdtempSync(join(tmpdir(), 'graphdozer-studio-'));
  const candidate = join(directory, 'candidate');
  try {
    mkdirSync(candidate);
    for (const path of ['.node-version', 'astro.config.mjs', 'package.json', 'tsconfig.json', 'practice-records', 'public', 'src']) {
      cpSync(join(root, path), join(candidate, path), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(candidate, 'node_modules'), 'dir');
    verifyVersion(candidate, version);
    copyReviewFiles(candidate, join(directory, 'before'));

    if (changed.some((collection) => collection !== 'insurance')) {
      writeFileSync(join(candidate, factsFile), JSON.stringify(facts, null, 2) + '\n');
    }
    if (changed.includes('insurance')) {
      writeFileSync(join(candidate, insuranceFile), JSON.stringify(insurance, null, 2) + '\n');
    }

    const log = join(directory, 'build.log');
    await run('npm', ['run', 'build'], candidate, log, [0]);
    verifyVersion(root, version);
    copyReviewFiles(candidate, join(directory, 'after'));
    const diff = join(directory, 'review.diff');
    await run('git', ['--no-pager', 'diff', '--no-index', '--no-ext-diff', '--no-color', '--', 'before', 'after'], directory, diff, [0, 1]);

    return { directory, diff, log, site: join(candidate, 'dist') };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function buildStudioDraft(draft) {
  const result = applyStudioDraft(readStudioRecords(), draft);
  if (!result.changed.length) throw new StudioDraftError('The draft matches the current practice records.', 'empty');
  const review = await prepareReview(draft.version, result);
  return { ...review, changed: result.changed };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(`Usage for a local reviewer
  npm run --silent studio:apply -- --version
  npm run studio:apply -- draft.json

A draft contains the version printed by --version and a partial changes object:
  {"version":"<version>","changes":{"pricing":{"intake":250}}}

Other supported collections:
  waitlist: acceptingNewClients (boolean), ctaLabel (text)
  hours: days (Mo, Tu, We, Th, Fr), start and end (HH:00 in Eastern time)
  insurance: carriers (list of name and shortLabel objects)

The command builds an isolated review copy and prints the diff and artifact paths.`);
    return;
  }
  if (args.length !== 1 || (args[0].startsWith('-') && args[0] !== '--version')) {
    throw new Error('Use npm run studio:apply -- --help for usage.');
  }

  if (args[0] === '--version') {
    console.log(versionOf(readStudioRecords()));
    return;
  }
  const draft = JSON.parse(readFileSync(args[0], 'utf8'));
  const review = await buildStudioDraft(draft);
  console.log(`Built Studio draft for local review (${review.changed.join(', ')}).`);
  console.log(`Diff: ${review.diff}\nBuild log: ${review.log}\nStatic site: ${review.site}`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (error.code === 'empty') console.log(error.message);
    else {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
