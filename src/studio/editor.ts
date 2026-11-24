import { getAvailabilityNotice } from '../data/availability';
import { formatFee } from '../data/practice';
import {
  availabilityLabel, carrierKey, carrierLabel, collections, contactLabel, contactTitle, days, draftChanges,
  draftHours, estimate, fees, hoursLine, live, liveDays, liveEnd, liveStart,
} from './preview';
import type { Carrier, Draft } from './preview';

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const editors = byId<HTMLFieldSetElement>('studio-editors');
const view = byId<HTMLFieldSetElement>('studio-view');
const reset = byId<HTMLButtonElement>('reset-studio');
const accepting = byId<HTMLInputElement>('accepting-clients');
const cta = byId<HTMLInputElement>('studio-cta');
const booksState = byId('books-state');
const dayInputs = Array.from(editors.querySelectorAll<HTMLInputElement>('[name="day"]'));
const start = byId<HTMLSelectElement>('studio-start');
const end = byId<HTMLSelectElement>('studio-end');
const carrierChips = byId('carrier-chips');
const carrierForm = byId<HTMLFormElement>('carrier-form');
const carrierName = byId<HTMLInputElement>('carrier-name');
const slip = byId('change-slip');
const slipChanges = byId('slip-changes');
const stamp = byId<HTMLButtonElement>('stamp-preview');
const stampStatus = byId('stamp-status');
const prompt = byId<HTMLTextAreaElement>('studio-prompt');
const copy = byId<HTMLButtonElement>('copy-prompt');
const copyStatus = byId('copy-status');

const feeInputs = fees.map(({ key }) => ({
  key,
  input: byId<HTMLInputElement>(`studio-${key}`),
  error: byId(`error-${key}`),
}));
const receiptItems = document.querySelectorAll<HTMLElement>('[data-ripple]');
const rateCells = document.querySelectorAll<HTMLElement>('[data-rate]');
const builderOutput = document.querySelectorAll<HTMLElement>('[data-builder]');
const invalidFields = new Set<HTMLInputElement>();
let draft = structuredClone(live);
let savingApproval = false;

function text(id: string, value: string) {
  const element = byId(id);
  if (element.textContent !== value) element.textContent = value;
}

