export const studioDays = /** @type {const} */ ([
  { code: 'Mo', short: 'Mon', label: 'Monday' },
  { code: 'Tu', short: 'Tue', label: 'Tuesday' },
  { code: 'We', short: 'Wed', label: 'Wednesday' },
  { code: 'Th', short: 'Thu', label: 'Thursday' },
  { code: 'Fr', short: 'Fri', label: 'Friday' },
]);

/** @param {string} time */
export function studioHourLabel(time, selector = false) {
  const [hour, minute] = time.split(':');
  const morning = Number(hour) < 12;
  const clock = `${Number(hour) % 12 || 12}${selector || minute !== '00' ? `:${minute}` : ''}`;
  return `${clock} ${selector ? (morning ? 'AM' : 'PM') : (morning ? 'a.m.' : 'p.m.')}`;
}

/** @param {string[]} days @param {string} start @param {string} end */
export function studioHours(days, start, end) {
  const display = [];
  const schema = [];
  const selected = studioDays.map(({ code }) => days.includes(code));
  for (let index = 0; index < studioDays.length; index++) {
    if (!selected[index]) continue;
    const first = studioDays[index];
    while (selected[index + 1]) index++;
    const last = studioDays[index];
    display.push(first === last ? first.label : `${first.label}–${last.label}`);
    schema.push(first === last ? first.code : `${first.code}-${last.code}`);
  }
  return {
    display: `${display.join(', ')}, ${studioHourLabel(start)}–${studioHourLabel(end)} Eastern`,
    schemaHours: `${schema.join(',')} ${start}-${end}`,
  };
}

/** @param {{ acceptingNewClients: boolean, contactPageTitle: string }} current @param {boolean} accepting */
export function studioContactTitle(current, accepting) {
  if (accepting === current.acceptingNewClients) return current.contactPageTitle;
  return accepting ? 'Contact & Consultation | Graphdozer Counseling' : 'New Client Waitlist | Contact';
}
