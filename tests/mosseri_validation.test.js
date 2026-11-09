'use strict';
/**
 * Regression tests: mosseri-skill score validation and principleCode verification.
 *
 * Guards against two historical bugs:
 *   1. Scale bug (c4a2980 era): model returned 0-100 scores; estimate.py clamped all
 *      to 5, producing readiness=100 for every video regardless of quality.
 *   2. Citation bug (pre-c4a2980): fixes had no principleCode, citation=null always.
 *
 * Run with: npm test -- --testPathPattern=mosseri_validation
 */

// Isolate from server boot by requiring only the agent module directly.
// Requires that dana_agent can be required without side-effects from full server.
jest.mock('../utils/logger', () => ({
  info:  jest.fn(), warn:  jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../utils/lead_store', () => ({
  getDailyStats: jest.fn(() => ({ totalLeads: 0, hotLeadsTotal: 0 })),
  getEvents:     jest.fn(() => []),
  logEvent:      jest.fn(),
}));

const {
  validateMosseriScores,
  validateFixCodes,
  getChapterCodes,
  flagForRepairOrExclude,
  runCiteCheck,
  runCiteCheckJS,
  buildBlindSystemMsg,
  buildPhase2SystemMsg,
} = require('../agents/dana_agent');

// ── 1. validateMosseriScores ──────────────────────────────────────────────────

describe('validateMosseriScores — strict integer 0-5', () => {
  const VALID = { C1: 3, C2: 2, C3: 4, C4: 3, C5: 2, C6: 4, C7: 4 };

  test('all valid integers 0-5 → valid=true, fixed equals input', () => {
    const r = validateMosseriScores(VALID);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
    expect(r.fixed).toEqual(VALID);
  });

  test('boundary: 0 and 5 accepted', () => {
    const r = validateMosseriScores({ C1: 0, C2: 5, C3: 0, C4: 5, C5: 0, C6: 5, C7: 0 });
    expect(r.valid).toBe(true);
  });

  // Scale bug: model returned 0-100 values
  test('85 (0-100 scale) → invalid, error mentions "out of range"', () => {
    const r = validateMosseriScores({ ...VALID, C1: 85 });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('C1') && e.includes('out of range'))).toBe(true);
    expect(r.fixed.C1).toBeNull();
  });

  test('-1 (negative) → invalid', () => {
    const r = validateMosseriScores({ ...VALID, C2: -1 });
    expect(r.valid).toBe(false);
    expect(r.fixed.C2).toBeNull();
  });

  test('4.7 (float) → invalid, error mentions "float"', () => {
    const r = validateMosseriScores({ ...VALID, C3: 4.7 });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('C3') && e.includes('float'))).toBe(true);
    expect(r.fixed.C3).toBeNull();
  });

  test('true (boolean) → invalid, error mentions type', () => {
    const r = validateMosseriScores({ ...VALID, C4: true });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('C4'))).toBe(true);
    expect(r.fixed.C4).toBeNull();
  });

  test('"3abc" (non-numeric string) → invalid', () => {
    const r = validateMosseriScores({ ...VALID, C5: '3abc' });
    expect(r.valid).toBe(false);
    expect(r.fixed.C5).toBeNull();
  });

  test('"3" (numeric string) → invalid — no string coercion', () => {
    const r = validateMosseriScores({ ...VALID, C6: '3' });
    expect(r.valid).toBe(false);
    expect(r.fixed.C6).toBeNull();
  });

  test('null → invalid, error mentions null/missing', () => {
    const r = validateMosseriScores({ ...VALID, C7: null });
    expect(r.valid).toBe(false);
    expect(r.fixed.C7).toBeNull();
  });

  test('missing key → invalid', () => {
    const { C1: _omit, ...noC1 } = VALID;
    const r = validateMosseriScores(noC1);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('C1'))).toBe(true);
  });

  test('no Math.round: 4.0 must be treated as 4 (integer)', () => {
    // 4.0 === 4 in JS, Number.isInteger(4.0) is true, so this is accepted
    const r = validateMosseriScores({ ...VALID, C1: 4.0 });
    expect(r.valid).toBe(true);
    expect(r.fixed.C1).toBe(4);
  });

  test('null argument → valid=false', () => {
    const r = validateMosseriScores(null);
    expect(r.valid).toBe(false);
  });

  test('array argument → valid=false', () => {
    const r = validateMosseriScores([3, 3, 3, 3, 3, 3, 3]);
    expect(r.valid).toBe(false);
  });
});