function setError(input: HTMLInputElement, error: HTMLElement, message = '', hint?: string) {
  input.setAttribute('aria-invalid', String(Boolean(message)));
  const descriptions = [hint, message && error.id].filter(Boolean).join(' ');
  if (descriptions) input.setAttribute('aria-describedby', descriptions);
  else input.removeAttribute('aria-describedby');
  if (error.textContent !== message) error.textContent = message;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, value: string, className = '') {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function renderReceipt() {
  const { waitlist, hours, pricing } = draft;
  const difference = estimate(pricing) - estimate(live.pricing);
  booksState.textContent = availabilityLabel(waitlist.acceptingNewClients);
  booksState.classList.toggle('mint', waitlist.acceptingNewClients);
  booksState.classList.toggle('gold', !waitlist.acceptingNewClients);
  text('ripple-availability', getAvailabilityNotice(waitlist.acceptingNewClients));
  text('ripple-contact', waitlist.contactPageTitle);
  text('ripple-cta', waitlist.ctaLabel);
  text('ripple-hours', hours.display);
  text('ripple-schema', hours.schemaHours);
  text('ripple-summary', hoursLine(hours.display));
  text('ripple-estimate', formatFee(estimate(pricing)));
  text('ripple-delta', `${difference > 0 ? '+' : ''}${formatFee(difference)} vs. live site`);
  text('ripple-late-fee', formatFee(pricing.lateCancellationFee));
  for (const cell of rateCells) {
    cell.textContent = formatFee(pricing[cell.dataset.rate as keyof Draft['pricing']]);
  }
}

function renderCarrierLists() {
  const { carriers } = draft.insurance;
  carrierChips.replaceChildren(...carriers.map(({ name }, index) => {
    const chip = element('li', '', 'chip');
    const remove = element('button', '×');
    remove.type = 'button';
    remove.dataset.carrierIndex = String(index);
    remove.setAttribute('aria-label', `Remove ${name}`);
    chip.append(element('span', name), remove);
    return chip;
  }));
  byId('ripple-carriers').replaceChildren(...carriers.map((carrier) => element('li', carrierLabel(carrier))));
  byId('no-carriers').hidden = carriers.length > 0;
  byId('ripple-no-carriers').hidden = carriers.length > 0;
}

function renderOutputs() {
  const changes = draftChanges(draft);
  const keys = Object.keys(changes) as (keyof Draft)[];
  const changed = keys.filter((key) => changes[key].length);
  for (const ripple of receiptItems) {
    const modified = changed.includes(ripple.dataset.ripple as keyof Draft);
    ripple.querySelector<HTMLElement>('.changed')!.hidden = !modified;
    ripple.classList.toggle('modified', modified);
  }
  const count = changed.length;
  text('receipt-state', count ? `${count} ${count === 1 ? 'change' : 'changes'}` : 'Live values');
  byId('empty-slip').hidden = count > 0;
  slipChanges.replaceChildren(...changed.map((key) => {
    const group = element('section', '', 'slip-group');
    const list = element('dl', '', 'slip-list');
    for (const { label, before, after } of changes[key]) {
      const values = element('dd', '');
      const beforePill = element('span', '', 'pill before');
      const afterPill = element('span', '', 'pill mint');
      const arrow = element('span', '→');
      arrow.setAttribute('aria-hidden', 'true');
      beforePill.append(element('span', 'Before: ', 'visually-hidden'), before);
      afterPill.append(element('span', 'After: ', 'visually-hidden'), after);
      values.append(beforePill, arrow, afterPill);
      list.append(element('dt', label), values);
    }
    group.append(element('h3', collections[key]), list);
    return group;
  }));

  stamp.disabled = !count || invalidFields.size > 0;
  stamp.removeAttribute('data-approved');
  stamp.removeAttribute('aria-disabled');
  stampStatus.textContent = '';
  copy.disabled = true;
  copyStatus.textContent = '';

  const { hours, pricing, waitlist, insurance } = draft;
  text('facts-snippet', JSON.stringify({ hours, pricing, waitlist }, null, 2));
  text('insurance-snippet', JSON.stringify(insurance, null, 2));
  prompt.value = count ? 'Stamp the Change Slip to create an approval receipt for the agent.' : '';
}

function refresh() {
  renderReceipt();
  renderOutputs();
}

function updateWaitlist() {
  const label = cta.value.trim();
  if (!label) {
    invalidFields.add(cta);
    setError(cta, byId('cta-error'), 'Enter a contact button label.');
  } else {
    invalidFields.delete(cta);
    setError(cta, byId('cta-error'));
  }
  draft.waitlist = {
    acceptingNewClients: accepting.checked,
    ctaLabel: label || draft.waitlist.ctaLabel,
    contactPageTitle: contactTitle(accepting.checked),
  };
  refresh();
}

accepting.addEventListener('change', () => {
  const previousDefault = contactLabel(!accepting.checked);
  if (!cta.value.trim() || cta.value.trim() === previousDefault) cta.value = contactLabel(accepting.checked);
  updateWaitlist();
});
cta.addEventListener('input', updateWaitlist);

function updateTimeOptions() {
  for (const option of start.options) option.disabled = option.value >= end.value;
  for (const option of end.options) option.disabled = option.value <= start.value;
}

function updateHours() {
  updateTimeOptions();
  const selected = dayInputs.map(({ checked }) => checked);
  if (selected.some(Boolean)) draft.hours = draftHours(selected, start.value, end.value);
  refresh();
}

for (const input of dayInputs) {
  input.addEventListener('change', () => {
    if (!input.checked && dayInputs.every((day) => !day.checked)) {
      input.checked = true;
      text('hours-error', 'Keep at least one office day selected.');
      return;
    }
    text('hours-error', '');
    updateHours();
  });
}
for (const select of [start, end]) select.addEventListener('change', updateHours);

for (const { key, input, error } of feeInputs) {
  const buttons = Array.from(input.closest('.stepper')!.querySelectorAll<HTMLButtonElement>('[data-step]'));
  function updateFee() {
    if (input.validity.valid) {
      invalidFields.delete(input);
      draft.pricing[key] = input.valueAsNumber || 0;
    } else {
      invalidFields.add(input);
    }
    setError(input, error, input.validity.valid ? '' : 'Enter $0–$500 in $5 increments.', 'fee-hint');
    for (const button of buttons) {
      button.disabled = input.validity.valid && (button.dataset.step === '-5' ? input.valueAsNumber === 0 : input.valueAsNumber === 500);
    }
    refresh();
  }

  input.addEventListener('input', updateFee);
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const next = draft.pricing[key] + Number(button.dataset.step);
      input.valueAsNumber = Math.max(0, Math.min(500, next));
      if (input.valueAsNumber === 0 || input.valueAsNumber === 500) input.focus();
      updateFee();
    });
  }
}

