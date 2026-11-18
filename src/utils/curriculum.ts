/**
 * Which curriculum a batch follows. Batch.code is free text ("Batch 19"), so the first number in it is the batch number.
 *   Batch < 19  → "V1"  (original syllabus, its KRA / feedback / tests stay exactly as they were)
 *   Batch ≥ 19  → "V2"  (Vinsup 2.0, 50-day curriculum + day-wise material)
 * Override the cut-over with CURRICULUM_V2_FROM_BATCH in .env.
 */
export const V2_FROM_BATCH = Number(process.env.CURRICULUM_V2_FROM_BATCH) || 19;

export const batchNumberOf = (code?: string | null): number | null => {
  const m = (code || '').match(/\d+/);
  return m ? Number(m[0]) : null;
};

export const curriculumForBatch = (code?: string | null): 'V1' | 'V2' => {
  const n = batchNumberOf(code);
  return n !== null && n >= V2_FROM_BATCH ? 'V2' : 'V1';
};

/** Modules this batch should see. A course with no V2 set (e.g. Data Verse Pro) falls back to its V1 modules. */
export function pickModules<T extends { curriculum: string }>(modules: T[], batchCode?: string | null): T[] {
  const want = curriculumForBatch(batchCode);
  const mine = modules.filter((m) => m.curriculum === want);
  return mine.length ? mine : modules.filter((m) => m.curriculum === 'V1');
}

/** True when this batch uses the day-wise (V2) study material. */
export const usesDayWiseMaterial = (code?: string | null) => curriculumForBatch(code) === 'V2';
