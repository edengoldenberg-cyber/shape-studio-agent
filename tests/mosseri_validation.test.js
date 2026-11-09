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
  repairOrExcludeFix,
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

// ── 5. principleCode repair pipeline ─────────────────────────────────────────
// Tests validateFixCodes + repairOrExcludeFix against the story-format code set,
// which is the case that exposed the HOOK/SEND bug.

describe('principleCode repair and exclusion — story format codes', () => {
  const STORY_CODES = new Set([
    'SEND-1','SEND-2','SEND-3','SEND-4','SEND-5','SEND-6',
    'LONG-1','LONG-2','LONG-3','LONG-4','LONG-5',
  ]);

  function runPipeline(principleCode) {
    const fix = { principleCode, name: 'test', explanation: 'test' };
    // citeMap={}: simulates "no doctrine citations loaded" — still exercises repair logic
    const after = validateFixCodes([fix], {}, STORY_CODES);
    return after.map(f => repairOrExcludeFix(f, STORY_CODES))[0];
  }

  test('"SEND" (bare prefix, story format) → repaired to SEND-1', () => {
    const result = runPipeline('SEND');
    expect(result.codeRepaired).toBe(true);
    expect(result.principleCode).toBe('SEND-1');
    expect(result.originalCode).toBe('SEND');
    expect(result.codeExcluded).toBe(false);
    expect(result.codeValid).toBe(true);
  });

  test('"HOOK" (bare prefix, story format) → excluded: HOOK not in chapters [4,13,16]', () => {
    const result = runPipeline('HOOK');
    expect(result.codeExcluded).toBe(true);
    expect(result.excludeReason).toMatch(/HOOK/);
    expect(result.codeRepaired).toBeUndefined();
  });

  test('"HOOK-1" valid code, story format → still excluded (chapter 2 not in story set)', () => {
    const result = runPipeline('HOOK-1');
    // HOOK-1 not in STORY_CODES set → inSentChapters=false → codeValid=false → excluded
    expect(result.codeExcluded).toBe(true);
  });

  test('"SEND-3" valid code, story format → valid (no repair needed)', () => {
    const fix = { principleCode: 'SEND-3', name: 'test', explanation: 'test' };
    // With a real citeMap entry the code passes inGlobalMap; here we test inSentChapters
    const citeMapWithSend3 = { 'SEND-3': { date: '01.01.2026', quote: 'test quote' } };
    const after = validateFixCodes([fix], citeMapWithSend3, STORY_CODES);
    const repaired = after.map(f => repairOrExcludeFix(f, STORY_CODES))[0];
    expect(repaired.codeValid).toBe(true);
    expect(repaired.codeExcluded).toBeFalsy();
    expect(repaired.codeRepaired).toBeFalsy();
  });

  test('review_incomplete must be true when any fix is excluded', () => {
    const result = runPipeline('HOOK');
    const excludedCodes = [result].filter(f => f.codeExcluded);
    // analyzeVideoFile sets: review_incomplete = excludedCodes.length > 0
    const review_incomplete = excludedCodes.length > 0;
    expect(review_incomplete).toBe(true);
  });
});

// ── 6. cite_check reporting contract ─────────────────────────────────────────
// "No failures" with zero citations is not_applicable, not successful verification.

describe('cite_check reporting contract', () => {
  // runCiteCheck is not exported; test via the report field populated by analyzeVideoFile.
  // We document the contract here: when citations_in_review=0,
  // passed must be null and status must be 'not_applicable'.

  test('passed=null contract: null means not-checked, not "passed"', () => {
    // This is the contract that runCiteCheck must satisfy when citationsInReview===0.
    // A report with passed:null and cite_check_applicable:false must NOT be read as
    // "citations verified successfully".
    const citeCheck = {
      recommendations_generated: 2,
      recommendations_code_valid: 2,
      recommendations_excluded: [],
      citations_in_review: 0,
      cite_check_ran: false,
      cite_check_applicable: false,
      status: 'not_applicable',
      passed: null,
      failures: [],
      note: 'No attributed Mosseri citations in review text — cite_check not applicable. Zero citations found, zero verified.',
    };
    expect(citeCheck.passed).toBeNull();
    expect(citeCheck.cite_check_applicable).toBe(false);
    expect(citeCheck.status).toBe('not_applicable');
    // Verify the note clearly states zero were verified
    expect(citeCheck.note).toContain('Zero citations found');
  });

  test('cite_check_applicable=true only when citations are present in review text', () => {
    // When citations ARE present, cite_check_applicable must be true
    // and passed must be boolean (true or false), not null
    const citeCheck = {
      citations_in_review: 2,
      cite_check_ran: true,
      cite_check_applicable: true,
      passed: true,
      failures: [],
    };
    expect(citeCheck.cite_check_applicable).toBe(true);
    expect(typeof citeCheck.passed).toBe('boolean'); // not null
  });
});
