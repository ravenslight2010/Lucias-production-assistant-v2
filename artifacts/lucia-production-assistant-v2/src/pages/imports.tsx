import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowDownToLine, ChevronDown, CircleAlert, FileSpreadsheet,
  GitMerge, LoaderCircle, Pencil, RefreshCw, ShieldCheck, Upload,
} from 'lucide-react';
import {
  getListProductProfilesQueryKey,
  getGetNameLibraryQueryKey,
  getListImportBatchesQueryKey,
  getListRunsQueryKey,
  useImportProductProfile,
  useImportSchedule,
  useListProductProfiles,
  useListImportBatches,
  useMergeProductProfile,
  useRenameProductProfile,
} from '@workspace/api-client-react';
import type { NameResolution, ProductProfile, ProductProfileNameMapping, ProductProfileImportInput, RunPlanningReview, RunRequirementsPlan, ScheduleImportInput } from '@workspace/api-client-react';
import { NameLibraryPanel } from '../components/name-library';
import { RunRequirementsEditor } from '../components/run-requirements';
import { indexProductNames, productNameKey as scheduleProductKey } from '../importing/product-names';
import { resolveReferenceName } from '../importing/reference-names';
import { OperationalSetupSummary } from '../components/operational-setup-summary';
import { ProductSpecSummary } from '../components/product-spec-summary';
import {
  normalizeShippingBrand,
  parseOperationalWorkbook,
  type OperationalImportKind,
  type OperationalWorkbookData,
} from '../importing/operational';
import {
  isProductSpecIngredientRole,
  isUnrecognizedApplicatorLabel,
  parseProductSpecData,
  productSpecRoleKey,
  type ProductSpecData,
  type ProductSpecIngredientRole,
  type ProductSpecRoleOverrides,
} from '../importing/product-spec';
import { doughPortionChoices, scopeDoughWorkbook } from '../importing/dough';
import { cheeseRecipeChoices, scopeCheeseWorkbook } from '../importing/cheese';
import { sauceIssueCount } from '../importing/sauce';
import { premixIssueCount } from '../importing/premix';
import { scopeShippingWorkbook, shippingChoices } from '../importing/shipping';
import {
  IMPORT_KINDS,
  parseProductSpecProfiles,
  parseScheduleWorkbook,
  parseWorkbookFile,
  type ImportKind,
  type ParsedWorkbook,
  type ProductSpecProfileCandidate,
} from '../importing/workbook';
import './imports.css';

