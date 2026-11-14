export const PRODUCTION_DAY_TIMEZONE = 'America/Chicago';

export function dateInTimeZone(value: string | Date, timezone: string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function formatProductionDate(date: string, timezone: string) {
  const instant = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(instant.getTime())) return date;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(instant);
}