function matchesCarrier(carrier: Carrier, key: string) {
  return carrierKey(carrier.name) === key || carrierKey(carrier.shortLabel) === key;
}

carrierForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = carrierName.value.trim().replace(/\s+/g, ' ');
  const key = carrierKey(name);
  const { carriers } = draft.insurance;
  const error = byId('carrier-error');
  if (!key || carriers.some((carrier) => matchesCarrier(carrier, key))) {
    setError(carrierName, error, key ? 'That panel is already active.' : 'Enter a carrier name.');
    carrierName.focus();
    return;
  }

  const originalIndex = live.insurance.carriers.findIndex((carrier) => matchesCarrier(carrier, key));
  if (originalIndex < 0) {
    carriers.push({ name, shortLabel: name });
  } else {
    const followingPanel = carriers.findIndex((carrier) => {
      const index = live.insurance.carriers.findIndex(({ name }) => name === carrier.name);
      return index < 0 || index > originalIndex;
    });
    carriers.splice(followingPanel < 0 ? carriers.length : followingPanel, 0, live.insurance.carriers[originalIndex]);
  }
  carrierName.value = '';
  setError(carrierName, error);
  renderCarrierLists();
  refresh();
  carrierName.focus();
});

carrierName.addEventListener('input', () => setError(carrierName, byId('carrier-error')));
carrierChips.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-carrier-index]');
  if (!button) return;
  const index = Number(button.dataset.carrierIndex);
  draft.insurance.carriers.splice(index, 1);
  setError(carrierName, byId('carrier-error'));
  renderCarrierLists();
  refresh();
  const next = carrierChips.querySelector<HTMLButtonElement>(`[data-carrier-index="${index}"]`);
  (next ?? carrierName).focus();
});

function selectView() {
  const builder = view.querySelector<HTMLInputElement>('[value="builder"]')!.checked;
  slip.hidden = builder;
  for (const item of builderOutput) item.hidden = !builder;
}
view.addEventListener('change', selectView);

function resetDraft() {
  draft = structuredClone(live);
  invalidFields.clear();
  accepting.checked = live.waitlist.acceptingNewClients;
  cta.value = live.waitlist.ctaLabel;
  setError(cta, byId('cta-error'));
  dayInputs.forEach((input, index) => { input.checked = liveDays[index]; });
  start.value = liveStart;
  end.value = liveEnd;
  updateTimeOptions();
  text('hours-error', '');
  for (const { key, input, error } of feeInputs) {
    input.valueAsNumber = live.pricing[key];
    setError(input, error, '', 'fee-hint');
    for (const button of input.closest('.stepper')!.querySelectorAll<HTMLButtonElement>('[data-step]')) {
      button.disabled = button.dataset.step === '-5' ? input.valueAsNumber <= 0 : input.valueAsNumber >= 500;
    }
  }
  carrierName.value = '';
  setError(carrierName, byId('carrier-error'));
  renderCarrierLists();
  refresh();
}
reset.addEventListener('click', resetDraft);

