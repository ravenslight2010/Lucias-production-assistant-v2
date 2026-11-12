import * as XLSX from 'xlsx';

export function scheduleFixture(today, suffix) {
  const offset = (days) => {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const brand = `Schedule QA ${suffix}`;
  const sheet = 'Weekly schedule';
  const expected = [
    { date: today, brand, flavor: 'Cheese', casesPlanned: 120, notes: `QA customer · PO TODAY-${suffix} · Ship ${offset(1)}`, source: { sheet, row: 5 } },
    { date: offset(2), brand, flavor: 'Pepperoni alias', casesPlanned: 75, notes: `QA customer · PO FUTURE-${suffix} · Ship ${offset(3)}`, source: { sheet, row: 7 } },
    { date: offset(2), brand, flavor: 'Cheese', casesPlanned: 33, notes: '', source: { sheet, row: 8 } },
  ];
  const rows = [
    ['Production schedule'],
    [offset(-1), 'Brand', 'Flavor', 'Cases', 'Customer', 'PO', 'Ship'],
    [null, brand, 'Past-only flavor', 999, 'Do not import'],
    [today, 'Brand', 'Flavor', 'Cases', 'Customer', 'PO', 'Ship'],
    [null, brand, 'Cheese', 120, 'QA customer', `TODAY-${suffix}`, offset(1)],
    [offset(2), 'Brand', 'Flavor', 'Cases', 'Customer', 'PO', 'Ship'],
    [null, brand, 'Pepperoni alias', 75, 'QA customer', `FUTURE-${suffix}`, offset(3)],
    [null, brand, 'Cheese', 33],
  ];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheet);
  return {
    name: `schedule-${suffix}.xlsx`,
    buffer: XLSX.write(book, { bookType: 'xlsx', type: 'buffer' }),
    brand,
    expected,
  };
}

export function profileWorkbook(label) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Pizza recipe specs', label],
    ['Sauce oz / pizza', 2],
  ]), 'Product specs');
  return XLSX.write(book, { bookType: 'xlsx', type: 'buffer' });
}