const kindLabels: Record<ImportKind, string> = {
  product_specs: 'Product specifications',
  premix: 'Premix',
  cheese: 'Cheese',
  shipping: 'Shipping',
  sauce_guide: 'Sauce guide',
  dough_guide: 'Dough guide',
  schedule: 'Production schedule',
};

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function errorStatus(error: unknown) {
  return error && typeof error === 'object' && 'status' in error ? (error as { status?: number }).status : undefined;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isOperationalKind(kind: ImportKind | ''): kind is OperationalImportKind {
  return kind === 'premix' || kind === 'cheese' || kind === 'shipping' || kind === 'sauce_guide' || kind === 'dough_guide';
}

function toSparseWorkbook(workbook: ParsedWorkbook, selectedSheetNames?: string[]) {
  const selected = selectedSheetNames ? new Set(selectedSheetNames) : null;
  return {
    format: 'lucia.workbook.sparse.v1',
    sheets: workbook.sheets.filter((sheet) => !selected || selected.has(sheet.name)).map((sheet) => ({
      name: sheet.name,
      cells: sheet.rows.flatMap((row, rowIndex) => row.flatMap((value, columnIndex) =>
        value === null || value === '' ? [] : [{ r: rowIndex, c: columnIndex, v: value }],
      )),
    })),
  };
}

function operationalProductData(workbook: ParsedWorkbook, kind: OperationalImportKind, selectedSheetNames: string[], reviewedData?: OperationalWorkbookData) {
  const structured: OperationalWorkbookData = reviewedData ?? parseOperationalWorkbook(workbook, kind, selectedSheetNames);
  return {
    ...toSparseWorkbook(workbook, selectedSheetNames),
    structured,
  };
}

function shippingProductData(workbook: ParsedWorkbook, selectedSheetNames: string[], key: string, brand: string, flavor: string) {
  const structured = scopeShippingWorkbook(
    parseOperationalWorkbook(workbook, 'shipping', selectedSheetNames),
    key, brand, flavor,
  );
  const matchingRows = new Map(structured.sheets.map((sheet) => [sheet.name, new Set(sheet.shippingRecords.map((record) => record.sourceRow - 1))]));
  const rawSheets = workbook.sheets
    .filter((sheet) => selectedSheetNames.includes(sheet.name))
    .map((sheet) => {
      const keepRows = matchingRows.get(sheet.name) ?? new Set<number>();
      for (const record of structured.sheets.find(s => s.name === sheet.name)?.shippingRecords ?? []) {
        if (record.shipping) keepRows.add(record.shipping.headerRow - 1);
      }
      return {
        name: sheet.name,
        cells: sheet.rows.flatMap((row, rowIndex) => keepRows.has(rowIndex)
          ? row.flatMap((value, columnIndex) =>
            value === null || value === '' ? [] : [{ r: rowIndex, c: columnIndex, v: value }],
          )
          : [],
        ),
      };
    });
  return {
    format: 'lucia.workbook.sparse.v1',
    sheets: rawSheets,
    structured,
  };
}

type ProductSpecDraft = ProductSpecProfileCandidate & {
  extracted?: ProductSpecData;
  roleOverrides?: ProductSpecRoleOverrides;
  saveState?: 'saving' | 'saved' | 'failed';
  saveError?: string;
};

type SchedulePlanningReview = {
  targetCases: number;
  review: RunPlanningReview;
  status: RunRequirementsPlan['status'];
};

function prepareProductSpecDrafts(workbook: ParsedWorkbook): ProductSpecDraft[] {
  return parseProductSpecProfiles(workbook).map((candidate) => ({
    ...candidate,
    roleOverrides: {},
    extracted: parseProductSpecData(workbook, candidate, {}),
  }));
}

const productSpecRoleLabels: Record<ProductSpecIngredientRole, string> = {
  sauce: 'Sauce (±0.05 oz)',
  pep_applicator: 'Pep applicator (±0.05 oz)',
  cheese_applicator: 'Cheese applicator (±0.1 oz)',
  ingredient: 'Ordinary ingredient (±0.1 oz)',
};

const visualPreviewWorkbook: ParsedWorkbook = {
  fileName: 'Sample_Pizza_Recipe_Specs.xlsx',
  sizeBytes: 16_384,
  sheetCount: 1,
  cellCount: 38,
  kind: 'product_specs',
  kindConfidence: 'high',
  sheets: [{
    name: '12-inch retail',
    rows: [
      ['Sample Brand', 'Classic Cheese'],
      ['Crust', 8.2],
      ['Sauce', 3.1],
      ['Applicator - Unmapped sample', 0.2],
      ['Cheese', 5.4],
      ['TARGET WEIGHT', 16.7],
      ['WEIGHT SPEC RANGE', '16.2–17.2'],
      [],
      ['Sample Brand', 'Pepperoni'],
      ['Crust', 8.2],
      ['Sauce', 3.1],
      ['Cheese', 4.8],
      ['TARGET WEIGHT', 16.1],
      ['WEIGHT SPEC RANGE', '15.6–16.6'],
      [],
      ['Sample Brand', 'Garden Vegetable'],
      ['Crust', 8.2],
      ['Sauce', 3.1],
      ['Vegetables', 4.6],
      ['TARGET WEIGHT', 15.9],
      ['WEIGHT SPEC RANGE', '15.4–16.4'],
    ],
  }],
};

const visualPreviewProducts = prepareProductSpecDrafts(visualPreviewWorkbook);

const visualOperationalWorkbook: ParsedWorkbook = {
  fileName: 'Sample_Premix_Sheets.xlsx',
  sizeBytes: 18_240,
  sheetCount: 2,
  cellCount: 46,
  kind: 'premix',
  kindConfidence: 'high',
  sheets: [
    {
      name: 'Sample Brand',
      rows: [
        ['Sample Brand Premix', null, null, '# OF MIXES', null, '***Pull 3 Days Early***'],
        ['Ingredient', 'Per Pizza (oz)', 'Per Batch (lbs)', 2, null, null, 'Per Pizza (oz)', 'Per Batch (lbs)', 'Total Needed'],
        ['Flour blend', 0.15, 12, null, null, 'Garlic sauce', 2, 80, '2 Buckets'],
        ['Seasoning', 0.01, 0.8],
        ['Total', 0.16, 12.8],
        ['Mixes', 2],
        ['PULL FOR MIX'],
        ['Flour blend', 24, 'POUNDS'],
        ['***PUT AN EGG ALLERGEN STICKER ON EVERY BOX***'],
        ['ADD SEASONING'],
        ['MIX 10-15 MIN'],
        ['***PULL OLD MIX 2 DAYS PRIOR***'],
      ],
    },
    {
      name: 'Sample Brand - Pepperoni',
      rows: [
        ['Pepperoni Premix'],
        ['Ingredient', 'Per Pizza (oz)', 'Per Batch (lbs)'],
        ['Flour blend', 0.16, 12.8],
        ['Seasoning', 0.02, 1.6],
        ['Total', 0.18, 14.4],
      ],
    },
  ],
};

const visualOperationalPreview: OperationalWorkbookData = {
  ...parseOperationalWorkbook(visualOperationalWorkbook, 'premix', ['Sample Brand']),
  premixReview: { reviewedAsReference: true },
};

const visualShippingWorkbook: ParsedWorkbook = {
  fileName: 'Sample_Shipping_Guide.xlsx', sizeBytes: 2048, cellCount: 39, sheetCount: 1,
  kind: 'shipping', kindConfidence: 'high',
  sheets: [{ name: 'Palletizing', rows: [
    ['Shipping and palletizing — synthetic sample'],
    ['PIZZA', 'BOX', 'DIMENSIONS', 'CIRCLE', 'PIZZAS/CS', 'CASES', 'GRIPSHEEETS', 'PALLET TYPE', 'STACKING', 'FILM', 'PALLET HEIGHT'],
    ['Sample Brand', '11" carton shipper', '22 x 11 x 8', '11"', 12, 54, 'X', 'No Blue', 'Column', '16"', '80"'],
    ['Sample Brand multipack', '2-pack shipper', '15 x 12 x 12', '12"', '6 - 2PACK', 54, 'X', 'Block', 'Column', '16"', null],
  ] }],
};
const visualShippingData = parseOperationalWorkbook(visualShippingWorkbook, 'shipping');
const visualShippingPreview = scopeShippingWorkbook(visualShippingData, shippingChoices(visualShippingData)[0].key, 'Sample Brand', 'Classic');
const visualShippingProfiles: ProductProfile[] = [{
  id: '00000000-0000-4000-8000-000000000001', brand: 'Sample Brand', flavor: 'Classic', revision: 0,
  productData: {}, mergedIntoId: null, createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z',
}];

const visualDoughWorkbook: ParsedWorkbook = {
  fileName: 'Sample_Dough_Mixing_Procedure.xlsx',
  sizeBytes: 4_096, sheetCount: 1, cellCount: 25,
  kind: 'dough_guide', kindConfidence: 'high',
  sheets: [{ name: 'Dough procedure', rows: [
    ['Sample Dough', null, 'Revision 1'],
    ['Sample Brand: Cheese, Pepperoni'],
    [null, 'LBS.'],
    ['Flour', 10],
    ['Water', 9],
    ['Total', 19],
    ['1. SET WATER TO 10 LBS & TEMP TO 115'],
    ['2. Mix until smooth'],
    [null, 'OZ.', 'LBS.', 'YIELD', 'PER TRAY'],
    ['Classic', 6, 0.375, 50.6666666667, 24],
    ['Heavy', 10, 0.625, 30.4, 16],
    ['Keep the source discrepancy visible until the recipe owner resolves it.'],
  ] }],
};
const visualDoughPreview = parseOperationalWorkbook(visualDoughWorkbook, 'dough_guide');

const visualCheeseWorkbook: ParsedWorkbook = {
  fileName: 'Sample_Cheese_Mix_Recipes.xlsx', sizeBytes: 4096, sheetCount: 2, cellCount: 40,
  kind: 'cheese', kindConfidence: 'high',
  sheets: [
    { name: 'Sample Customer A', rows: [
      ['Sample cheese', null, 'Revision 1'],
      ['Cheese Shredder Setting: #2'],
      ['Pepperoni: Shared Cheese Mix'],
      ['Shared Cheese Mix', null, null, 'Shared Cheese Mix'],
      ['For 1st Cheese Applicator', null, null, 'For 2nd Cheese Applicator'],
      [null, 'LBS', null, null, 'LBS'],
      ['Mozzarella', 20, null, 'Mozzarella', 30],
      ['Cellulose', 0.3, null, 'Cellulose', 0.3],
      ['Total', 20.3, null, 'Total', 31.3],
      [null, 'LBS', null, null, 'LBS'],
      ['Cellulose', 0.3, null, 'Cellulose', 0.3],
      ['Percent', 1.48, null, 'Percent', 0.96],
    ] },
    { name: 'Sample Customer B', rows: [
      ['Shared Cheese Mix'], [null, 'LBS'], ['Mozzarella', 40], ['Total', 40],
    ] },
  ],
};
const visualCheeseData = parseOperationalWorkbook(visualCheeseWorkbook, 'cheese', ['Sample Customer A']);
const visualCheesePreview = scopeCheeseWorkbook(visualCheeseData, cheeseRecipeChoices(visualCheeseData).map(c => c.key), true);

const visualSauceWorkbook: ParsedWorkbook = {
  fileName: 'Sample_Sauce_Procedure.xlsx', sizeBytes: 4096, sheetCount: 1, cellCount: 25,
  kind: 'sauce_guide', kindConfidence: 'high',
  sheets: [{ name: 'Sauce procedure', rows: [
    ['Sample Sauce Procedure', null, 'Revision 1'],
    ['MATERIALS'], ['Sauce barrel'], ['Scale'], [],
    ['DRUM BATCH', 'Full', 'Half'],
    ['Water', 23, 11.5, 'Add 2 pounds if preparing a day prior'],
    ['Sauce mix', 4, 2],
    ['TOTAL WEIGHT', 27, 13.5], [],
    ['1. Set water to 25 and fill barrel'],
    ['2. Mix thoroughly'],
    ['3. If sauce is too thick, have a supervisor review consistency.'],
  ] }],
};
const visualSaucePreview = {
  ...parseOperationalWorkbook(visualSauceWorkbook, 'sauce_guide'),
  sauceReview: { reviewedAsReference: true },
};

function toProductSpecData(workbook: ParsedWorkbook, draft: ProductSpecDraft) {
  const candidate = {
    ...draft,
    brand: draft.brand.trim(),
    flavor: draft.flavor.trim(),
  };
  const roleOverrides = draft.roleOverrides ?? {};
  return {
    ...toSparseWorkbook(workbook),
    selectedProduct: {
      brand: candidate.brand,
      ...(draft.sourceBrand ? { sourceBrand: draft.sourceBrand } : {}),
      flavor: candidate.flavor,
      sections: draft.sections,
      roleOverrides,
    },
    structured: parseProductSpecData(workbook, candidate, roleOverrides),
  };
}

function refreshProfileLibraries(client: QueryClient) {
  void client.invalidateQueries({ queryKey: getListProductProfilesQueryKey() });
  void client.invalidateQueries({ queryKey: getGetNameLibraryQueryKey() });
}

async function sha256(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function WorkbookReview({
  profiles,
  nameMappings = [],
  referenceNames,
  profilesReady,
  previewMode = false,
  initialWorkbook,
}: {
  profiles: ProductProfile[];
  nameMappings?: ProductProfileNameMapping[];
  referenceNames?: NameResolution;
  profilesReady: boolean;
  previewMode?: boolean;
  initialWorkbook?: ParsedWorkbook;
}) {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);
  const client = useQueryClient();
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(() => initialWorkbook ?? null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [doughPortionKey, setDoughPortionKey] = useState('');
  const [doughBatchColumn, setDoughBatchColumn] = useState(0);
  const [doughReviewConfirmed, setDoughReviewConfirmed] = useState(false);
  const [cheeseKeys, setCheeseKeys] = useState<string[]>(() =>
    initialWorkbook?.kind === 'cheese'
      ? cheeseRecipeChoices(parseOperationalWorkbook(initialWorkbook, 'cheese', initialWorkbook.sheets.slice(0, 1).map(s => s.name))).map(c => c.key)
      : [],
  );
  const [cheeseReviewConfirmed, setCheeseReviewConfirmed] = useState(false);
  const [sauceReviewConfirmed, setSauceReviewConfirmed] = useState(false);
  const [premixReviewConfirmed, setPremixReviewConfirmed] = useState(false);
  const [kind, setKind] = useState<ImportKind | ''>(() => initialWorkbook?.kind ?? '');
  const [selectedOperationalSheets, setSelectedOperationalSheets] = useState<string[]>(() =>
    initialWorkbook && isOperationalKind(initialWorkbook.kind ?? '')
      ? initialWorkbook.sheets.slice(0, 1).map((sheet) => sheet.name)
      : [],
  );
  const [sheetFilter, setSheetFilter] = useState('');
  const [brand, setBrand] = useState('');
  const [flavor, setFlavor] = useState('');
  const [shippingImportStates, setShippingImportStates] = useState<Record<string, { status: 'saving' | 'saved' | 'failed'; error?: string }>>({});
  const [shippingProfileChoices, setShippingProfileChoices] = useState<Record<string, string>>({});
  const [productSpecDrafts, setProductSpecDrafts] = useState<ProductSpecDraft[]>(() =>
    initialWorkbook?.kind === 'product_specs' ? prepareProductSpecDrafts(initialWorkbook) : [],
  );
  const [parseError, setParseError] = useState('');
  const [validation, setValidation] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [scheduleVisibleRows, setScheduleVisibleRows] = useState(50);
  const [scheduleImportDate, setScheduleImportDate] = useState('');
  const importer = useImportProductProfile({ request: { credentials: 'include' } });
  const scheduleImporter = useImportSchedule({ request: { credentials: 'include' } });
  const schedulePreview = useMemo(
    () => workbook && kind === 'schedule' ? parseScheduleWorkbook(workbook, scheduleImportDate) : null,
    [workbook, kind, scheduleImportDate],
  );
  const scheduleProducts = useMemo(() => {
    const groups = new Map<string, { key: string; brand: string; flavor: string; rows: number }>();
    for (const run of schedulePreview?.runs ?? []) {
      const key = scheduleProductKey(run.brand, run.flavor);
      const existing = groups.get(key);
      if (existing) existing.rows++;
      else groups.set(key, { key, brand: run.brand, flavor: run.flavor, rows: 1 });
    }
    return [...groups.values()].sort((a, b) => a.brand.localeCompare(b.brand) || a.flavor.localeCompare(b.flavor));
  }, [schedulePreview]);
  const unscopedOperationalPreview = useMemo(
    () => workbook && isOperationalKind(kind)
      ? parseOperationalWorkbook(workbook, kind, selectedOperationalSheets)
      : null,
    [workbook, kind, selectedOperationalSheets],
  );
  const doughChoices = useMemo(() => doughPortionChoices(unscopedOperationalPreview), [unscopedOperationalPreview]);
  const doughChoice = doughChoices.find(choice => choice.key === doughPortionKey)
    ?? (doughChoices.length === 1 ? doughChoices[0] : null);
  const selectedDoughBatch = doughChoice?.batches.find(batch => batch.column === doughBatchColumn)
    ?? (doughChoice?.batches.length === 1 ? doughChoice.batches[0] : null);
  const doughScopedPreview = useMemo(() =>
    workbook && unscopedOperationalPreview && doughChoice && selectedDoughBatch
      ? scopeDoughWorkbook(workbook, unscopedOperationalPreview, doughChoice.key, selectedDoughBatch.column)
      : unscopedOperationalPreview,
  [workbook, unscopedOperationalPreview, doughChoice, selectedDoughBatch]);
  const cheeseChoices = useMemo(() => cheeseRecipeChoices(unscopedOperationalPreview), [unscopedOperationalPreview]);
  const validCheeseKeys = useMemo(() => cheeseKeys.filter(key => cheeseChoices.some(choice => choice.key === key)), [cheeseKeys, cheeseChoices]);
  const operationalPreview = useMemo(() =>
    kind === 'cheese' && unscopedOperationalPreview && validCheeseKeys.length
      ? scopeCheeseWorkbook(unscopedOperationalPreview, validCheeseKeys)
      : doughScopedPreview,
  [kind, unscopedOperationalPreview, validCheeseKeys, doughScopedPreview]);
  const cheeseIssueCount = kind === 'cheese' && validCheeseKeys.length
    ? operationalPreview?.sheets.reduce((sum, sheet) => sum + sheet.recipes.reduce((n, r) => n + (r.cheese?.issues.length ?? 0), 0), 0) ?? 0
    : 0;
  useEffect(() => {
    if (!previewMode) {
      setCheeseKeys([]);
      setCheeseReviewConfirmed(false);
    }
  }, [workbook, kind, selectedOperationalSheets, previewMode]);
  useEffect(() => { setCheeseReviewConfirmed(false); }, [cheeseKeys]);
  useEffect(() => { setSauceReviewConfirmed(false); }, [unscopedOperationalPreview]);
  useEffect(() => { setPremixReviewConfirmed(false); }, [unscopedOperationalPreview]);
  useEffect(() => {
    setShippingImportStates({});
    setShippingProfileChoices({});
  }, [unscopedOperationalPreview]);
  const sauceReviewIssueCount = kind === 'sauce_guide' ? sauceIssueCount(operationalPreview) : 0;
  const premixReviewIssueCount = kind === 'premix' ? premixIssueCount(operationalPreview) : 0;
  const doughReviewIssueCount = kind === 'dough_guide'
    ? operationalPreview?.sheets.reduce((count, sheet) =>
      count + sheet.recipes.reduce((sum, recipe) => sum + (recipe.dough?.issues.length ?? 0), 0), 0) ?? 0
    : 0;
  useEffect(() => {
    setDoughReviewConfirmed(false);
  }, [workbook, kind, selectedOperationalSheets, doughPortionKey, doughBatchColumn]);
  const visibleOperationalSheets = useMemo(() => {
    const query = sheetFilter.trim().toLocaleLowerCase();
    return workbook?.sheets.filter((sheet) => !query || sheet.name.toLocaleLowerCase().includes(query)) ?? [];
  }, [workbook, sheetFilter]);
  const operationalSheetCellCounts = useMemo(
    () => new Map((workbook?.sheets ?? []).map((sheet) => [
      sheet.name,
      sheet.rows.reduce<number>((count, row) =>
        count + row.reduce<number>((rowCount, value) => rowCount + Number(value !== null && value !== ''), 0),
      0),
    ])),
    [workbook],
  );
  const [scheduleProfileChoices, setScheduleProfileChoices] = useState<Record<string, string>>({});
  const [schedulePlanningReviews, setSchedulePlanningReviews] = useState<Record<string, SchedulePlanningReview>>({});
  const [schedulePlanningOpenProfileId, setSchedulePlanningOpenProfileId] = useState<string | null>(null);
  const activeProfileByProduct = useMemo(
    () => indexProductNames(profiles, nameMappings, referenceNames?.rules),
    [profiles, nameMappings, referenceNames],
  );
  const availableShippingChoices = useMemo(() => operationalPreview && kind === 'shipping' ? shippingChoices(operationalPreview) : [], [operationalPreview, kind]);
  const shippingBrandKey = (name: string) => normalizeShippingBrand(resolveReferenceName(
    { kind: 'brand', brand: '', name }, referenceNames?.rules ?? [],
  ).name);
  const shippingProfileRows = useMemo(() => {
    if (kind !== 'shipping' || !operationalPreview) return [];
    return profiles
      .filter((profile) => !profile.mergedIntoId)
      .map(profile => {
        const brands = new Set([profile.brand, ...nameMappings.filter(mapping => mapping.profileId === profile.id).map(mapping => mapping.brand)].map(shippingBrandKey));
        const exact = availableShippingChoices.filter(c => brands.has(shippingBrandKey(c.record.brand)));
        const key = shippingProfileChoices[profile.id] ?? (exact.length === 1 ? exact[0].key : '');
        return { profile, key, choice: availableShippingChoices.find(c => c.key === key) };
      });
  }, [kind, operationalPreview, profiles, nameMappings, referenceNames, availableShippingChoices, shippingProfileChoices]);
  const shippingTargets = shippingProfileRows.filter(row => row.choice);
  const shippingPendingCount = shippingTargets.filter(
    ({ profile }) => shippingImportStates[profile.id]?.status !== 'saved',
  ).length;
  const shippingScopeLocked = shippingTargets.some(
    ({ profile }) => shippingImportStates[profile.id]?.status === 'saved',
  );
  const shippingBrandsWithoutProfiles = useMemo(() => {
    if (kind !== 'shipping' || !operationalPreview) return [];
    const brands = new Map<string, { brand: string; rowCount: number }>();
    for (const sheet of operationalPreview.sheets) {
      for (const record of sheet.shippingRecords) {
        const key = normalizeShippingBrand(record.brand);
        const existing = brands.get(key);
        if (existing) existing.rowCount++;
        else brands.set(key, { brand: record.brand, rowCount: 1 });
      }
    }
    return [...brands.values()].filter((shippingBrand) =>
      !profiles.some((profile) => !profile.mergedIntoId && (
        shippingBrandKey(profile.brand) === shippingBrandKey(shippingBrand.brand) ||
        nameMappings.some(mapping => mapping.profileId === profile.id && shippingBrandKey(mapping.brand) === shippingBrandKey(shippingBrand.brand))
      )),
    );
  }, [kind, operationalPreview, profiles, nameMappings, referenceNames]);
  const resolvedScheduleProducts = scheduleProducts.map((product) => {
    const chosenId = scheduleProfileChoices[product.key] ?? activeProfileByProduct.get(product.key)?.id ?? '';
    return { ...product, chosenId, selectedProfile: profiles.find((profile) => profile.id === chosenId) };
  });
  const hasScheduleMappings = profilesReady && resolvedScheduleProducts.length > 0 && resolvedScheduleProducts.every((product) => Boolean(product.selectedProfile));
  const schedulePlanningGroups = (() => {
    const profileByProduct = new Map(
      resolvedScheduleProducts.flatMap((product) => product.selectedProfile
        ? [[product.key, product.selectedProfile] as const]
        : []),
    );
    const groups = new Map<string, {
      profile: ProductProfile;
      cases: number;
      runs: number;
      sourceProducts: Set<string>;
    }>();
    for (const run of schedulePreview?.runs ?? []) {
      const profile = profileByProduct.get(scheduleProductKey(run.brand, run.flavor));
      if (!profile) continue;
      const group = groups.get(profile.id) ?? {
        profile,
        cases: 0,
        runs: 0,
        sourceProducts: new Set<string>(),
      };
      group.cases += run.casesPlanned;
      group.runs++;
      group.sourceProducts.add(`${run.brand} / ${run.flavor || 'No flavor listed'}`);
      groups.set(profile.id, group);
    }
    return [...groups.values()].map((group) => ({
      ...group,
      sourceProducts: [...group.sourceProducts].sort((a, b) => a.localeCompare(b)),
    })).sort((a, b) =>
      a.profile.brand.localeCompare(b.profile.brand) || a.profile.flavor.localeCompare(b.profile.flavor),
    );
  })();
  const hasCurrentScheduleReview = (profile: ProductProfile, cases: number) => {
    const saved = schedulePlanningReviews[profile.id];
    return saved?.targetCases === Math.min(cases, 1_000_000) &&
      saved.review.expectedProfileRevision === profile.revision &&
      saved.review.expectedNameRevision === (referenceNames?.revision ?? 0);
  };
  const hasSchedulePlanning = schedulePlanningGroups.length > 0 &&
    schedulePlanningGroups.length <= 100 &&
    schedulePlanningGroups.every((group) => {
      const saved = schedulePlanningReviews[group.profile.id];
      return group.cases <= 1_000_000 &&
        saved?.targetCases === group.cases &&
        saved.review.expectedProfileRevision === group.profile.revision &&
        saved.review.expectedNameRevision === (referenceNames?.revision ?? 0);
    });
  const hasProductSpecDrafts = kind === 'product_specs' && productSpecDrafts.length > 0;
  const unsavedProductSpecCount = productSpecDrafts.filter((draft) => draft.saveState !== 'saved').length;
  const profileBrand = brand;
  const profileFlavor = flavor;
  const matchingProfile = profilesReady && profileBrand.trim() && profileFlavor.trim()
    ? activeProfileByProduct.get(scheduleProductKey(profileBrand, profileFlavor))
    : undefined;

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    if (previewMode) return;
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setParseError('');
    setValidation('');
    setSavedMessage('');
    setScheduleVisibleRows(50);
    setScheduleImportDate(localDateString());
    setScheduleProfileChoices({});
    setSchedulePlanningReviews({});
    setSchedulePlanningOpenProfileId(null);
    setProductSpecDrafts([]);
    setDoughPortionKey('');
    setDoughBatchColumn(0);
    setDoughReviewConfirmed(false);
    setSelectedOperationalSheets([]);
    setShippingImportStates({});
    setShippingProfileChoices({});
    setSheetFilter('');
    setWorkbook(null);
    setSourceFile(file);
    try {
      const parsed = await parseWorkbookFile(file);
      setWorkbook(parsed);
      setKind(parsed.kind ?? '');
      setProductSpecDrafts(parsed.kind === 'product_specs' ? prepareProductSpecDrafts(parsed) : []);
      setSelectedOperationalSheets(parsed.kind && isOperationalKind(parsed.kind)
        ? parsed.sheets.slice(0, 1).map((sheet) => sheet.name)
        : []);
    } catch (error) {
      setParseError(errorText(error, 'This workbook could not be opened.'));
    } finally {
      input.value = '';
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (previewMode || !workbook || !sourceFile || !kind) return;
    if (kind === 'schedule') {
      const importDate = localDateString();
      if (scheduleImportDate !== importDate) {
        setScheduleImportDate(importDate);
        setSchedulePlanningReviews({});
        setSchedulePlanningOpenProfileId(null);
        setValidation('The import date changed after this schedule was reviewed. Review the updated rows and requirements before importing.');
        return;
      }
      setScheduleImportDate(importDate);
      const preview = parseScheduleWorkbook(workbook, importDate);
      if (preview.errors.length) {
        setValidation('Correct the flagged schedule rows in the workbook and upload it again before creating runs.');
        return;
      }
      if (!preview.runs.length) {
        setValidation(`No schedule rows dated ${importDate} or later are eligible to import.`);
        return;
      }
      if (!profilesReady) {
        setValidation('Product profiles are still loading. Wait for them to load, then review the schedule mappings.');
        return;
      }
      const profileByKey = indexProductNames(profiles, nameMappings, referenceNames?.rules);
      const mappings = new Map<string, ProductProfile>();
      for (const run of preview.runs) {
        const product = { key: scheduleProductKey(run.brand, run.flavor) };
        const id = scheduleProfileChoices[product.key] ?? profileByKey.get(product.key)?.id ?? '';
        const profile = profiles.find((candidate) => candidate.id === id);
        if (!profile) {
          setValidation('Match every scheduled brand and flavor to an active product profile before importing.');
          return;
        }
        mappings.set(product.key, profile);
      }
      const casesByProfile = new Map<string, number>();
      for (const run of preview.runs) {
        const profile = mappings.get(scheduleProductKey(run.brand, run.flavor))!;
        casesByProfile.set(profile.id, (casesByProfile.get(profile.id) ?? 0) + run.casesPlanned);
      }
      const planningByProfile: ScheduleImportInput['planningByProfile'] = [];
      for (const [profileId, cases] of casesByProfile) {
        const profile = profiles.find((candidate) => candidate.id === profileId);
        const saved = schedulePlanningReviews[profileId];
        if (
          !profile ||
          !saved ||
          saved.targetCases !== Math.min(cases, 1_000_000) ||
          saved.review.expectedProfileRevision !== profile.revision ||
          saved.review.expectedNameRevision !== (referenceNames?.revision ?? 0)
        ) {
          setSchedulePlanningOpenProfileId(profileId);
          setValidation('Review the requirements for every mapped product again before importing. Product or name changes invalidate an older review.');
          return;
        }
        planningByProfile.push({ productProfileId: profileId, review: saved.review });
      }
      if (planningByProfile.length === 0 || planningByProfile.length > 100) {
        setValidation('Review up to 100 distinct product profiles per schedule import. Split larger schedules into smaller imports.');
        return;
      }
      setValidation('');
      setSavedMessage('');
      try {
        const data: ScheduleImportInput = {
          sourceName: workbook.fileName,
          sourceHash: await sha256(sourceFile),
          importDate,
          ignoredPastCount: preview.ignoredPastCount,
          planningByProfile,
          runs: preview.runs.map((run) => ({
            date: run.date,
            brand: run.brand,
            flavor: run.flavor,
            productProfileId: mappings.get(scheduleProductKey(run.brand, run.flavor))!.id,
            casesPlanned: run.casesPlanned,
            notes: run.notes,
            source: { sheet: run.source.sheet, row: run.source.row },
          })),
        };
        scheduleImporter.mutate({ data }, {
          onSuccess: (result) => {
            setSavedMessage(result.replayed
              ? `This schedule was already imported. ${result.importedCount} planned runs are linked to it.`
              : `${result.importedCount} planned ${result.importedCount === 1 ? 'run was' : 'runs were'} created with saved requirements.${result.needsReviewRunCount ? ` ${result.needsReviewRunCount} ${result.needsReviewRunCount === 1 ? 'run has' : 'runs have'} unresolved source items to review.` : ''}${result.ignoredPastCount ? ` ${result.ignoredPastCount} past ${result.ignoredPastCount === 1 ? 'row was' : 'rows were'} ignored.` : ''}`);
            refreshProfileLibraries(client);
            void client.invalidateQueries({ queryKey: getListImportBatchesQueryKey() });
            void client.invalidateQueries({ queryKey: getListRunsQueryKey() });
          },
        });
      } catch (error) {
        setValidation(errorText(error, 'The schedule could not be prepared for import.'));
      }
      return;
    }
    if (kind === 'product_specs' && productSpecDrafts.length > 0) {
      const pendingDrafts = productSpecDrafts.filter((draft) => draft.saveState !== 'saved');
      if (!pendingDrafts.length) {
        setSavedMessage('All detected product profiles are already saved.');
        return;
      }
      if (!profilesReady) {
        setValidation('Product profiles are still loading. Wait for them to load before importing this workbook.');
        return;
      }
      const seenProfiles = new Set<string>();
      for (const draft of productSpecDrafts) {
        const cleanBrand = draft.brand.trim();
        const cleanFlavor = draft.flavor.trim();
        if (!cleanBrand || cleanBrand.length > 120 || !cleanFlavor || cleanFlavor.length > 120) {
          setValidation('Every product needs a brand and flavor, each no longer than 120 characters.');
          return;
        }
        const key = scheduleProductKey(cleanBrand, cleanFlavor);
        if (seenProfiles.has(key)) {
          setValidation(`More than one section is mapped to ${cleanBrand} / ${cleanFlavor}. Combine the workbook sections or rename one profile.`);
          return;
        }
        seenProfiles.add(key);
      }

      setValidation('');
      setSavedMessage('');
      const sourceWorkbook = toSparseWorkbook(workbook);
      if (JSON.stringify(sourceWorkbook).length > 700_000) {
        setValidation('The compact workbook data is over the 700,000-character API limit. Remove excess content from the source workbook and review it again.');
        return;
      }

      try {
        const sourceHash = await sha256(sourceFile);
        let importedCount = 0;
        let alreadySavedCount = 0;
        let failedCount = 0;
        const batchProfiles = new Map(profiles.map(profile => [profile.id, profile]));

        for (let index = 0; index < pendingDrafts.length; index++) {
          const draft = pendingDrafts[index];
          setProductSpecDrafts((current) => current.map((item) =>
            item.id === draft.id ? { ...item, saveState: 'saving', saveError: undefined } : item,
          ));
          try {
            const cleanBrand = draft.brand.trim();
            const cleanFlavor = draft.flavor.trim();
            const productData = toProductSpecData(workbook, draft);
            const productDataSize = JSON.stringify(productData).length;
            if (productDataSize > 700_000) {
              throw new Error('This profile’s source data exceeds the 700,000-character API limit.');
            }
            const matchedProfile = activeProfileByProduct.get(scheduleProductKey(cleanBrand, cleanFlavor));
            const input: ProductProfileImportInput = {
              brand: cleanBrand,
              flavor: cleanFlavor,
              sourceName: workbook.fileName,
              sourceHash,
              importKind: kind,
              productData,
              ...(matchedProfile ? { expectedRevision: batchProfiles.get(matchedProfile.id)!.revision } : {}),
            };
            if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 1_000_000) {
              throw new Error('This profile request is over the 1 MB API limit after adding source details.');
            }
            const result = await importer.mutateAsync({ data: input });
            batchProfiles.set(result.profile.id, result.profile);
            if (result.imported) importedCount++;
            else alreadySavedCount++;
            setProductSpecDrafts((current) => current.map((item) =>
              item.id === draft.id ? { ...item, saveState: 'saved', saveError: undefined } : item,
            ));
          } catch (error) {
            failedCount++;
            const message = errorStatus(error) === 409
              ? 'This profile changed elsewhere. Refresh profiles and review the latest revision before retrying.'
              : errorText(error, 'This profile could not be saved.');
            setProductSpecDrafts((current) => current.map((item) =>
              item.id === draft.id ? { ...item, saveState: 'failed', saveError: message } : item,
            ));
            if (errorStatus(error) === 429) {
              const remainingDrafts = pendingDrafts.slice(index + 1);
              failedCount += remainingDrafts.length;
              setProductSpecDrafts((current) => current.map((item) =>
                remainingDrafts.some((remaining) => remaining.id === item.id)
                  ? { ...item, saveState: 'failed', saveError: 'The facility write limit was reached. Wait briefly, then retry.' }
                  : item,
              ));
              break;
            }
          }
        }

        const savedCount = importedCount + alreadySavedCount;
        const savedDetails = [
          importedCount ? `${importedCount} new` : '',
          alreadySavedCount ? `${alreadySavedCount} already present` : '',
        ].filter(Boolean).join(', ');
        setSavedMessage(
          `${savedCount} of ${pendingDrafts.length} profiles saved${savedDetails ? ` (${savedDetails})` : ''}.${failedCount ? ` ${failedCount} failed; successful profiles will not be duplicated if you retry.` : ''}`,
        );
        refreshProfileLibraries(client);
        void client.invalidateQueries({ queryKey: getListImportBatchesQueryKey() });
      } catch (error) {
        setValidation(errorText(error, 'The workbook source could not be prepared.'));
      }
      return;
    }
    if (kind === 'shipping') {
      if (!profilesReady) {
        setValidation('Product profiles are still loading. Wait for them to load before importing this workbook.');
        return;
      }
      if (selectedOperationalSheets.length === 0) {
        setValidation('Select at least one worksheet that belongs to this shipping import.');
        return;
      }
      if (!shippingTargets.length) {
        setValidation('Choose a shipping row for at least one active product profile.');
        return;
      }
      const pendingTargets = shippingTargets.filter((target) => shippingImportStates[target.profile.id]?.status !== 'saved');
      if (!pendingTargets.length) {
        setSavedMessage('All matching product profiles already contain this shipping source.');
        return;
      }
      setValidation('');
      setSavedMessage('');
      try {
        const sourceHash = await sha256(sourceFile);
        let importedCount = 0;
        let alreadySavedCount = 0;
        let failedCount = 0;
        for (let index = 0; index < pendingTargets.length; index++) {
          const { profile } = pendingTargets[index];
          setShippingImportStates((current) => ({
            ...current,
            [profile.id]: { status: 'saving' },
          }));
          try {
            const productData = shippingProductData(workbook, selectedOperationalSheets, pendingTargets[index].key, profile.brand, profile.flavor);
            if (JSON.stringify(productData).length > 700_000) {
              throw new Error('This profile’s shipping data exceeds the 700,000-character API limit.');
            }
            const input: ProductProfileImportInput = {
              brand: profile.brand,
              flavor: profile.flavor,
              sourceName: workbook.fileName,
              sourceHash,
              importKind: 'shipping',
              productData,
              expectedRevision: profile.revision,
            };
            if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 1_000_000) {
              throw new Error('This profile request is over the 1 MB API limit after adding source details.');
            }
            const result = await importer.mutateAsync({ data: input });
            if (result.imported) importedCount++;
            else alreadySavedCount++;
            setShippingImportStates((current) => ({
              ...current,
              [profile.id]: { status: 'saved' },
            }));
          } catch (error) {
            failedCount++;
            const message = errorStatus(error) === 409
              ? 'This profile changed elsewhere. Refresh profiles and review its latest revision before retrying.'
              : errorText(error, 'This profile could not be saved.');
            setShippingImportStates((current) => ({
              ...current,
              [profile.id]: { status: 'failed', error: message },
            }));
            if (errorStatus(error) === 429) {
              const remainingTargets = pendingTargets.slice(index + 1);
              failedCount += remainingTargets.length;
              setShippingImportStates((current) => ({
                ...current,
                ...Object.fromEntries(remainingTargets.map(({ profile: remaining }) => [
                  remaining.id,
                  { status: 'failed' as const, error: 'The facility write limit was reached. Wait briefly, then retry.' },
                ])),
              }));
              break;
            }
          }
        }
        const savedCount = importedCount + alreadySavedCount;
        const savedDetails = [
          importedCount ? `${importedCount} updated` : '',
          alreadySavedCount ? `${alreadySavedCount} already present` : '',
        ].filter(Boolean).join(', ');
        setSavedMessage(
          `${savedCount} of ${pendingTargets.length} matching profiles saved${savedDetails ? ` (${savedDetails})` : ''}.${failedCount ? ` ${failedCount} failed; successful profiles will not be duplicated if you retry.` : ''}`,
        );
        refreshProfileLibraries(client);
        void client.invalidateQueries({ queryKey: getListImportBatchesQueryKey() });
      } catch (error) {
        setValidation(errorText(error, 'The shipping workbook source could not be prepared.'));
      }
      return;
    }
    const cleanBrand = brand.trim();
    const cleanFlavor = flavor.trim();
    if (!cleanBrand || cleanBrand.length > 120 || !cleanFlavor || cleanFlavor.length > 120) {
      setValidation('Brand and flavor are required and must each be 120 characters or fewer.');
      return;
    }
    if (!profilesReady) {
      setValidation('Product profiles are still loading. Wait for them to load before importing this workbook.');
      return;
    }
    if (isOperationalKind(kind) && selectedOperationalSheets.length === 0) {
      setValidation('Select at least one worksheet that belongs to this product profile.');
      return;
    }
    if (kind === 'dough_guide' && doughChoices.length > 0 && (!doughChoice || !selectedDoughBatch)) {
      setValidation('Choose the dough-ball variant and batch column for this product before saving.');
      return;
    }
    if (kind === 'dough_guide' && doughReviewIssueCount > 0 && !doughReviewConfirmed) {
      setValidation('Review the dough source discrepancies and acknowledge saving them as reference data before continuing.');
      return;
    }
    if (kind === 'cheese' && (selectedOperationalSheets.length !== 1 || !validCheeseKeys.length)) {
      setValidation('Choose one customer worksheet and explicitly select the cheese recipes needed for this product.');
      return;
    }
    if (kind === 'cheese' && cheeseIssueCount > 0 && !cheeseReviewConfirmed) {
      setValidation('Review the cheese source discrepancies and acknowledge saving them as reference data before continuing.');
      return;
    }
    if (kind === 'sauce_guide' && sauceReviewIssueCount > 0 && !sauceReviewConfirmed) {
      setValidation('Review the sauce source discrepancies and acknowledge saving them as reference data before continuing.');
      return;
    }
    if (kind === 'premix' && premixReviewIssueCount > 0 && !premixReviewConfirmed) {
      setValidation('Review the premix source details and acknowledge saving them as reference data before continuing.');
      return;
    }
    setValidation('');
    setSavedMessage('');
    try {
      const reviewedDoughData = kind === 'dough_guide' && workbook && unscopedOperationalPreview && doughChoice && selectedDoughBatch
        ? scopeDoughWorkbook(workbook, unscopedOperationalPreview, doughChoice.key, selectedDoughBatch.column, doughReviewConfirmed)
        : undefined;
      const reviewedData = kind === 'premix' && unscopedOperationalPreview
        ? { ...unscopedOperationalPreview, premixReview: { reviewedAsReference: premixReviewConfirmed } }
        : kind === 'sauce_guide' && unscopedOperationalPreview
        ? { ...unscopedOperationalPreview, sauceReview: { reviewedAsReference: sauceReviewConfirmed } }
        : kind === 'cheese' && unscopedOperationalPreview
        ? scopeCheeseWorkbook(unscopedOperationalPreview, validCheeseKeys, cheeseReviewConfirmed)
        : reviewedDoughData;
      const productData = isOperationalKind(kind)
        ? operationalProductData(workbook, kind, selectedOperationalSheets, reviewedData)
        : toSparseWorkbook(workbook);
      const productDataSize = JSON.stringify(productData).length;
      if (productDataSize > 700_000) {
        setValidation('The compact workbook data is over the 700,000-character API limit. Remove excess content from the source workbook and review it again.');
        return;
      }
      const input: ProductProfileImportInput = {
        brand: cleanBrand,
        flavor: cleanFlavor,
        sourceName: workbook.fileName,
        sourceHash: await sha256(sourceFile),
        importKind: kind,
        productData,
        ...(matchingProfile ? { expectedRevision: matchingProfile.revision } : {}),
      };
      const serializedRequestBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
      if (serializedRequestBytes > 1_000_000) {
        setValidation('This request is over the 1 MB API limit after adding its source details. Reduce the workbook content before importing.');
        return;
      }
      importer.mutate({ data: input }, {
        onSuccess: (result) => {
          setSavedMessage(result.imported
            ? matchingProfile
              ? `${workbook.fileName} was added to ${result.profile.brand} / ${result.profile.flavor}; the profile is now revision ${result.profile.revision}. Existing run snapshots stay unchanged.`
              : `${result.profile.brand} / ${result.profile.flavor} was saved as revision ${result.profile.revision}.`
            : 'This source and selection are already saved. No duplicate source or new profile revision was created.');
          refreshProfileLibraries(client);
          void client.invalidateQueries({ queryKey: getListImportBatchesQueryKey() });
        },
      });
    } catch (error) {
      setValidation(errorText(error, 'The workbook source could not be prepared.'));
    }
  };

  const updateProductSpecDraft = (id: string, update: Partial<ProductSpecDraft>) => {
    setValidation('');
    setSavedMessage('');
    setProductSpecDrafts((current) => current.map((draft) =>
      draft.id === id ? { ...draft, ...update, saveState: update.saveState ?? undefined, saveError: undefined } : draft,
    ));
  };

  const updateProductSpecRole = (
    draft: ProductSpecDraft,
    sourceKey: string,
    value: string,
  ) => {
    const roleOverrides = { ...(draft.roleOverrides ?? {}) };
    if (!value) {
      delete roleOverrides[sourceKey];
    } else if (isProductSpecIngredientRole(value)) {
      roleOverrides[sourceKey] = value;
    } else {
      setValidation('Choose one of the listed source roles.');
      return;
    }
    updateProductSpecDraft(draft.id, {
      roleOverrides,
      extracted: workbook ? parseProductSpecData(workbook, draft, roleOverrides) : draft.extracted,
    });
  };

  const addManualProductSpecDraft = () => {
    if (previewMode) return;
    setValidation('');
    setSavedMessage('');
    const id = `manual-${Date.now()}-${productSpecDrafts.length}`;
    setProductSpecDrafts((current) => [...current, {
      id,
      brand: '',
      flavor: '',
      sections: [],
    }]);
  };

  const sourcePreviewSheets = isOperationalKind(kind) && selectedOperationalSheets.length
    ? workbook?.sheets.filter((sheet) => selectedOperationalSheets.includes(sheet.name)) ?? []
    : workbook?.sheets.slice(0, 4) ?? [];

  return (
    <section className="panel import-panel" aria-labelledby="workbook-heading">
      <div className="eyebrow">Reviewed source</div>
      <h2 id="workbook-heading">Bring in setup data</h2>
      <p className="field-help" style={{ display: 'block', lineHeight: 1.6, marginBottom: 17 }}>
        Choose a workbook, inspect its source cells, then explicitly save it as a facility profile. Nothing is applied until you import.
      </p>
      <div className={previewMode ? 'upload-zone upload-zone-disabled' : 'upload-zone'}>
        <label htmlFor="workbook-file">
          <Upload size={21} aria-hidden="true" />
          <span style={{ color: 'hsl(var(--foreground))' }}>Choose an .xlsx or .xlsm workbook</span>
          <span>Up to 25 MB · workbook limits are checked during review</span>
        </label>
        <input id="workbook-file" type="file" accept=".xlsx,.xlsm" onChange={(event) => void chooseFile(event)} aria-label="Choose a product or process workbook" data-testid="input-workbook-file" disabled={previewMode} />
      </div>
      {parseError && <div className="error-banner" role="alert">{parseError}</div>}
      {workbook && <>
        <div className="workbook-preview" aria-live="polite">
          <div className="workbook-preview-head">
            <span><FileSpreadsheet size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />{workbook.fileName}</span>
            <span>{workbook.sheetCount} sheets · {workbook.cellCount.toLocaleString()} grid cells</span>
          </div>
          <div className="workbook-sheet">
            <strong>Workbook content preview</strong>
            <div className="field-help" style={{ marginTop: 4 }}>
              {isOperationalKind(kind)
                ? 'Showing the first 6 populated cells in each selected worksheet. The importer also extracts recipe, process, batch, and shipping fields for review.'
                : 'Showing the first 6 populated cells per sheet, for up to 4 sheets. Product specifications are detected separately; the compact import retains the source cells.'}
            </div>
          </div>
          {sourcePreviewSheets.map((sheet) => {
            const previewCells = sheet.rows.flatMap((row, r) => row.flatMap((value, c) =>
              value === null || value === '' ? [] : [{ r, c, value }],
            )).slice(0, 6);
            return <div className="workbook-sheet" key={sheet.name}>
              <strong>{sheet.name}</strong>
              {previewCells.length ? <div className="sheet-cells">
                {previewCells.map(({ r, c, value }) => <div className="sheet-cell" key={`${r}:${c}`}><b>R{r + 1}C{c + 1}</b><span>{String(value)}</span></div>)}
              </div> : <div className="field-help" style={{ marginTop: 7 }}>No populated cells in this worksheet.</div>}
            </div>;
          })}
          {sourcePreviewSheets.length === 0 && isOperationalKind(kind) && <div className="workbook-sheet field-help">Choose worksheets below to preview their source and extracted fields.</div>}
          {!isOperationalKind(kind) && workbook.sheets.length > 4 && <div className="workbook-sheet field-help">Preview limited to the first 4 of {workbook.sheets.length} worksheets. All source cells are retained in the compact import payload.</div>}
        </div>
        <form onSubmit={(event) => void submit(event)} noValidate>
          <div className="form-field">
            <label htmlFor="workbook-kind">Workbook type</label>
            <select id="workbook-kind" data-testid="select-workbook-kind" value={kind} disabled={previewMode} onChange={(event) => {
              const nextKind = event.target.value as ImportKind | '';
              setKind(nextKind);
              if (nextKind === 'cheese' && selectedOperationalSheets.length > 1) setSelectedOperationalSheets(selectedOperationalSheets.slice(0, 1));
              if (isOperationalKind(nextKind) && selectedOperationalSheets.length === 0 && workbook.sheets.length > 0) {
                setSelectedOperationalSheets([workbook.sheets[0].name]);
              }
              if (nextKind === 'product_specs' && workbook && !productSpecDrafts.length) {
                setProductSpecDrafts(prepareProductSpecDrafts(workbook));
              }
            }} required>
              <option value="">Select type to continue</option>
              {IMPORT_KINDS.map((item) => <option key={item} value={item}>{kindLabels[item]}{item === 'schedule' ? ' · creates planned runs' : ''}</option>)}
            </select>
            <span className="field-help">Detected: {workbook.kind ? `${kindLabels[workbook.kind]} (${workbook.kindConfidence === 'high' ? 'high confidence' : 'review suggested'})` : 'No confident type; choose one after reviewing.'}</span>
          </div>
          {isOperationalKind(kind) && <fieldset className="operational-sheet-picker">
            <legend>Choose worksheets for this profile</legend>
            <p className="field-help">Select only tabs that belong to the Brand and Flavor below. If a workbook contains different products, import those tabs separately so each run gets the right setup.</p>
            <div className="operational-sheet-actions">
              <span>{selectedOperationalSheets.length} of {workbook.sheets.length} selected</span>
              {kind !== 'cheese' && <button className="button button-quiet" type="button" onClick={() => setSelectedOperationalSheets(workbook.sheets.map((sheet) => sheet.name))} disabled={previewMode || importer.isPending || (kind === 'shipping' && shippingScopeLocked) || selectedOperationalSheets.length === workbook.sheets.length}>Select all</button>}
              <button className="button button-quiet" type="button" onClick={() => setSelectedOperationalSheets([])} disabled={previewMode || importer.isPending || (kind === 'shipping' && shippingScopeLocked) || selectedOperationalSheets.length === 0}>Clear</button>
            </div>
            {workbook.sheets.length > 12 && <div className="form-field" style={{ marginTop: 8 }}>
              <label htmlFor="operational-sheet-filter">Filter worksheets</label>
              <input id="operational-sheet-filter" type="search" maxLength={120} value={sheetFilter} onChange={(event) => setSheetFilter(event.target.value)} placeholder="Type a worksheet name" disabled={previewMode} />
            </div>}
            <div className="operational-sheet-list" role="group" aria-label="Workbook worksheets">
              {visibleOperationalSheets.map((sheet, index) => {
                const checked = selectedOperationalSheets.includes(sheet.name);
                const checkboxId = `operational-sheet-${index}-${sheet.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 30)}`;
                return <label className="operational-sheet-option" htmlFor={checkboxId} key={sheet.name}>
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={checked}
                    disabled={previewMode || (kind === 'shipping' && shippingScopeLocked)}
                    onChange={(event) => setSelectedOperationalSheets((current) =>
                      event.target.checked
                        ? kind === 'cheese' ? [sheet.name] : [...current, sheet.name]
                        : current.filter((name) => name !== sheet.name),
                    )}
                  />
                  <span>{sheet.name}</span>
                  <small>{operationalSheetCellCounts.get(sheet.name) ?? 0} populated cells</small>
                </label>;
              })}
              {visibleOperationalSheets.length === 0 && <p className="field-help">No worksheet names match that filter.</p>}
            </div>
          </fieldset>}
          {kind === 'shipping' && <div className="form-field" style={{ marginTop: 12 }}>
            <strong>Packaging variant for each product</strong>
            <span className="field-help">Choose one guide row per product, or leave it unapplied. A unique exact brand match is suggested; review its box, size and pack count before saving. Different guide labels can be mapped explicitly. Existing run snapshots stay unchanged.</span>
            {shippingScopeLocked && <span className="field-help">Worksheet selection is locked after a profile saves. Choose the workbook again to review a different selection.</span>}
            {!profilesReady && <span className="field-help" role="status">Loading active profiles…</span>}
            {profilesReady && profiles.length === 0 && <span className="field-help">Create a product profile before attaching its shipping reference.</span>}
            {profilesReady && shippingTargets.length === 0 && <span className="field-help" role="status">Choose a shipping row for at least one active profile.</span>}
            {shippingProfileRows.length > 0 && <div data-testid="shipping-profile-targets">
              {shippingProfileRows.map(({ profile, key }) => {
                const state = shippingImportStates[profile.id];
                return <div className="form-field" key={profile.id} data-testid={`shipping-target-${profile.id}`}>
                  <label htmlFor={`shipping-choice-${profile.id}`}>{profile.brand} / {profile.flavor}</label>
                  <select id={`shipping-choice-${profile.id}`} value={key} disabled={previewMode || importer.isPending || shippingScopeLocked} onChange={e => {
                    setShippingProfileChoices(current => ({ ...current, [profile.id]: e.target.value }));
                    setSavedMessage('');
                  }}>
                    <option value="">Do not apply shipping to this product</option>
                    {availableShippingChoices.map(c => <option key={c.key} value={c.key}>{c.record.brand} · {String(c.record.values.BOX ?? c.record.values.SHIPPER ?? '')} · {c.sheet} row {c.record.sourceRow}</option>)}
                  </select>
                  {state?.status === 'saving' && ' · saving'}
                  {state?.status === 'saved' && ' · saved'}
                  {state?.status === 'failed' && <> · failed: {state.error}</>}
                </div>;
              })}
            </div>}
            {shippingBrandsWithoutProfiles.length > 0 && <span className="field-help" role="status">
              Guide labels without an exact profile-brand match (map explicitly above when appropriate): {shippingBrandsWithoutProfiles.map(({ brand: unmatchedBrand }) => unmatchedBrand).join(', ')}.
            </span>}
          </div>}
          {kind !== 'schedule' && kind !== 'shipping' && !hasProductSpecDrafts && <div className="import-fields">
            <div className="form-field"><label htmlFor="profile-brand">Brand</label><input id="profile-brand" autoComplete="organization" maxLength={120} value={brand} onChange={(event) => setBrand(event.target.value)} required disabled={previewMode} /></div>
            <div className="form-field"><label htmlFor="profile-flavor">Flavor</label><input id="profile-flavor" maxLength={120} value={flavor} onChange={(event) => setFlavor(event.target.value)} required disabled={previewMode} /></div>
          </div>}
          {kind === 'cheese' && <fieldset className="operational-sheet-picker">
            <legend>Cheese recipes for this product</legend>
            <p className="field-help">
              Choose one customer tab above, then every required formula below, including separate applicator blends and sub-mixes.
              Names include the customer tab to distinguish duplicates. Source shorthand is not automatically matched or substituted.
              Saving adds a preserved source; it does not replace earlier recipe sources or change existing run snapshots.
            </p>
            <div className="operational-sheet-list">
              {cheeseChoices.map(choice => <label className="operational-sheet-option" key={choice.key}>
                <input type="checkbox" checked={validCheeseKeys.includes(choice.key)} disabled={previewMode || importer.isPending}
                  onChange={event => {
                    setCheeseKeys(current => event.target.checked ? [...current, choice.key] : current.filter(key => key !== choice.key));
                    setSavedMessage('');
                    setValidation('');
                  }} />
                <span>{choice.recipe.name}{' '}
                  <small style={{ display: 'block' }}>Row {choice.recipe.cheese?.headerRow} · column {choice.recipe.cheese?.sourceColumn}{choice.recipe.cheese?.applicator ? ` · ${choice.recipe.cheese.applicator}` : ''}</small>
                </span>
              </label>)}
              {!cheeseChoices.length && <p className="field-help">No cheese formulas were detected in the selected customer tab. Review the source before importing.</p>}
            </div>
            {cheeseIssueCount > 0 && <label className="operational-sheet-option">
              <input type="checkbox" checked={cheeseReviewConfirmed} disabled={previewMode || importer.isPending} onChange={event => {
                setCheeseReviewConfirmed(event.target.checked);
                if (event.target.checked) setValidation(current => current.startsWith('Review the cheese source discrepancies') ? '' : current);
              }} />
              <span>I reviewed the {cheeseIssueCount} cheese source discrepancies. Save these values as reference data, not corrected recipes.</span>
            </label>}
          </fieldset>}
          {kind === 'dough_guide' && doughChoices.length > 0 && <div className="import-fields">
            <div className="form-field">
              <label htmlFor="dough-portion">Dough-ball variant for this product</label>
              <select id="dough-portion" value={doughChoice?.key ?? ''} disabled={previewMode || importer.isPending} onChange={(event) => {
                setDoughPortionKey(event.target.value);
                setDoughBatchColumn(0);
              }}>
                <option value="">Choose a source dough-ball variant</option>
                {doughChoices.map(choice => <option key={choice.key} value={choice.key}>
                  {choice.portion.product} · {choice.portion.ounces ?? '?'} oz · {choice.sheet} row {choice.portion.sourceRow}
                </option>)}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="dough-batch">Batch column for this product</label>
              <select id="dough-batch" value={selectedDoughBatch?.column ?? ''} disabled={previewMode || importer.isPending || !doughChoice} onChange={(event) => setDoughBatchColumn(Number(event.target.value))}>
                <option value="">Choose a batch column</option>
                {(doughChoice?.batches ?? []).map(batch => <option key={batch.column} value={batch.column}>
                  {batch.label} · column {batch.column} · total {batch.total ?? 'not supplied'}
                </option>)}
              </select>
              <span className="field-help">Only the chosen variant and batch column become structured setup data. The original selected worksheets remain preserved.</span>
            </div>
          </div>}
          {operationalPreview && <OperationalSetupSummary
            brand={brand} nameResolution={referenceNames}
            data={operationalPreview}
            title={`Normalized ${isOperationalKind(kind) ? kindLabels[kind] : 'workbook'} preview`}
            defaultOpen
          />}
          {kind === 'dough_guide' && doughReviewIssueCount > 0 && <label className="operational-sheet-option">
            <input type="checkbox" checked={doughReviewConfirmed} disabled={previewMode || importer.isPending} onChange={(event) => {
              setDoughReviewConfirmed(event.target.checked);
              if (event.target.checked) setValidation((current) =>
                current.startsWith('Review the dough source discrepancies') ? '' : current,
              );
            }} />
            <span>I reviewed the {doughReviewIssueCount} source discrepancies. Save these values as reference data, not a corrected recipe.</span>
          </label>}
          {kind === 'sauce_guide' && <p className="field-help">
            Attach this guide only when it belongs to the selected product. A spec may name a sauce without a supplied recipe; no substitute guide is required or assigned automatically.
          </p>}
          {kind === 'sauce_guide' && sauceReviewIssueCount > 0 && <label className="operational-sheet-option">
            <input type="checkbox" checked={sauceReviewConfirmed} disabled={previewMode || importer.isPending} onChange={event => {
              setSauceReviewConfirmed(event.target.checked);
              if (event.target.checked) setValidation(current => current.startsWith('Review the sauce source discrepancies') ? '' : current);
            }} />
            <span>I reviewed the {sauceReviewIssueCount} sauce source discrepancies. Save them as reference data, not corrected or approved formulas.</span>
          </label>}
          {kind === 'premix' && premixReviewIssueCount > 0 && <label className="operational-sheet-option">
            <input type="checkbox" checked={premixReviewConfirmed} disabled={previewMode || importer.isPending} onChange={event => {
              setPremixReviewConfirmed(event.target.checked);
              if (event.target.checked) setValidation(current => current.startsWith('Review the premix source details') ? '' : current);
            }} />
            <span>I reviewed the {premixReviewIssueCount} premix source details, including preparation timing and saved planning values. Save as reference data, not corrected formulas or current-run quantities.</span>
          </label>}
          {kind === 'product_specs' && productSpecDrafts.length === 0 && <div className="notice" role="status">
            No complete product sections were detected automatically. You can still import the full workbook to one profile; every source cell will be retained.
          </div>}
          {hasProductSpecDrafts && <section className="product-spec-review" aria-labelledby="product-spec-review-heading" data-testid="product-spec-review">
            <div className="section-heading">
              <div><div className="eyebrow">Review detected sections</div><h3 id="product-spec-review-heading">{productSpecDrafts.length} product {productSpecDrafts.length === 1 ? 'profile' : 'profiles'} found</h3></div>
            </div>
            <p className="field-help">Confirm or edit each brand and flavor before saving. The full workbook is preserved with every profile, along with the section location. Existing runs are not changed.</p>
            <div className="product-spec-draft-list">
              {productSpecDrafts.map((draft, index) => {
                const draftProfile = profilesReady && draft.brand.trim() && draft.flavor.trim()
                  ? activeProfileByProduct.get(scheduleProductKey(draft.brand, draft.flavor))
                  : undefined;
                const applicatorRows = draft.extracted?.sections.flatMap((section) =>
                  section.ingredients
                    .filter((ingredient) => isUnrecognizedApplicatorLabel(ingredient.name))
                    .map((ingredient) => ({ section, ingredient })),
                ) ?? [];
                const sourceLocation = draft.sections.length
                  ? draft.sections.slice(0, 3).map((section) => `${section.sheet} · row ${section.headerRow}–${section.endRow}`).join('; ')
                  : 'Manual profile; full workbook retained';
                const locked = previewMode || importer.isPending || draft.saveState === 'saved';
                return <fieldset className="product-spec-draft" key={draft.id} data-testid={`product-spec-draft-${index}`}>
                  <legend>Product {index + 1}</legend>
                  <div className="product-spec-draft-fields">
                    <div className="form-field">
                      <label htmlFor={`product-spec-brand-${index}`}>Brand</label>
                      <input id={`product-spec-brand-${index}`} autoComplete="organization" maxLength={120} value={draft.brand} onChange={(event) => updateProductSpecDraft(draft.id, { brand: event.target.value })} required disabled={locked} />
                    </div>
                    <div className="form-field">
                      <label htmlFor={`product-spec-flavor-${index}`}>Flavor</label>
                      <input id={`product-spec-flavor-${index}`} maxLength={120} value={draft.flavor} onChange={(event) => updateProductSpecDraft(draft.id, { flavor: event.target.value })} required disabled={locked} />
                    </div>
                  </div>
                  <div className="product-spec-draft-meta">
                    <span>{sourceLocation}{draft.sections.length > 3 ? `; +${draft.sections.length - 3} more` : ''}</span>
                    {draftProfile && <span>Matches {draftProfile.brand} / {draftProfile.flavor} · revision {draftProfile.revision}</span>}
                  </div>
                  {draft.sourceBrand && <p className="field-help" role="status">
                    Original workbook brand: {draft.sourceBrand}. This customer workbook uses separate Kroger profiles; the source cells are unchanged.
                  </p>}
                  {applicatorRows.length > 0 && <section
                    className="product-spec-role-review"
                    aria-label={`Confirm applicator roles for ${draft.brand} ${draft.flavor}`}
                    data-testid={`product-spec-role-review-${index}`}
                  >
                    <div>
                      <strong>Unrecognized applicator rows</strong>
                      <p className="field-help">Confirm each row’s role. Rows left unconfirmed stay flagged and won’t receive a quality-check target.</p>
                    </div>
                    {applicatorRows.map(({ section, ingredient }, roleIndex) => {
                      const sourceKey = productSpecRoleKey(ingredient.sourceCoordinates);
                      const controlId = `product-spec-role-${index}-${roleIndex}`;
                      const currentRole = draft.roleOverrides?.[sourceKey];
                      return <div className="product-spec-role-row" key={`${sourceKey}:${roleIndex}`}>
                        <div className="product-spec-role-source">
                          <strong>{ingredient.name}</strong>
                          <small>{section.sheet} · row {ingredient.sourceRow} · {ingredient.roleConfirmed ? 'Role confirmed' : 'Needs confirmation'}</small>
                        </div>
                        <div className="form-field">
                          <label htmlFor={controlId}>Confirmed role</label>
                          <select
                            id={controlId}
                            data-testid={`select-product-spec-role-${index}-${roleIndex}`}
                            value={currentRole ?? ''}
                            onChange={(event) => updateProductSpecRole(draft, sourceKey, event.target.value)}
                            disabled={locked}
                          >
                            <option value="">Choose a role</option>
                            {Object.entries(productSpecRoleLabels).map(([role, label]) => (
                              <option value={role} key={role}>{label}</option>
                            ))}
                          </select>
                        </div>
                      </div>;
                    })}
                  </section>}
                  {draft.extracted && <ProductSpecSummary
                    nameResolution={referenceNames}
                    data={draft.extracted}
                    title="Extracted spec preview"
                    brand={draft.brand}
                    flavor={draft.flavor}
                    defaultOpen={previewMode && index === 0}
                  />}
                  {draft.saveState === 'saving' && <div className="field-help" role="status">Saving this profile…</div>}
                  {draft.saveState === 'saved' && <div className="notice" role="status">Saved. This profile will not be duplicated if you retry the batch.</div>}
                  {draft.saveState === 'failed' && <div className="error-banner" role="alert">{draft.saveError || 'This profile could not be saved.'}</div>}
                  <div className="control-row product-spec-draft-actions">
                    <button className="button button-quiet" type="button" onClick={() => setProductSpecDrafts((current) => current.filter((item) => item.id !== draft.id))} disabled={locked}>Remove profile</button>
                  </div>
                </fieldset>;
              })}
            </div>
            <button className="button button-secondary" type="button" onClick={addManualProductSpecDraft} disabled={previewMode || importer.isPending}>Add profile manually</button>
          </section>}
          {kind !== 'schedule' && kind !== 'shipping' && !hasProductSpecDrafts && matchingProfile && !savedMessage && <div className="notice" role="status" data-testid="notice-existing-profile">
            This matches {matchingProfile.brand} / {matchingProfile.flavor} · revision {matchingProfile.revision}. A new workbook or changed recipe selection adds a preserved source and creates a new revision. Repeating the same workbook and selection does not add a duplicate or change the revision. Existing run snapshots will not change.
          </div>}
          {kind === 'schedule' && schedulePreview && <section className="schedule-review" aria-labelledby="schedule-preview-heading" data-testid="schedule-preview" style={{ marginTop: 16, padding: 16, border: '1px solid hsl(var(--border))', borderRadius: 12, background: 'hsl(var(--muted) / .35)' }}>
            <div className="schedule-review-head" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div><div className="eyebrow">Read-only review</div><h3 id="schedule-preview-heading">Parsed production schedule</h3></div>
              <span className="schedule-count" data-testid="text-schedule-run-count" style={{ padding: '7px 10px', borderRadius: 999, background: 'hsl(var(--primary) / .09)', color: 'hsl(var(--primary))', font: '500 11px var(--app-font-mono)' }}>{schedulePreview.runs.length} eligible {schedulePreview.runs.length === 1 ? 'row' : 'rows'}</span>
            </div>
            <div className="notice" role="status"><AlertTriangle size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />Review the eligible rows and product matches below. Import creates planned runs and keeps each selected product profile as a snapshot.</div>
            {schedulePreview.ignoredPastCount > 0 && <div className="notice" role="status" data-testid="schedule-past-rows-notice" style={{ marginTop: 10 }}>{schedulePreview.ignoredPastCount} past {schedulePreview.ignoredPastCount === 1 ? 'schedule row was' : 'schedule rows were'} ignored because the scheduled date is before the import date ({scheduleImportDate}). Rows scheduled for today are kept.</div>}
            {schedulePreview.runs.length ? <div className="schedule-table-wrap" style={{ overflowX: 'auto', border: '1px solid hsl(var(--border))', borderRadius: 9, background: 'hsl(var(--card))' }}>
              <table className="schedule-table" style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', textAlign: 'left', fontSize: 12 }}>
                <thead><tr>{['Date', 'Brand', 'Flavor', 'Cases', 'Notes', 'Source'].map((heading) => <th key={heading} scope="col" style={{ padding: '10px 12px', color: 'hsl(var(--muted-foreground))', borderBottom: '1px solid hsl(var(--border))', font: '500 10px var(--app-font-mono)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{heading}</th>)}</tr></thead>
                <tbody>{schedulePreview.runs.slice(0, scheduleVisibleRows).map((run, index) => <tr key={`${run.source.sheet}:${run.source.row}`} data-testid={`schedule-row-${index}`}>
                  <td style={{ padding: '11px 12px', whiteSpace: 'nowrap', borderBottom: '1px solid hsl(var(--border))', fontFamily: 'var(--app-font-mono)' }}>{run.date}</td><td style={{ padding: '11px 12px', borderBottom: '1px solid hsl(var(--border))' }}>{run.brand}</td><td style={{ padding: '11px 12px', borderBottom: '1px solid hsl(var(--border))' }}>{run.flavor || '—'}</td><td style={{ padding: '11px 12px', borderBottom: '1px solid hsl(var(--border))', fontVariantNumeric: 'tabular-nums' }}>{run.casesPlanned.toLocaleString()}</td><td style={{ padding: '11px 12px', borderBottom: '1px solid hsl(var(--border))', maxWidth: 240 }}>{run.notes || '—'}</td><td style={{ padding: '11px 12px', borderBottom: '1px solid hsl(var(--border))', color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--app-font-mono)' }}>{run.source.sheet} · row {run.source.row}</td>
                </tr>)}</tbody>
              </table>
            </div> : <div className="schedule-empty" data-testid="empty-schedule-rows">No eligible schedule rows were found. Rows dated before {scheduleImportDate} are ignored; today and future rows can be imported.</div>}
            {schedulePreview.runs.length > scheduleVisibleRows && <div className="control-row" style={{ justifyContent: 'center', marginTop: 12 }}><button className="button button-secondary" type="button" data-testid="button-show-more-schedule-rows" onClick={() => setScheduleVisibleRows((count) => Math.min(count + 50, schedulePreview.runs.length))}>Show next {Math.min(50, schedulePreview.runs.length - scheduleVisibleRows)} rows</button></div>}
            {scheduleProducts.length > 0 && <section aria-labelledby="schedule-mapping-heading" style={{ marginTop: 18 }}>
              <div className="section-heading"><div><div className="eyebrow">Connect the schedule to run setup</div><h4 id="schedule-mapping-heading">Match products to active profiles</h4></div><span className="field-help">{scheduleProducts.length} product {scheduleProducts.length === 1 ? 'match' : 'matches'}</span></div>
              <p className="field-help" style={{ marginTop: 0, marginBottom: 12 }}>Exact brand and flavor matches are selected automatically. Review or change each match before creating planned runs.</p>
              <div className="schedule-mappings" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 10 }}>{resolvedScheduleProducts.map((product) => <div className="form-field" key={product.key}>
                <label htmlFor={`schedule-profile-${encodeURIComponent(product.key)}`}>{product.brand} / {product.flavor || 'No flavor listed'} · {product.rows} {product.rows === 1 ? 'row' : 'rows'}</label>
                <select id={`schedule-profile-${encodeURIComponent(product.key)}`} value={product.chosenId} onChange={(event) => setScheduleProfileChoices((current) => ({ ...current, [product.key]: event.target.value }))} disabled={!profilesReady || !profiles.length || scheduleImporter.isPending}>
                  <option value="">Choose an active profile</option>
                  {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.brand} / {profile.flavor} · rev {profile.revision}</option>)}
                </select>
              </div>)}</div>
              <section className="schedule-planning-section" aria-labelledby="schedule-planning-heading" data-testid="schedule-planning-review">
                <div className="section-heading">
                  <div><div className="eyebrow">Before creating runs</div><h4 id="schedule-planning-heading">Review product requirements</h4></div>
                  <span className="field-help" data-testid="text-schedule-planning-progress">
                    {schedulePlanningGroups.filter((group) => hasCurrentScheduleReview(group.profile, group.cases)).length} of {schedulePlanningGroups.length} products reviewed
                  </span>
                </div>
                <p className="field-help">
                  Review source choices once for each selected product profile. Each schedule row will still become its own planned run with requirements recalculated for that row’s case count.
                </p>
                {schedulePlanningGroups.length > 100 && <div className="notice" role="alert">This schedule maps to more than 100 product profiles. Split it into smaller imports to review each product safely.</div>}
                <div className="schedule-planning-list">
                  {schedulePlanningGroups.map((group) => {
                    const current = hasCurrentScheduleReview(group.profile, group.cases);
                    const saved = schedulePlanningReviews[group.profile.id];
                    const expanded = schedulePlanningOpenProfileId === group.profile.id;
                    const sourceLabels = group.sourceProducts.slice(0, 3).join(' · ');
                    const moreSources = group.sourceProducts.length - 3;
                    return (
                      <article className="schedule-planning-card" key={group.profile.id} data-testid={`schedule-plan-product-${group.profile.id}`}>
                        <div className="schedule-planning-card-head">
                          <div>
                            <h5>{group.profile.brand} / {group.profile.flavor}</h5>
                            <p>{group.cases.toLocaleString()} cases across {group.runs.toLocaleString()} scheduled {group.runs === 1 ? 'run' : 'runs'}</p>
                            <span className="field-help">Schedule labels: {sourceLabels}{moreSources > 0 ? ` · +${moreSources} more` : ''}</span>
                          </div>
                          <span className={`rr-chip ${current && saved?.status === 'ready' ? 'rr-chip-ok' : 'rr-chip-review'}`} data-testid={`status-schedule-plan-${group.profile.id}`}>
                            {current ? saved?.status === 'ready' ? 'Requirements ready' : 'Unresolved source items' : 'Review required'}
                          </span>
                        </div>
                        <button
                          className="button button-secondary schedule-planning-toggle"
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={`schedule-planning-editor-${group.profile.id}`}
                          data-testid={`button-review-schedule-profile-${group.profile.id}`}
                          disabled={!online || scheduleImporter.isPending}
                          onClick={() => setSchedulePlanningOpenProfileId(expanded ? null : group.profile.id)}
                        >
                          {expanded ? 'Hide requirements review' : current ? 'Reopen requirements review' : 'Review requirements'}
                        </button>
                        <div id={`schedule-planning-editor-${group.profile.id}`} hidden={!expanded}>
                          {expanded && <RunRequirementsEditor
                            key={`${group.profile.id}:${Math.min(group.cases, 1_000_000)}:${group.profile.revision}:${referenceNames?.revision ?? 0}`}
                            profileId={group.profile.id}
                            targetCases={Math.min(group.cases, 1_000_000)}
                            online={online}
                            heading="Confirm this product’s source formulas"
                            description={group.cases > 1_000_000
                              ? 'This source-choice preview is capped at 1,000,000 cases. Each scheduled row is calculated separately using its own case count.'
                              : 'This review covers the scheduled cases mapped here so you can confirm the source and recipe choices. Each scheduled row is calculated separately using its own case count.'}
                            previewLabel={group.cases > 1_000_000
                              ? 'Source-choice preview capped at 1,000,000 cases'
                              : 'Selection preview · runs calculated separately'}
                            onReviewChange={(review, plan) => {
                              setSchedulePlanningReviews((currentReviews) => {
                                if (!review || !plan) {
                                  if (!currentReviews[group.profile.id]) return currentReviews;
                                  const nextReviews = { ...currentReviews };
                                  delete nextReviews[group.profile.id];
                                  return nextReviews;
                                }
                                return {
                                  ...currentReviews,
                                  [group.profile.id]: { targetCases: Math.min(group.cases, 1_000_000), review, status: plan.status },
                                };
                              });
                            }}
                          />}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
              {!profilesReady && <div className="field-help" role="status">Loading active product profiles…</div>}
              {profilesReady && profiles.length === 0 && <div className="notice" role="status">Create product profiles from product workbooks before importing a schedule.</div>}
              {schedulePreview.runs.length > 0 && <div style={{ marginTop: 14 }}>
                {validation && <div className="error-banner" role="alert">{validation}</div>}
                {scheduleImporter.isError && <div className={errorStatus(scheduleImporter.error) === 409 ? 'notice' : 'error-banner'} role="alert">{errorText(scheduleImporter.error, 'Schedule import failed. No partial runs were saved.')}</div>}
                {savedMessage && <div className="notice" role="status"><ShieldCheck size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />{savedMessage}</div>}
                <button className="button button-primary" type="submit" disabled={previewMode || !online || scheduleImporter.isPending || !hasScheduleMappings || !hasSchedulePlanning || schedulePreview.errors.length > 0} data-testid="button-import-schedule">
                  {scheduleImporter.isPending ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}
                  {scheduleImporter.isPending ? 'Creating reviewed run plans…' : `Import ${schedulePreview.runs.length} planned ${schedulePreview.runs.length === 1 ? 'run' : 'runs'}`}
                </button>
              </div>}
            </section>}
            {schedulePreview.errors.length > 0 && <div className="notice schedule-warnings" aria-label="Parser warnings" style={{ marginTop: 14 }}>
              <strong>Schedule rows needing correction · {schedulePreview.errors.length}</strong>
              <p>These rows were not included. Correct them in the source workbook and upload it again before importing, so no planned production is silently omitted.</p>
              <ul style={{ margin: '8px 0 0', paddingLeft: 20, lineHeight: 1.55 }}>{schedulePreview.errors.map((warning, index) => <li key={`${warning.sheet}:${warning.row}:${index}`} data-testid={`schedule-warning-${index}`}>{warning.sheet} · row {warning.row}: {warning.message}</li>)}</ul>
            </div>}
          </section>}
          {kind !== 'schedule' && <>
            {validation && <div className="error-banner" role="alert">{validation}</div>}
            {importer.isError && !hasProductSpecDrafts && <div className={errorStatus(importer.error) === 409 ? 'notice' : 'error-banner'} role="alert">{errorStatus(importer.error) === 409 ? 'The source conflicts with a change made elsewhere. Refresh profiles and review the current setup before retrying.' : errorText(importer.error, 'The profile was not saved. Check the connection and try again.')}</div>}
            {savedMessage && <div className="notice" role="status"><ShieldCheck size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />{savedMessage}</div>}
            {hasProductSpecDrafts
              ? <button className="button button-primary" type="submit" disabled={previewMode || !online || importer.isPending || !profilesReady || unsavedProductSpecCount === 0} data-testid="button-import-product-profiles">
                {importer.isPending ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}
                {importer.isPending ? 'Saving product profiles…' : unsavedProductSpecCount ? `Save ${unsavedProductSpecCount} product ${unsavedProductSpecCount === 1 ? 'profile' : 'profiles'}` : 'All profiles saved'}
              </button>
              : <button className="button button-primary" type="submit" disabled={previewMode || !online || importer.isPending || !kind || (isOperationalKind(kind) && selectedOperationalSheets.length === 0) || (kind === 'shipping' && (!profilesReady || shippingTargets.length === 0 || shippingPendingCount === 0))} data-testid="button-import-profile">
              {importer.isPending ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}
              {importer.isPending ? kind === 'shipping' ? 'Saving shipping details…' : 'Saving source profile…' : kind === 'shipping' ? shippingPendingCount ? `Apply shipping to ${shippingPendingCount} ${shippingPendingCount === 1 ? 'profile' : 'profiles'}` : 'Shipping applied to selected profiles' : matchingProfile ? 'Add workbook to profile' : 'Save product profile'}
              </button>}
            {!online && <p className="field-help" style={{ marginTop: 10 }}>Offline: workbook review is available, but profiles cannot be saved.</p>}
          </>}
        </form>
      </>}
    </section>
  );
}

function ProfileCard({ profile, profiles, nameMappings, onMerged }: {
  profile: ProductProfile; profiles: ProductProfile[]; nameMappings: ProductProfileNameMapping[]; onMerged: (message: string) => void;
}) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [brand, setBrand] = useState(profile.brand);
  const [flavor, setFlavor] = useState(profile.flavor);
  const [targetId, setTargetId] = useState('');
  const [confirmMerge, setConfirmMerge] = useState(false);
  // Background list refreshes must not rebase an operator's open draft/confirmation.
  const [renameRevision, setRenameRevision] = useState(profile.revision);
  const [mergeRevisions, setMergeRevisions] = useState<{ source: number; target: number } | null>(null);
  const [feedback, setFeedback] = useState('');
  const [validation, setValidation] = useState('');
  const rename = useRenameProductProfile({ request: { credentials: 'include' } });
  const merge = useMergeProductProfile({ request: { credentials: 'include' } });
  const targets = profiles.filter((item) => item.id !== profile.id && !item.mergedIntoId);
  const rememberedNames = nameMappings.filter(mapping => mapping.profileId === profile.id &&
    scheduleProductKey(mapping.brand, mapping.flavor) !== scheduleProductKey(profile.brand, profile.flavor));
  const busy = rename.isPending || merge.isPending;
  const importedSources = useMemo(() => {
    const raw = profile.productData as Record<string, unknown>;
    const sources = Array.isArray(raw.sources) ? raw.sources : [raw];
    const countSheets = (value: unknown): number => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.sheets)) return record.sheets.length;
      if (Array.isArray(record.sources)) return record.sources.reduce<number>((sum, item) => sum + countSheets(item), 0);
      return countSheets(record.content) + countSheets(record.data);
    };
    const sheetCount = sources.reduce((sum, source) => sum + countSheets(source), 0);
    if (Array.isArray(raw.sources)) {
      return `${sources.length} source workbook${sources.length === 1 ? '' : 's'}${sheetCount ? ` · ${sheetCount} worksheets` : ''}`;
    }
    return sheetCount ? `1 source workbook · ${sheetCount} worksheet${sheetCount === 1 ? '' : 's'}` : 'Saved source bundle';
  }, [profile.productData]);

  const saveRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextBrand = brand.trim();
    const nextFlavor = flavor.trim();
    if (!nextBrand || !nextFlavor || nextBrand.length > 120 || nextFlavor.length > 120) {
      setValidation('Enter a brand and flavor, each no longer than 120 characters.');
      return;
    }
    setValidation('');
    setFeedback('');
    rename.mutate({ profileId: profile.id, data: { brand: nextBrand, flavor: nextFlavor, expectedRevision: renameRevision } }, {
      onSuccess: (result) => {
        setEditing(false);
        setFeedback(`Renamed at revision ${result.profile.revision}.`);
        refreshProfileLibraries(client);
      },
      onError: (error) => {
        setFeedback(errorStatus(error) === 409
          ? `Conflict: ${errorText(error, 'The rename was not applied. Review the profile name and revision.')}`
          : errorText(error, 'Rename failed. No change was applied.'));
      },
    });
  };

  const submitMerge = () => {
    const target = targets.find((item) => item.id === targetId);
    if (!target || !mergeRevisions) return;
    setFeedback('');
    merge.mutate({
      profileId: profile.id,
      data: { targetProfileId: target.id, expectedSourceRevision: mergeRevisions.source, expectedTargetRevision: mergeRevisions.target },
    }, {
      onSuccess: (result) => {
        setConfirmMerge(false);
        onMerged(`Merged ${profile.brand} / ${profile.flavor} into ${result.profile.brand} / ${result.profile.flavor}. Source data and remembered names were preserved.`);
        refreshProfileLibraries(client);
        void client.invalidateQueries({ queryKey: getListRunsQueryKey() });
      },
      onError: (error) => {
        setConfirmMerge(false);
        setFeedback(errorStatus(error) === 409
          ? `Conflict: ${errorText(error, 'The merge was not applied. Review the selected profiles and their revisions.')}`
          : errorText(error, 'Merge failed. Neither source bundle was discarded.'));
      },
    });
  };

  return (
    <article className="panel profile-card" data-testid={`card-profile-${profile.id}`}>
      <div className="profile-card-head">
        <div>
          <h3>{profile.brand} <span style={{ color: 'hsl(var(--muted-foreground))' }}>/</span> {profile.flavor}</h3>
          <div className="profile-meta">REV {String(profile.revision).padStart(2, '0')} · {importedSources} · Updated {new Date(profile.updatedAt).toLocaleDateString()}</div>
        </div>
        <span className="status status-running">Active profile</span>
      </div>
      <OperationalSetupSummary data={profile.productData} brand={profile.brand} nameResolution={profile.nameResolution} title="Recipe and process details" />
      <ProductSpecSummary data={profile.productData} brand={profile.brand} flavor={profile.flavor} nameResolution={profile.nameResolution} title="Product specification details" />
      {rememberedNames.length > 0 && <details className="profile-bundle" data-testid={`remembered-names-${profile.id}`}>
        <summary>Remembered import names ({rememberedNames.length})</summary>
        <p>Workbooks using these brand/flavor names match this profile automatically. Original source labels and existing run snapshots stay unchanged.</p>
        <ul>{rememberedNames.map(name => <li key={scheduleProductKey(name.brand, name.flavor)}>{name.brand} / {name.flavor}</li>)}</ul>
      </details>}
      {editing && <form onSubmit={saveRename} noValidate className="import-fields" style={{ marginTop: 10 }}>
        <div className="form-field"><label htmlFor={`rename-brand-${profile.id}`}>Brand</label><input id={`rename-brand-${profile.id}`} value={brand} maxLength={120} onChange={(event) => setBrand(event.target.value)} /></div>
        <div className="form-field"><label htmlFor={`rename-flavor-${profile.id}`}>Flavor</label><input id={`rename-flavor-${profile.id}`} value={flavor} maxLength={120} onChange={(event) => setFlavor(event.target.value)} /></div>
        {validation && <div className="field-help" role="alert" style={{ gridColumn: '1/-1' }}>{validation}</div>}
        {rename.isError && <div className="error-banner" role="alert" style={{ gridColumn: '1/-1' }}>{errorText(rename.error, 'Rename failed. No change was applied.')}</div>}
        <div className="control-row" style={{ gridColumn: '1/-1', marginTop: 0 }}>
          <button className="button button-primary" type="submit" disabled={rename.isPending}>{rename.isPending ? 'Saving rename…' : 'Save rename'}</button>
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => { setEditing(false); setBrand(profile.brand); setFlavor(profile.flavor); }}>Cancel</button>
        </div>
        <p className="field-help" style={{ gridColumn: '1/-1' }}>The previous brand/flavor will be remembered for future imports. This renames the product profile, not the labels inside its original workbooks.</p>
      </form>}
      <details className="profile-bundle">
        <summary>View preserved source data <ChevronDown size={13} style={{ verticalAlign: 'middle' }} /></summary>
        <pre>{JSON.stringify(profile.productData, null, 2)}</pre>
      </details>
      <div className="profile-actions">
        {!editing && <button className="button button-secondary" type="button" disabled={busy || confirmMerge} onClick={() => { setBrand(profile.brand); setFlavor(profile.flavor); setRenameRevision(profile.revision); rename.reset(); setEditing(true); setFeedback(''); }} data-testid={`button-rename-${profile.id}`}><Pencil size={14} /> Rename profile</button>}
        {targets.length > 0 && <>
          <label className="sr-only" htmlFor={`merge-target-${profile.id}`}>Select profile to merge into</label>
          <select id={`merge-target-${profile.id}`} value={targetId} disabled={busy || editing} onChange={(event) => { setTargetId(event.target.value); setConfirmMerge(false); }} aria-label={`Select merge destination for ${profile.brand} ${profile.flavor}`}>
            <option value="">Merge into another profile…</option>
            {targets.map((target) => <option key={target.id} value={target.id}>{target.brand} / {target.flavor} · rev {target.revision}</option>)}
          </select>
          <button className="button button-quiet" type="button" onClick={() => { const target = targets.find((item) => item.id === targetId); if (!target) return; setMergeRevisions({ source: profile.revision, target: target.revision }); setConfirmMerge(true); setFeedback(''); }} disabled={!targetId || busy || editing} data-testid={`button-merge-${profile.id}`}><GitMerge size={14} /> Merge profiles</button>
        </>}
        {confirmMerge && targetId && <div className="confirm-merge" role="group" aria-label="Confirm profile merge">
          <strong>Confirm merge?</strong> Merge {profile.brand} / {profile.flavor} into {targets.find(target => target.id === targetId)?.brand} / {targets.find(target => target.id === targetId)?.flavor}, keeping the destination name. The source leaves the active list. Both source bundles and all previously remembered names are kept for future imports; existing run snapshots do not change.
          <div className="control-row">
            <button className="button button-warn" type="button" onClick={submitMerge} disabled={merge.isPending}>{merge.isPending ? 'Merging…' : 'Confirm and merge'}</button>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => setConfirmMerge(false)}>Keep profiles separate</button>
          </div>
        </div>}
        {feedback && <div className={feedback.startsWith('Conflict') || feedback.includes('failed') ? 'error-banner' : 'notice'} role="status" style={{ flexBasis: '100%' }}>{feedback}</div>}
      </div>
    </article>
  );
}