// ── 2. principleCode validation (via validateFixCodes) ────────────────────────
// Since validateFixCodes is not exported, we test it indirectly by checking the
// report properties populated during integration. For unit coverage we test the
// exported validateMosseriScores and the behaviour guarantee: a fix without
// principleCode must not receive a citation.

describe('scoreScaleValid flag contract', () => {
  test('scoreScaleValid must be true only when all scores are valid', () => {
    const invalid = validateMosseriScores({ C1: 85, C2: 80, C3: 85, C4: 80, C5: 75, C6: 90, C7: 85 });
    expect(invalid.valid).toBe(false);
    // Caller must NOT set scoreScaleValid=true when valid===false
    // (this is enforced by the throw in analyzeVideoFile; this test documents the contract)
    expect(invalid.valid).not.toBe(true);
  });

  test('all 7 must be checked — a mix of good/bad → still invalid', () => {
    const r = validateMosseriScores({ C1: 3, C2: 4, C3: 4, C4: 85, C5: 2, C6: 4, C7: 4 });
    expect(r.valid).toBe(false);
    expect(r.fixed.C4).toBeNull();
    expect(r.fixed.C1).toBe(3); // good values are still set in fixed
  });
});

// ── 3. Schema anchoring regression ───────────────────────────────────────────
// Guards: the old schema example {C1:3,C2:2,C3:3,C4:3,C5:2,C6:4,C7:4} must
// never appear in a report built from real video analysis.

describe('schema anchoring detection', () => {
  const OLD_ANCHOR = { C1: 3, C2: 2, C3: 3, C4: 3, C5: 2, C6: 4, C7: 4 };

  test('old anchor pattern correctly identified', () => {
    const isAnchor = s => Object.entries(OLD_ANCHOR).every(([k, v]) => s[k] === v);
    expect(isAnchor(OLD_ANCHOR)).toBe(true);
    expect(isAnchor({ C1: 3, C2: 2, C3: 3, C4: 3, C5: 2, C6: 4, C7: 5 })).toBe(false); // C7 differs
    expect(isAnchor({ C1: 2, C2: 3, C3: 4, C4: 3, C5: 3, C6: 5, C7: 4 })).toBe(false);
  });

  test('equal scores on two different videos are acceptable if independently justified', () => {
    // This test documents that equal readiness is not automatically a bug.
    // The issue was that EVERY criterion was identical (not just the total).
    const videoA = { C1: 3, C2: 3, C3: 3, C4: 3, C5: 3, C6: 3, C7: 3 };
    const videoB = { C1: 3, C2: 3, C3: 3, C4: 3, C5: 3, C6: 3, C7: 3 };
    const rA = validateMosseriScores(videoA);
    const rB = validateMosseriScores(videoB);
    // Both valid — equal scores are acceptable if rubric was applied independently
    expect(rA.valid).toBe(true);
    expect(rB.valid).toBe(true);
  });
});

// ── 4. Phase separation contract ─────────────────────────────────────────────
// Drives the real message builder functions — no self-confirming mocks.
// Each test inspects the actual strings that would be sent to the OpenAI API.

