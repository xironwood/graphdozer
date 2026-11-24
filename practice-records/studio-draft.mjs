import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { studioContactTitle, studioDays, studioHours } from './studio-format.mjs';

const fees = ['intake', 'individual', 'couples', 'lateCancellationFee'];
const collections = ['waitlist', 'hours', 'pricing', 'insurance'];

export class StudioDraftError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

export function studioVersion(factsText, insuranceText) {
  return createHash('sha256').update(factsText).update('\0').update(insuranceText).digest('hex');
}

function checkFields(value, allowed, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StudioDraftError(`${path} must be an object.`);
  }
  const keys = Object.keys(value);
  if (!keys.length) throw new StudioDraftError(`${path} must include a field.`);
  for (const key of keys) {
    if (!allowed.includes(key)) throw new StudioDraftError(`Field ${path}.${key} is locked or unknown.`);
  }
}

function plainText(value, path) {
  // These values also appear in the public Markdown summary.
  if (typeof value !== 'string' || !value.trim() || /[\p{C}\p{Zl}\p{Zp}<>\[\]`|]/u.test(value)) {
    throw new StudioDraftError(`${path} must be single-line plain text.`);
  }
  return value;
}

function updateWaitlist(current, changes) {
  checkFields(changes, ['acceptingNewClients', 'ctaLabel'], 'waitlist');
  const waitlist = { ...current };
  if (Object.hasOwn(changes, 'acceptingNewClients')) {
    const accepting = changes.acceptingNewClients;
    if (typeof accepting !== 'boolean') throw new StudioDraftError('waitlist.acceptingNewClients must be true or false.');
    if (accepting !== current.acceptingNewClients) {
      waitlist.acceptingNewClients = accepting;
      waitlist.contactPageTitle = studioContactTitle(current, accepting);
    }
  }
  if (Object.hasOwn(changes, 'ctaLabel')) waitlist.ctaLabel = plainText(changes.ctaLabel, 'waitlist.ctaLabel');
  return waitlist;
}

function updateHours(current, changes) {
  checkFields(changes, ['days', 'start', 'end'], 'hours');
  const { days, start, end } = changes;
  if (!Array.isArray(days) || !days.length || new Set(days).size !== days.length ||
      days.some((day) => !studioDays.some(({ code }) => code === day))) {
    throw new StudioDraftError('hours.days must contain unique weekdays from Mo, Tu, We, Th, and Fr.');
  }
  const hour = /^(?:0[89]|1\d|20):00$/;
  if (typeof start !== 'string' || typeof end !== 'string' || !hour.test(start) || !hour.test(end) || start >= end) {
    throw new StudioDraftError('hours must use whole hours from 08:00–20:00 Eastern, with start before end.');
  }

  return { ...current, ...studioHours(days, start, end) };
}

function updatePricing(current, changes) {
  checkFields(changes, fees, 'pricing');
  const pricing = { ...current };
  for (const [key, amount] of Object.entries(changes)) {
    if (typeof amount !== 'number' || amount < 0 || amount > 500 || amount % 5 !== 0) {
      throw new StudioDraftError(`pricing.${key} must be a dollar amount from $0 to $500 in $5 increments.`);
    }
    pricing[key] = amount || 0;
  }
  return pricing;
}

function updateInsurance(current, changes) {
  checkFields(changes, ['carriers'], 'insurance');
  if (!Array.isArray(changes.carriers)) throw new StudioDraftError('insurance.carriers must be a list.');
  const usedLabels = new Set();
  const carriers = changes.carriers.map((carrier, index) => {
    const path = `insurance.carriers[${index}]`;
    checkFields(carrier, ['name', 'shortLabel'], path);
    const name = plainText(carrier.name, `${path}.name`);
    const shortLabel = plainText(carrier.shortLabel, `${path}.shortLabel`);
    const labels = new Set([name, shortLabel].map((label) => label.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()));
    for (const label of labels) {
      if (usedLabels.has(label)) throw new StudioDraftError(`Duplicate carrier name or label at ${path}.`);
      usedLabels.add(label);
    }
    return { name, shortLabel };
  });
  return { ...current, carriers };
}

export function applyStudioDraft({ factsText, insuranceText }, draft) {
  checkFields(draft, ['version', 'changes'], 'draft');
  if (draft.version !== studioVersion(factsText, insuranceText)) {
    throw new StudioDraftError('The practice records changed since this draft started. Review a new draft.', 'stale');
  }
  const { changes } = draft;
  checkFields(changes, collections, 'changes');

  const currentFacts = JSON.parse(factsText);
  const currentInsurance = JSON.parse(insuranceText);
  const facts = { ...currentFacts };
  let insurance = currentInsurance;
  if (Object.hasOwn(changes, 'waitlist')) facts.waitlist = updateWaitlist(facts.waitlist, changes.waitlist);
  if (Object.hasOwn(changes, 'hours')) facts.hours = updateHours(facts.hours, changes.hours);
  if (Object.hasOwn(changes, 'pricing')) facts.pricing = updatePricing(facts.pricing, changes.pricing);
  if (Object.hasOwn(changes, 'insurance')) insurance = updateInsurance(insurance, changes.insurance);

  const changed = collections.filter((key) => key === 'insurance'
    ? !isDeepStrictEqual(insurance, currentInsurance)
    : !isDeepStrictEqual(facts[key], currentFacts[key]));
  return { facts, insurance, changed };
}