export default function ImportsPage() {
  const [profileFeedback, setProfileFeedback] = useState('');
  const profilesQuery = useListProductProfiles({
    query: { queryKey: getListProductProfilesQueryKey() },
    request: { credentials: 'include' },
  });
  const profiles = profilesQuery.data?.profiles ?? [];
  const nameMappings = profilesQuery.data?.nameMappings ?? [];
  const historyQuery = useListImportBatches({
    query: { queryKey: getListImportBatchesQueryKey() },
    request: { credentials: 'include' },
  });
  const importBatches = historyQuery.data?.imports ?? [];
  return (
    <main className="workspace">
      <div className="page-head">
        <div><div className="eyebrow">Facility setup library</div><h1>Product profiles</h1><p className="page-subtitle">Approved workbook source data used to set up new production runs.</p></div>
        <a href="#nl-title" className="button button-secondary">Manage names</a>
      </div>
      <p className="import-intro">Profiles are shared setup references, not an archive. New runs capture an immutable product snapshot at creation; later profile edits do not rewrite existing runs.</p>
      <div className="import-layout">
          <WorkbookReview profiles={profiles} nameMappings={nameMappings} referenceNames={profilesQuery.data?.referenceNames} profilesReady={Boolean(profilesQuery.data)} />
        <section aria-labelledby="profiles-heading">
          <div className="section-heading"><h2 id="profiles-heading">Active profiles</h2><span className="eyebrow">{profiles.length} saved</span></div>
          {profileFeedback && <div className="notice" role="status">{profileFeedback}</div>}
          {profilesQuery.isLoading && !profilesQuery.data && <><div className="skeleton" /><div className="skeleton" /></>}
          {profilesQuery.isError && !profilesQuery.data && <div className="panel empty-state"><div className="empty-mark"><CircleAlert size={20} /></div><h3>Profiles are unavailable</h3><p>{errorText(profilesQuery.error, 'Could not load facility profiles.')}</p><button className="button button-secondary" type="button" onClick={() => void profilesQuery.refetch()}><RefreshCw size={14} /> Try again</button></div>}
          {profilesQuery.isError && profilesQuery.data && <div className="error-banner" role="status">Could not refresh profiles. Showing the last loaded list.</div>}
          {profilesQuery.data && (profiles.length
            ? <div className="profile-list">{profiles.map((profile) => <ProfileCard key={profile.id} profile={profile} profiles={profiles} nameMappings={nameMappings} onMerged={setProfileFeedback} />)}</div>
            : <div className="panel empty-state"><div className="empty-mark"><FileSpreadsheet size={21} /></div><h3>No approved profiles yet</h3><p>Review a product or process workbook to create the facility’s first run setup profile. Nothing is imported automatically.</p></div>)}
        </section>
      </div>
      <NameLibraryPanel />
      <section className="import-history-section" aria-labelledby="import-history-heading">
        <div className="section-heading"><div><div className="eyebrow">Source activity</div><h2 id="import-history-heading">Recent imports</h2></div><span className="field-help">Metadata only · workbook contents are not available here</span></div>
        {historyQuery.isLoading && !historyQuery.data && <div className="history-loading" aria-label="Loading recent imports"><div className="skeleton" /><div className="skeleton" /></div>}
        {historyQuery.isError && !historyQuery.data && <div className="panel empty-state"><div className="empty-mark"><CircleAlert size={20} /></div><h3>Import history is unavailable</h3><p>{errorText(historyQuery.error, 'Could not load recent import activity.')}</p><button className="button button-secondary" type="button" onClick={() => void historyQuery.refetch()}><RefreshCw size={14} /> Try again</button></div>}
        {historyQuery.isError && historyQuery.data && <div className="error-banner" role="status">Could not refresh import history. Showing the last loaded activity.</div>}
        {historyQuery.data && (importBatches.length ? <div className="panel import-history" role="list" aria-label="Recent workbook imports">
          {importBatches.map((batch) => <article className="history-row" role="listitem" key={batch.id} data-testid={`row-import-${batch.id}`}>
            <div className="history-file"><FileSpreadsheet size={17} aria-hidden="true" /><div><strong>{batch.sourceName}</strong><span>{kindLabels[batch.importKind]} · {batch.importKind === 'schedule' ? `${batch.scheduleRunCount ?? 0} planned ${batch.scheduleRunCount === 1 ? 'run' : 'runs'}` : batch.proposedBrand && batch.proposedFlavor ? `${batch.proposedBrand} / ${batch.proposedFlavor}` : 'No proposed profile name'}</span></div></div>
            <div className="history-state"><span className={`import-state import-state-${batch.status}`}>{batch.status === 'applied' ? 'Applied' : 'Draft'}</span><span>{batch.status === 'applied' && batch.appliedAt ? `Applied ${new Date(batch.appliedAt).toLocaleString()}` : `Reviewed ${new Date(batch.createdAt).toLocaleString()}`}</span></div>
          </article>)}
        </div> : <div className="panel empty-state"><div className="empty-mark"><FileSpreadsheet size={20} /></div><h3>No import activity yet</h3><p>Reviewed workbook sources will appear here after the import service records them. This history contains metadata only.</p></div>)}
      </section>
    </main>
  );
}