function approvalDraft() {
  const { waitlist, hours, pricing, insurance } = draft;
  const changes: Record<string, unknown> = {};
  const availability: Partial<Pick<Draft['waitlist'], 'acceptingNewClients' | 'ctaLabel'>> = {};
  if (waitlist.acceptingNewClients !== live.waitlist.acceptingNewClients) availability.acceptingNewClients = waitlist.acceptingNewClients;
  if (waitlist.ctaLabel !== live.waitlist.ctaLabel) availability.ctaLabel = waitlist.ctaLabel;
  if (Object.keys(availability).length) changes.waitlist = availability;
  if (hours.schemaHours !== live.hours.schemaHours || hours.display !== live.hours.display) {
    changes.hours = {
      days: days.filter((_, index) => dayInputs[index].checked).map(({ code }) => code),
      start: start.value,
      end: end.value,
    };
  }
  const prices = fees.filter(({ key }) => live.pricing[key] !== pricing[key]);
  if (prices.length) changes.pricing = Object.fromEntries(prices.map(({ key }) => [key, pricing[key]]));
  if (JSON.stringify(insurance.carriers) !== JSON.stringify(live.insurance.carriers)) changes.insurance = { carriers: insurance.carriers };
  return { version: stamp.dataset.version, changes };
}

async function saveApproval() {
  if (savingApproval || stamp.disabled || stamp.dataset.approved === 'true') return;
  const body = JSON.stringify(approvalDraft());
  savingApproval = true;
  stamp.setAttribute('aria-disabled', 'true');
  editors.disabled = reset.disabled = view.disabled = true;
  stampStatus.textContent = 'Saving your approval…';
  try {
    const response = await fetch('/studio/api/approvals', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, redirect: 'error',
    });
    const receipt = await response.json();
    if (!response.ok) {
      stampStatus.textContent = typeof receipt.error === 'string' ? receipt.error : 'Studio could not save your approval.';
      return;
    }
    if (typeof receipt.id !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt.id)) throw new Error('Invalid approval receipt.');
    stamp.dataset.approved = 'true';
    stampStatus.textContent = `Approval saved for the agent. Receipt ${receipt.id}.`;
    prompt.value = `Run Apply Approved Draft with receipt ${receipt.id} for Graphdozer Counseling. Report the resulting diff and build status for review.`;
    copy.disabled = false;
  } catch {
    stampStatus.textContent = 'The approval service could not be reached. Your draft is ready to retry.';
  } finally {
    savingApproval = false;
    if (stamp.dataset.approved !== 'true') stamp.removeAttribute('aria-disabled');
    editors.disabled = reset.disabled = view.disabled = false;
  }
}
stamp.addEventListener('click', () => void saveApproval());

async function copyUpdate() {
  const value = prompt.value;
  try {
    await navigator.clipboard.writeText(value);
    if (prompt.value === value) copyStatus.textContent = 'Update prompt copied.';
  } catch {
    if (prompt.value !== value || prompt.closest('[hidden]')) return;
    prompt.focus();
    prompt.select();
    copyStatus.textContent = 'Copy the selected prompt manually.';
  }
}
if ('CommandEvent' in window) prompt.addEventListener('command', () => void copyUpdate());
else copy.addEventListener('click', () => void copyUpdate());

resetDraft();
view.querySelector<HTMLInputElement>('[value="therapist"]')!.checked = true;
selectView();
editors.disabled = false;
view.disabled = false;
reset.disabled = false;
