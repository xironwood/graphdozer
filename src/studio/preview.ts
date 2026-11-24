import { waitlist } from '../data/availability';
import insurance from '../data/insurance.generated.json';
import { formatFee, practice } from '../data/practice';
import { studioContactTitle, studioDays, studioHourLabel, studioHours } from '../../practice-records/studio-format.mjs';

export const live = { hours: practice.hours, pricing: practice.pricing, waitlist, insurance };
export type Draft = typeof live;
export type Carrier = Draft['insurance']['carriers'][number];

export const fees = [
  { key: 'intake', label: 'Intake' },
  { key: 'individual', label: 'Individual session' },
  { key: 'couples', label: 'Couples session' },
  { key: 'lateCancellationFee', label: 'Late cancellation' },
] as const;

export const days = studioDays;
export const hourLabel = studioHourLabel;

const liveSchedule = /^(\S+) (\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(live.hours.schemaHours);
const liveDayGroups = (liveSchedule?.[1].split(',') ?? []).map((group) => {
  const [first, last = first] = group.split('-');
  return [days.findIndex(({ code }) => code === first), days.findIndex(({ code }) => code === last)];
});

export const liveDays = days.map((_, index) => liveDayGroups.some(([first, last]) => first >= 0 && index >= first && index <= last));
export const liveStart = liveSchedule?.[2] ?? '08:00';
export const liveEnd = liveSchedule?.[3] ?? '20:00';
export const times = [...new Set([
  ...Array.from({ length: 13 }, (_, index) => `${String(index + 8).padStart(2, '0')}:00`),
  liveStart,
  liveEnd,
])].sort();

export function draftHours(selected: boolean[], start: string, end: string) {
  if (start === liveStart && end === liveEnd && selected.every((active, index) => active === liveDays[index])) {
    return live.hours;
  }
  return studioHours(days.filter((_, index) => selected[index]).map(({ code }) => code), start, end);
}

export const availabilityLabel = (accepting: boolean) => accepting ? 'Books Open' : 'Waitlist Only';
export const contactLabel = (accepting: boolean) => accepting === waitlist.acceptingNewClients
  ? waitlist.ctaLabel
  : accepting ? 'Request a Free 15-Min Consult' : 'Ask About the Waitlist';
export const contactTitle = (accepting: boolean) => studioContactTitle(waitlist, accepting);

export const followUps = 11;
export const estimate = ({ intake, individual }: Draft['pricing']) => intake + followUps * individual;
export const hoursLine = (display: string) => `Office hours are ${display}.`;
export const carrierLabel = ({ name, shortLabel }: Carrier) => name === shortLabel ? name : `${name} (${shortLabel})`;
export const carrierKey = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export const collections = {
  waitlist: 'Waitlist Status',
  hours: 'Office Hours',
  pricing: 'Session Fees',
  insurance: 'Insurance Panels',
} satisfies Record<keyof Draft, string>;

type Change = { label: string; before: string; after: string };

export function draftChanges(draft: Draft) {
  const changes: Record<keyof Draft, Change[]> = { waitlist: [], hours: [], pricing: [], insurance: [] };
  function compare(key: keyof Draft, label: string, before: string, after: string) {
    if (before !== after) changes[key].push({ label, before, after });
  }

  compare('waitlist', 'Availability', availabilityLabel(waitlist.acceptingNewClients), availabilityLabel(draft.waitlist.acceptingNewClients));
  compare('waitlist', 'Contact button', waitlist.ctaLabel, draft.waitlist.ctaLabel);
  compare('hours', 'Office schedule', live.hours.display, draft.hours.display);
  for (const { key, label } of fees) compare('pricing', label, formatFee(live.pricing[key]), formatFee(draft.pricing[key]));
  const panels = ({ carriers }: Draft['insurance']) => carriers.map(carrierLabel).join(', ') || 'No active panels';
  compare('insurance', 'Active carriers', panels(live.insurance), panels(draft.insurance));
  return changes;
}