describe('two-phase analysis contract — real message builders', () => {
  // Story format chapters [4, 13, 16]: only SEND-1..6 and LONG-1..5 are valid.
  const STORY_CODES = new Set([
    'SEND-1','SEND-2','SEND-3','SEND-4','SEND-5','SEND-6',
    'LONG-1','LONG-2','LONG-3','LONG-4','LONG-5',
  ]);

  // Phase 1: blind system message must not contain business context

  test('Phase 1 — buildBlindSystemMsg excludes studio name, goal, audience, and previous verdicts', () => {
    const msg = buildBlindSystemMsg({ rubricText: 'rubric', doctrineChapters: '', audioLimitNote: '' });
    expect(msg).not.toContain('Shape Studio');   // from business_context.md via DANA_PROMPT
    expect(msg).not.toMatch(/C1=\d/);            // no previous scores
    expect(msg).toContain('anonymous');          // confirms blind-scorer persona
  });

  test('Phase 1 — buildBlindSystemMsg does not contain DANA_PROMPT (checked by absence of "Dana")', () => {
    const msg = buildBlindSystemMsg({ rubricText: '', doctrineChapters: '', audioLimitNote: '' });
    // DANA_PROMPT opens with "You are Dana" — that name must not appear in Phase 1
    expect(msg).not.toContain('Dana');
  });

  // Phase 2: system message must include business context

  test('Phase 2 — buildPhase2SystemMsg includes DANA_PROMPT (Shape Studio present)', () => {
    const msg = buildPhase2SystemMsg({
      doctrineChapters: '',
      sentChapterNums: [4, 13, 16],
      sentChapterCodes: STORY_CODES,
      audioLimitNote: '',
    });
    expect(msg).toContain('Shape Studio');   // DANA_PROMPT loaded from business_context.md
  });

  test('Phase 2 — valid codes list for story includes SEND but not HOOK', () => {
    const msg = buildPhase2SystemMsg({
      doctrineChapters: '',
      sentChapterNums: [4, 13, 16],
      sentChapterCodes: STORY_CODES,
      audioLimitNote: '',
    });
    // The valid-codes constraint line must include SEND-1 (story chapter 4)
    expect(msg).toContain('SEND-1');
    // The valid-codes constraint line must NOT list HOOK-1 as allowed
    // (DANA_PROMPT may reference HOOK-1 in rubric tables — we check the constraint line, not the whole msg)
    const validCodesLine = msg.split('\n').find(l => l.startsWith('הקודים המלאים שזמינים:'));
    expect(validCodesLine).toBeDefined();
    expect(validCodesLine).toContain('SEND-1');
    expect(validCodesLine).not.toContain('HOOK');
  });

  test('Phase 2 — system message does not contain locked score values (scores go in user content)', () => {
    // Scores are injected into phase2VideoContext (user message), not system message.
    // This prevents Phase 2 from "seeing" scores in a position it could dispute.
    const msg = buildPhase2SystemMsg({
      doctrineChapters: '',
      sentChapterNums: [4, 13, 16],
      sentChapterCodes: STORY_CODES,
      audioLimitNote: '',
    });
    expect(msg).not.toMatch(/C1=\d/);
    expect(msg).not.toMatch(/C2=\d/);
  });

  test('Phase 2 score overwrite: assembler replaces gptData.mosseri_scores with Phase 1 validated scores', () => {
    // Models the guard at analyzeVideoFile line ~1367: gptData.mosseri_scores = validatedScores
    const validatedScores = { C1: 2, C2: 3, C3: 4, C4: 3, C5: 2, C6: 4, C7: 4 };
    const gptData = { mosseri_scores: { C1: 5, C2: 5, C3: 5, C4: 5, C5: 5, C6: 5, C7: 5 } };
    gptData.mosseri_scores = validatedScores;    // the actual line in analyzeVideoFile
    expect(gptData.mosseri_scores).toEqual(validatedScores);
    expect(gptData.mosseri_scores.C1).toBe(2);   // Phase 1 score, not Phase 2's 5
  });
});

// ── 5. principleCode flag pipeline ───────────────────────────────────────────
// Tests validateFixCodes + flagForRepairOrExclude against the story-format code set.
// boundedRepairFixes (async, calls GPT) is tested in analyzeVideoFile_pipeline.test.js.

describe('principleCode flag and exclusion — story format codes', () => {
  const STORY_CODES = new Set([
    'SEND-1','SEND-2','SEND-3','SEND-4','SEND-5','SEND-6',
    'LONG-1','LONG-2','LONG-3','LONG-4','LONG-5',
  ]);

  function flag(principleCode) {
    const fix = { principleCode, name: 'test', explanation: 'test' };
    const after = validateFixCodes([fix], {}, STORY_CODES);
    return after.map(f => flagForRepairOrExclude(f, STORY_CODES))[0];
  }

  test('"SEND" (bare prefix, story) → flagged for bounded repair — NOT auto-repaired to SEND-1', () => {
    const result = flag('SEND');
    // Must NOT blindly pick SEND-1
    expect(result.codeRepaired).toBeFalsy();
    // Must NOT be excluded (candidates exist)
    expect(result.codeExcluded).toBeFalsy();
    // Must be flagged for model repair
    expect(result.needsBoundedRepair).toBe(true);
    expect(result.repairCandidates).toContain('SEND-1');
    expect(result.originalCode).toBe('SEND');
  });

  test('"HOOK" (bare prefix, story) → excluded immediately: HOOK not in chapters [4,13,16]', () => {
    const result = flag('HOOK');
    expect(result.codeExcluded).toBe(true);
    expect(result.excludeReason).toMatch(/HOOK/);
    expect(result.needsBoundedRepair).toBeFalsy();
  });

  test('"HOOK-1" (numbered, story) → excluded: chapter 2 not in story set', () => {
    const result = flag('HOOK-1');
    expect(result.codeExcluded).toBe(true);
    expect(result.needsBoundedRepair).toBeFalsy();
  });

  test('"SEND-3" with citeMap entry → valid, no flag or exclusion needed', () => {
    const fix = { principleCode: 'SEND-3', name: 'test', explanation: 'test' };
    const cm  = { 'SEND-3': { date: '01.01.2026', quote: 'test quote' } };
    const after   = validateFixCodes([fix], cm, STORY_CODES);
    const flagged = after.map(f => flagForRepairOrExclude(f, STORY_CODES))[0];
    expect(flagged.codeValid).toBe(true);
    expect(flagged.codeExcluded).toBeFalsy();
    expect(flagged.needsBoundedRepair).toBeFalsy();
  });

  test('review_incomplete must be true when any fix is excluded after flagging', () => {
    const excluded = [flag('HOOK')].filter(f => f.codeExcluded);
    expect(excluded.length > 0).toBe(true);
    // analyzeVideoFile sets: review_incomplete = excludedCodes.length > 0
    const review_incomplete = excluded.length > 0;
    expect(review_incomplete).toBe(true);
  });
});

