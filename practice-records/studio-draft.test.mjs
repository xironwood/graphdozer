import assert from 'node:assert/strict';
import test from 'node:test';
import { applyStudioDraft, studioVersion } from './studio-draft.mjs';

const facts = {
  practiceName: 'Graphdozer Counseling (Sandbox Test Practice)',
  clinician: { licenseNumber: 'TEST-00000' },
  hours: { display: 'Monday–Thursday, 11 a.m.–6 p.m. Eastern', schemaHours: 'Mo-Th 11:00-18:00' },
  waitlist: { acceptingNewClients: false, ctaLabel: 'Ask About the Waitlist', contactPageTitle: 'New Client Waitlist | Contact' },
  pricing: { intake: 215, individual: 190, couples: 220, lateCancellationFee: 100, consultationMinutes: 15, consultationFee: 0 },
};
const insurance = {
  carriers: [{ name: 'BlueCross BlueShield of NC', shortLabel: 'BCBSNC' }],
  couplesPolicy: 'Couples therapy is private pay.',
};
const records = { factsText: JSON.stringify(facts), insuranceText: JSON.stringify(insurance) };
const version = studioVersion(records.factsText, records.insuranceText);
const apply = (changes) => applyStudioDraft(records, { version, changes });

test('an intake fee update preserves every other field', () => {
  assert.deepEqual(apply({ pricing: { intake: 245 } }), {
    facts: { ...facts, pricing: { ...facts.pricing, intake: 245 } }, insurance, changed: ['pricing'],
  });
});

test('a locked field rejects the entire draft even when an unlocked fee is valid', () => {
  assert.throws(() => apply({ pricing: { intake: 245 }, practiceName: 'Different Practice' }), /changes\.practiceName is locked/);
  assert.throws(() => apply({ pricing: { intake: 245, consultationFee: 25 } }), /pricing\.consultationFee is locked/);
  assert.throws(() => apply({ insurance: { carriers: [], couplesPolicy: 'Accept insurance' } }), /insurance\.couplesPolicy is locked/);
  assert.throws(() => apply({ waitlist: { acceptingNewClients: true, contactPageTitle: 'Different Practice' } }), /waitlist\.contactPageTitle is locked/);
  assert.throws(() => apply({ hours: { display: 'Custom hours' } }), /hours\.display is locked/);
  assert.throws(() => apply(JSON.parse('{"pricing":{"intake":245,"__proto__":{}}}')), /pricing\.__proto__ is locked/);
});

test('hours, titles, pricing, and insurance are derived or applied from supported fields', () => {
  const carriers = [{ name: 'NC State Health Plan', shortLabel: 'NC State Health Plan' }];
  const result = apply({
    hours: { days: ['Fr', 'Mo', 'Th', 'We'], start: '11:00', end: '16:00' },
    waitlist: { acceptingNewClients: true, ctaLabel: 'Request a Free 15-Min Consult' },
    pricing: { intake: 0, individual: 500, couples: 225, lateCancellationFee: 155 },
    insurance: { carriers },
  });
  assert.deepEqual(result.changed, ['waitlist', 'hours', 'pricing', 'insurance']);
  assert.deepEqual(result.facts.hours, { display: 'Monday, Wednesday–Friday, 11 a.m.–4 p.m. Eastern', schemaHours: 'Mo,We-Fr 11:00-16:00' });
  assert.deepEqual(result.facts.waitlist, { acceptingNewClients: true, ctaLabel: 'Request a Free 15-Min Consult', contactPageTitle: 'Contact & Consultation | Graphdozer Counseling' });
  assert.deepEqual(result.facts.pricing, { ...facts.pricing, intake: 0, individual: 500, couples: 225, lateCancellationFee: 155 });
  assert.deepEqual(result.insurance, { carriers, couplesPolicy: insurance.couplesPolicy });
});

test('invalid amounts, times, labels, and duplicate carrier aliases are rejected', () => {
  assert.throws(() => apply({ pricing: { intake: 503 } }), /pricing\.intake/);
  assert.throws(() => apply({ pricing: { intake: '245' } }), /pricing\.intake/);
  assert.throws(() => apply({ pricing: { intake: 241 } }), /pricing\.intake/);
  assert.throws(() => apply({ hours: { days: ['Mo'], start: '20:00', end: '08:00' } }), /start before end/);
  assert.throws(() => apply({ hours: { days: ['Sa'], start: '08:00', end: '20:00' } }), /unique weekdays/);
  assert.throws(() => apply({ waitlist: { ctaLabel: 'Request a consult\n# Another title' } }), /single-line plain text/);
  assert.throws(() => apply({ insurance: { carriers: [...insurance.carriers, { name: 'bcbsnc', shortLabel: 'bcbsnc' }] } }), /Duplicate carrier/);
});

test('an old version cannot overwrite a newer record', () => {
  const newer = { ...records, insuranceText: JSON.stringify({ ...insurance, carriers: [] }) };
  assert.throws(() => applyStudioDraft(newer, { version, changes: { pricing: { intake: 245 } } }), /changed since this draft started/);
});

test('a matching draft produces no changes', () => {
  assert.deepEqual(apply({ pricing: { intake: 215 }, insurance: { carriers: insurance.carriers } }).changed, []);
});