export function ImportsVisualPreviewPage() {
  const shippingMode = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('kind') === 'shipping';
  const sauceMode = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('kind') === 'sauce';
  const cheeseMode = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('kind') === 'cheese';
  const doughMode = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('kind') === 'dough';
  const operationalMode = typeof window !== 'undefined' &&
    (new URLSearchParams(window.location.search).get('kind') === 'operational' || doughMode || cheeseMode || sauceMode || shippingMode);
  return (
    <main className="workspace">
      <div className="page-head">
        <div>
          <div className="eyebrow">Development-only visual check</div>
          <h1>Importer preview</h1>
          <p className="page-subtitle">
            Synthetic {shippingMode ? 'shipping and palletizing' : sauceMode ? 'sauce procedure' : cheeseMode ? 'cheese recipe' : doughMode ? 'dough procedure' : operationalMode ? 'premix and process' : 'product-spec'} data shown in the real importer components.
          </p>
        </div>
      </div>
      <div className="notice visual-preview-banner" role="status">
        <ShieldCheck size={16} aria-hidden="true" />
        <span><strong>Preview only.</strong> This route uses sample data, makes no API requests, and disables every save action. The real workspace and its sign-in protection are unchanged.</span>
      </div>
      <p className="import-intro">Use this page to check the importer layout at phone, tablet, and desktop widths without signing in or touching facility data.</p>
      <div className="import-layout">
        <WorkbookReview
          profiles={shippingMode ? visualShippingProfiles : []}
          profilesReady
          previewMode
          initialWorkbook={shippingMode ? visualShippingWorkbook : sauceMode ? visualSauceWorkbook : cheeseMode ? visualCheeseWorkbook : doughMode ? visualDoughWorkbook : operationalMode ? visualOperationalWorkbook : visualPreviewWorkbook}
        />
        {operationalMode
          ? <section aria-labelledby="visual-preview-operations-heading">
              <div className="section-heading">
                <div>
                  <div className="eyebrow">Sample output</div>
                  <h2 id="visual-preview-operations-heading">Operational profile snapshot</h2>
                </div>
                <span className="eyebrow">Preview only</span>
              </div>
              <article className="panel profile-card">
                <div className="profile-card-head">
                  <div>
                    <div className="eyebrow">Sample profile</div>
                    <h3>Sample Brand / Classic</h3>
                <div className="profile-meta">{shippingMode ? 'Shipping' : sauceMode ? 'Sauce guide' : cheeseMode ? 'Cheese' : doughMode ? 'Dough guide' : 'Premix'} · saved source snapshot</div>
                  </div>
                  <span className="import-state">Preview only</span>
                </div>
                <OperationalSetupSummary data={shippingMode ? visualShippingPreview : sauceMode ? visualSaucePreview : cheeseMode ? visualCheesePreview : doughMode ? visualDoughPreview : visualOperationalPreview} title={shippingMode ? 'Shipping and palletizing details' : 'Recipe and process details'} defaultOpen />
              </article>
              <div className="notice" role="note">This sample shows how selected operational fields appear in a future run’s captured profile.</div>
            </section>
          : <section aria-labelledby="visual-preview-products-heading">
              <div className="section-heading">
                <div>
                  <div className="eyebrow">Sample output</div>
                  <h2 id="visual-preview-products-heading">Detected product profiles</h2>
                </div>
                <span className="eyebrow">{visualPreviewProducts.length} preview only</span>
              </div>
              <div className="profile-list">
                {visualPreviewProducts.map((product, index) => (
                  <article className="panel profile-card" key={product.id}>
                    <div className="profile-card-head">
                      <div>
                        <div className="eyebrow">Sample profile {index + 1}</div>
                        <h3>{product.brand}</h3>
                        <div className="profile-meta">{product.flavor} · Product specifications</div>
                      </div>
                      <span className="import-state">Preview only</span>
                    </div>
                    <div className="profile-bundle">
                      {product.sections.map((section) => `${section.sheet} · rows ${section.headerRow}–${section.endRow}`).join('; ')}
                    </div>
                  </article>
                ))}
              </div>
              <div className="notice" role="note">
                These cards are generated from the same product-section parser used by imports. They are not saved profiles.
              </div>
            </section>}
      </div>
    </main>
  );
}