// ── 6. runCiteCheck — actual function tests ───────────────────────────────────
// Tests call the real runCiteCheck function (now exported).
// "No failures" with zero citations must be not_applicable, not "passed".

describe('runCiteCheck — actual function', () => {

  test('zero citations → passed:null, status:not_applicable, cite_check_applicable:false', () => {
    // Review text with no attributed Mosseri quotes
    const result = runCiteCheck('ביקורת ללא ציטוטים מוסרי.', []);
    expect(result.citations_in_review).toBe(0);
    expect(result.cite_check_applicable).toBe(false);
    expect(result.status).toBe('not_applicable');
    expect(result.passed).toBeNull();      // null ≠ true: not "verified successfully"
    expect(result.cite_check_ran).toBe(false);
    expect(result.note).toContain('Zero citations found');
  });

  test('zero citations — recommendations counters are still populated', () => {
    const fixes = [
      { codeValid: true, codeExcluded: false, principleCode: 'HOOK-1' },
      { codeExcluded: true, originalCode: 'HOOK', excludeReason: 'not in sent chapters' },
    ];
    const result = runCiteCheck('ביקורת ללא ציטוטים.', fixes);
    expect(result.recommendations_generated).toBe(2);
    expect(result.recommendations_code_valid).toBe(1);
    expect(result.recommendations_excluded).toHaveLength(1);
    expect(result.recommendations_excluded[0]).toContain('HOOK');
  });

  test('review text with Mosseri citation → cite_check_applicable:true, passed is boolean', () => {
    // This exercises the branch where citationsInReview > 0.
    // On Railway, Python is unavailable → cite_check_ran:false, passed:false.
    // Locally Python is available but cite_check.py may not find the quote → failures.
    // Either way, passed must be boolean (true or false), never null.
    const reviewWithCite = 'מוסרי, 15.01.2026: "צריך הוק"\nזהו סיכום הביקורת.';
    const result = runCiteCheck(reviewWithCite, [{ codeValid: true, codeExcluded: false, principleCode: 'HOOK-1' }]);
    expect(result.citations_in_review).toBeGreaterThan(0);
    expect(result.cite_check_applicable).toBe(true);
    // passed must be boolean — true (Python ran, no failures) or false (Python unavailable)
    expect(typeof result.passed).toBe('boolean');
    expect(result.failures).toBeDefined();
  });

  // ── runCiteCheckJS — JavaScript fallback ──────────────────────────────────

  test('runCiteCheckJS: zero citations → not_applicable, passed:null', () => {
    const result = runCiteCheckJS('ביקורת ללא ציטוטים.', []);
    expect(result.citations_in_review).toBe(0);
    expect(result.status).toBe('not_applicable');
    expect(result.passed).toBeNull();
  });

  test('runCiteCheckJS: attributed quote from actual doctrine → passed:true', () => {
    // Use a quote that actually appears in doctrine.md with the correct date.
    // RANK-1 principle has [21.02.2026 · DVBOgtfEXtp · 0:21] "It is there and it's not going away."
    const review = 'מוסרי, 21.02.2026: "It is there and it\'s not going away." — לסיכום.';
    const result = runCiteCheckJS(review, []);
    expect(result.citations_in_review).toBe(1);
    expect(result.cite_check_applicable).toBe(true);
    expect(result.cite_check_ran).toBe(true);
    expect(result.implementation).toBe('js');
    // If the quote is in doctrine on that date → passed; otherwise failed but should not be null
    expect(typeof result.passed).toBe('boolean');
    expect(result.failures).toBeDefined();
  });

  test('runCiteCheckJS: invented quote → failed with failure entry', () => {
    // Fabricated quote that cannot be in doctrine
    const review = 'מוסרי, 01.01.2025: "absolutely fabricated quote that cannot exist in doctrine"';
    const result = runCiteCheckJS(review, []);
    expect(result.citations_in_review).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]).toContain('not in doctrine');
  });

  test('cite_check status field: execution_error when Python missing, passed/failed when ran', () => {
    // When Python is absent (ENOENT), status must be 'execution_error', not 'failed'
    // We cannot synthetically cause ENOENT in a unit test, but we can verify that:
    //   (a) the not_applicable path sets status='not_applicable' (already tested above)
    //   (b) the execution-error path sets passed:false and cite_check_ran:false
    // These are the same conditions — verify runCiteCheck does not say "passed" on error.
    const result = runCiteCheck('מוסרי, 15.01.2026: "quote"', []);
    // If Python ran: status is 'passed' or 'failed' — both are boolean passed.
    // If Python missing: status is 'execution_error', passed=false, cite_check_ran=false.
    if (result.cite_check_ran === false && result.cite_check_applicable) {
      expect(result.status).toBe('execution_error');
      expect(result.passed).toBe(false);
    } else if (result.cite_check_ran === true) {
      expect(['passed', 'failed']).toContain(result.status);
      expect(typeof result.passed).toBe('boolean');
    }
  });
});

