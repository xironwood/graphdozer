import facts from './website-facts.generated.json';

export const practice = facts;
export const displayName = practice.practiceName.replace(/\s*\(Sandbox Test Practice\)$/, '');
export const siteTitle = practice.isSandboxTestSite ? `${displayName} — Sandbox` : displayName;
export const telehealthBoundary = `Telehealth is limited to clients physically located in ${practice.location.telehealthStates.join(', ')} at the time of a session.`;

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export const formatFee = (amount: number) => dollars.format(amount);
