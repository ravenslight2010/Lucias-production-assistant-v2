import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';

const appPath = new URL('../src/App.tsx', import.meta.url);
const importsPath = new URL('../src/pages/imports.tsx', import.meta.url);
const workbookPath = new URL('../src/importing/workbook.ts', import.meta.url);

test('the real XLSX dependency is resolved only when a valid workbook is selected', async () => {
  // Generate a real XLSX in an isolated process so fixture creation cannot warm
  // this process's module cache and hide an eager import in the parser.
  const bytes = execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import * as XLSX from 'xlsx';
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['Pizza recipe specs', 'Smoke test'],
      ['Sauce oz / pizza', 2],
    ]), 'Product specs');
    process.stdout.write(XLSX.write(book, { bookType: 'xlsx', type: 'buffer' }));
  `], { cwd: new URL('..', import.meta.url), maxBuffer: 1_000_000 });
  let xlsxRequests = 0;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'xlsx') xlsxRequests++;
      return nextResolve(specifier, context);
    },
  });
  try {
    const { parseWorkbookFile } = await import(workbookPath.href);
    assert.equal(xlsxRequests, 0, 'opening the importer must not resolve XLSX');

    await assert.rejects(parseWorkbookFile(new File(['text'], 'product.csv')), /Choose an .xlsx or .xlsm workbook/);
    await assert.rejects(parseWorkbookFile(new File([], 'empty.xlsx')), /between 1 byte and 25 MB/);
    assert.equal(xlsxRequests, 0, 'rejected selections must not resolve XLSX');

    const parsed = await parseWorkbookFile(new File([bytes], 'product.xlsx'));
    assert.equal(xlsxRequests, 1, 'selecting a valid workbook must resolve XLSX');
    assert.equal(parsed.fileName, 'product.xlsx');
    assert.equal(parsed.sheetCount, 1);
    assert.deepEqual(parsed.sheets[0], {
      name: 'Product specs',
      rows: [['Pizza recipe specs', 'Smoke test'], ['Sauce oz / pizza', 2]],
    });
  } finally {
    hook.deregister();
  }
});

test('workbook parsing imports XLSX only when a selected workbook is parsed', async () => {
  const [app, imports, workbook] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(importsPath, 'utf8'),
    readFile(workbookPath, 'utf8'),
  ]);

  assert.match(app, /const ImportsPage = lazy\(\(\) => import\('@\/pages\/imports'\)\)/);
  assert.match(imports, /onChange=\{\(event\) => void chooseFile\(event\)\}/);
  assert.match(imports, /const parsed = await parseWorkbookFile\(file\)/);

  const parseStart = workbook.indexOf('export async function parseWorkbookFile(file: File)');
  const importOffset = workbook.indexOf('const XLSX = await import("xlsx");', parseStart);
  assert.notEqual(parseStart, -1, 'parseWorkbookFile should exist');
  assert.notEqual(importOffset, -1, 'XLSX should remain a dynamic import');
  assert.ok(
    workbook.indexOf('Choose an .xlsx or .xlsm workbook.', parseStart) < importOffset,
    'file type must be checked before XLSX is loaded',
  );
  assert.ok(
    workbook.indexOf('Workbook must be between 1 byte and 25 MB.', parseStart) < importOffset,
    'file size must be checked before XLSX is loaded',
  );
});

test('production run routes and status-specific lifecycle controls stay wired', async () => {
  const app = await readFile(appPath, 'utf8');

  assert.match(app, /<Route path="\/runs" component=\{\(\) => <Protected><RunsPage \/><\/Protected>\} \/>/);
  assert.match(app, /<Route path="\/runs\/:runId" component=\{\(\) => <Protected><RunDetailPage \/><\/Protected>\} \/>/);
  assert.match(app, /run\.status === 'planned' \? \[\{ action: 'start'/);
  assert.match(app, /run\.status === 'running' \? \[\{ action: 'pause'.*\{ action: 'complete'/);
  assert.match(app, /run\.status === 'paused' \? \[\{ action: 'resume'.*\{ action: 'complete'/);
  assert.match(app, /data-testid=\{`button-run-\$\{item\.action\}`\}/);
});

test('file selection retains its input before asynchronous parsing clears the React event', async () => {
  const source = await readFile(importsPath, 'utf8');
  const handler = source.slice(source.indexOf('const chooseFile ='), source.indexOf('const submit ='));
  assert.match(handler, /const input = event\.currentTarget;/);
  assert.match(handler, /const file = input\.files\?\.\[0\];/);
  assert.match(handler, /finally\s*\{\s*input\.value = '';/);
  assert.doesNotMatch(handler.slice(handler.indexOf('await parseWorkbookFile')), /event\.currentTarget/);
});