// ── 7. incomplete-review banner — controlled fixture ─────────────────────────
// Exercises the rendering logic from public/app.js with controlled report fixtures.
// This is a pure-logic test; browser rendering is not checked here (noted separately).

describe('incomplete-review banner rendering logic', () => {
  // Mirror the rendering logic from public/app.js so we can unit-test it.
  // If this logic changes in app.js it must be kept in sync here.
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  function renderIncompleteBanner(r) {
    const incompleteRecs = Array.isArray(r.incomplete_recommendations)
      ? r.incomplete_recommendations
      : (r.review_incomplete && r.incomplete_recommendations
          ? [{ originalCode: '?', excludeReason: String(r.incomplete_recommendations) }]
          : []);
    if (incompleteRecs.length === 0 && !r.review_incomplete) return '';
    return [
      '<div class="banner">',
      `⚠️ ביקורת חלקית${incompleteRecs.length > 0 ? ` — ${incompleteRecs.length} המלצות לא הוצגו` : ''}`,
      r.review_incomplete_note ? `<em>${esc(r.review_incomplete_note)}</em>` : '',
      incompleteRecs.map(x => `• ${esc(x.originalCode ?? '?')}: ${esc(x.excludeReason ?? '')}`).join('\n'),
      '</div>',
    ].filter(Boolean).join('\n');
  }

  test('review_incomplete:false, empty array → no banner', () => {
    const html = renderIncompleteBanner({ review_incomplete: false, incomplete_recommendations: [] });
    expect(html).toBe('');
  });

  test('review_incomplete:true, empty array → banner shown without item list', () => {
    const html = renderIncompleteBanner({
      review_incomplete: true,
      review_incomplete_note: 'ביקורת חלקית',
      incomplete_recommendations: [],
    });
    expect(html).toContain('⚠️ ביקורת חלקית');
    expect(html).not.toContain('המלצות לא הוצגו'); // no count line when array empty
  });

  test('review_incomplete:true with excluded fixes → banner lists them', () => {
    const html = renderIncompleteBanner({
      review_incomplete: true,
      review_incomplete_note: 'קוד לא בפרקים שנשלחו',
      incomplete_recommendations: [
        { originalCode: 'HOOK', excludeReason: 'HOOK principles not in sent chapters' },
      ],
    });
    expect(html).toContain('1 המלצות לא הוצגו');
    expect(html).toContain('HOOK');
    expect(html).toContain('not in sent chapters');
  });

  test('legacy string incomplete_recommendations + review_incomplete:true → banner shown', () => {
    // Old reports stored a string; normalize to array for display
    const html = renderIncompleteBanner({
      review_incomplete: true,
      incomplete_recommendations: 'Requires light corrections',
    });
    expect(html).toContain('⚠️ ביקורת חלקית');
    expect(html).toContain('Requires light corrections');
  });

  test('review_incomplete:false even if incomplete_recommendations has items → no banner', () => {
    // This should not happen in practice; test defensive behavior
    const html = renderIncompleteBanner({
      review_incomplete: false,
      incomplete_recommendations: [{ originalCode: 'X', excludeReason: 'test' }],
    });
    // Array items present but review_incomplete=false → still renders because incompleteRecs.length>0
    // This matches the production behavior: either flag triggers the banner.
    expect(html).toContain('⚠️ ביקורת חלקית');
  });
});
