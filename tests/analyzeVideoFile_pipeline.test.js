'use strict';
/**
 * Integration tests: analyzeVideoFile pipeline with mocked external dependencies.
 *
 * Verifies:
 *   1. Phase 1 outgoing request does not contain DANA_PROMPT / business context.
 *   2. Phase 2 outgoing request does contain business context (Shape Studio).
 *   3. Phase 2 score overwrite rejected: report uses Phase 1 validated scores.
 *   4. Invalid principleCode from Phase 2 triggers boundedRepairFixes (3rd call), not auto-select.
 *   5. boundedRepairFixes revalidates the returned code against sentChapterCodes.
 *
 * External dependencies mocked: openai, video.service, child_process.execFileSync.
 */

jest.mock('../utils/logger',     () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/lead_store', () => ({ getDailyStats: jest.fn(() => ({ totalLeads: 0, hotLeadsTotal: 0 })), getEvents: jest.fn(() => []), logEvent: jest.fn() }));

// ── Mock video.service ────────────────────────────────────────────────────────
jest.mock('../services/video.service', () => ({
  DATA_DIR_FN: () => '/tmp/test-data',
  getVideoMeta:   jest.fn(() => Promise.resolve({ probeOk: true, durationSec: 15, width: 1080, height: 1920, hasAudio: true, fps: 30 })),
  extractFrames:  jest.fn(() => Promise.resolve([{ timestampSec: 1, base64: 'AAAA' }, { timestampSec: 8, base64: 'BBBB' }])),
  transcribeAudio: jest.fn(() => Promise.resolve({ text: 'שלום זה בדיקה', wordTimestamps: [], coverage: 'full', truncated: false })),
  saveReport:  jest.fn(),
  loadReport:  jest.fn(() => null),
  saveJob:     jest.fn(),
  loadJob:     jest.fn(() => null),
  listReports: jest.fn(() => []),
}));

// ── Mock child_process (estimate.py + cite_check.py) ────────────────────────
jest.mock('child_process', () => ({
  execFileSync: jest.fn(() =>
    JSON.stringify({ readiness: 55, verdict: 'לתקן קודם', verdict_key: 'fix', calibrated: false })
  ),
}));

// ── Mock openai — capture outgoing requests ──────────────────────────────────
const mockCreate = jest.fn();
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
});

// Now require dana_agent AFTER all mocks are in place
const { analyzeVideoFile } = require('../agents/dana_agent');

// Utility: return a minimal valid Phase 1 response
function phase1Response(scores = {}) {
  const defaults = { C1: 3, C2: 2, C3: 3, C4: 3, C5: 2, C6: 4, C7: 4 };
  const s = { ...defaults, ...scores };
  return {
    choices: [{ message: { content: JSON.stringify({
      ...s,
      flags: [],
      reasoning_C1: 'test', reasoning_C2: 'test', reasoning_C3: 'test',
      reasoning_C4: 'test', reasoning_C5: 'test', reasoning_C6: 'test', reasoning_C7: 'test',
      what_works: ['strong hook'],
    }) } }],
  };
}

// Utility: return a Phase 2 json_object response with optional mosseri_fixes
function phase2Response(fixCodes = ['HOOK-1']) {
  const fixes = fixCodes.map((code, i) => ({
    principleCode: code,
    fixType:       code.startsWith('HOOK') ? 'rewrite' : 'structural',
    name:          `fix-${i}`,
    currentText:   code.startsWith('HOOK') ? 'old text' : null,
    suggestedRewrite: code.startsWith('HOOK') ? 'new text' : null,
    action:        code.startsWith('HOOK') ? null : 'do something',
    evidence:      null,
    explanation:   `explanation for ${code}`,
  }));
  return {
    choices: [{ message: { content: JSON.stringify({
      mosseri_fixes:            fixes,
      mosseri_scores:           { C1: 5, C2: 5, C3: 5, C4: 5, C5: 5, C6: 5, C7: 5 }, // tries to overwrite Phase 1
      perceived_message:        'test message',
      message_lands:            true,
      recommendation:           'דורש תיקונים קלים',
      report_strengths:         [],
      report_problems:          [],
      sections:                 {},
      timestamps:               [],
      mosseri_strengths:        [],
      improvements_must:        [],
      improvements_recommended: [],
      improvements_experiments: [],
      hook_alternatives:        [],
      cta_options:              [],
      edit_plan:                [],
    }) } }],
  };
}

// Utility: bounded repair response for SEND → SEND-3
function repairResponse(idx, code, excluded = false) {
  return {
    choices: [{ message: { content: JSON.stringify({
      repairs: [{ idx, principleCode: code, justification: 'best match', excluded }],
    }) } }],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => { mockCreate.mockReset(); });

describe('Phase isolation — outgoing request inspection', () => {
  test('Phase 1 request: system message does not contain Shape Studio or DANA_PROMPT', async () => {
    // Phase 1 → valid scores, Phase 2 → valid fix
    mockCreate
      .mockResolvedValueOnce(phase1Response())
      .mockResolvedValueOnce(phase2Response(['HOOK-1']));

    await analyzeVideoFile({ videoPath: '/fake/video.mp4', id: 'test-1', format: 'feed', title: 'test' });

    const phase1Call = mockCreate.mock.calls[0][0];
    const p1SystemMsg = phase1Call.messages.find(m => m.role === 'system')?.content ?? '';

    expect(p1SystemMsg).not.toContain('Shape Studio');
    expect(p1SystemMsg).not.toContain('Dana');         // DANA_PROMPT persona
    expect(p1SystemMsg).toContain('anonymous');        // blind scorer persona
  });

  test('Phase 2 request: system message contains Shape Studio (business context injected)', async () => {
    mockCreate
      .mockResolvedValueOnce(phase1Response())
      .mockResolvedValueOnce(phase2Response(['HOOK-1']));

    await analyzeVideoFile({ videoPath: '/fake/video.mp4', id: 'test-2', format: 'feed', title: 'test' });

    const phase2Call = mockCreate.mock.calls[1][0];
    const p2SystemMsg = phase2Call.messages.find(m => m.role === 'system')?.content ?? '';

    expect(p2SystemMsg).toContain('Shape Studio');     // DANA_PROMPT loaded from business_context.md
  });

  test('Phase 2 user message contains the Phase 1 locked scores (not system message)', async () => {
    mockCreate
      .mockResolvedValueOnce(phase1Response({ C1: 2, C2: 1 }))
      .mockResolvedValueOnce(phase2Response(['HOOK-1']));

    await analyzeVideoFile({ videoPath: '/fake/video.mp4', id: 'test-3', format: 'feed', title: 'test' });

    const phase2Call    = mockCreate.mock.calls[1][0];
    const p2SystemMsg   = phase2Call.messages.find(m => m.role === 'system')?.content ?? '';
    const p2UserContent = phase2Call.messages.find(m => m.role === 'user')?.content;
    const p2UserText    = typeof p2UserContent === 'string'
      ? p2UserContent
      : (Array.isArray(p2UserContent) ? p2UserContent.find(b => b.type === 'text')?.text ?? '' : '');

    // Scores must NOT be in system message
    expect(p2SystemMsg).not.toMatch(/C1=\d/);
    // Locked scores ARE in user message
    expect(p2UserText).toContain('C1=2');
  });
});

describe('Phase 2 score overwrite protection', () => {
  test('report.mosseri_scores uses Phase 1 scores even if Phase 2 returns different values', async () => {
    const phase1Scores = { C1: 2, C2: 1, C3: 3, C4: 3, C5: 2, C6: 4, C7: 4 };
    mockCreate
      .mockResolvedValueOnce(phase1Response(phase1Scores))
      .mockResolvedValueOnce(phase2Response(['HOOK-1'])); // Phase 2 tries to overwrite with all 5s

    const report = await analyzeVideoFile({ videoPath: '/fake/video.mp4', id: 'test-4', format: 'feed', title: 'test' });

    expect(report.mosseri_scores.C1).toBe(2);   // Phase 1 value, not Phase 2's 5
    expect(report.mosseri_scores.C2).toBe(1);
    expect(report.scoring_phase).toBe('blind');  // confirms Phase 1 origin
  });
});

describe('Invalid principleCode — bounded repair, not auto-select', () => {
  test('Phase 2 returns "SEND" (story format) → boundedRepairFixes is called (3rd API call)', async () => {
    mockCreate
      .mockResolvedValueOnce(phase1Response())                    // Phase 1
      .mockResolvedValueOnce(phase2Response(['SEND']))            // Phase 2: bare prefix
      .mockResolvedValueOnce(repairResponse(0, 'SEND-6'));        // bounded repair: SEND-6

    const report = await analyzeVideoFile({
      videoPath: '/fake/video.mp4', id: 'test-5', format: 'story', title: 'test',
    });

    // boundedRepairFixes was called (3 total API calls)
    expect(mockCreate).toHaveBeenCalledTimes(3);

    // The repaired fix should use SEND-6 (from repair model), not SEND-1 (auto-select)
    const repaired = report.fixes.find(f => f.codeRepaired);
    expect(repaired).toBeDefined();
    expect(repaired.principleCode).toBe('SEND-6');
    expect(repaired.originalCode).toBe('SEND');
    expect(repaired.repairJustification).toBeDefined();
  });

  test('boundedRepairFixes revalidates: if repair model returns code outside sentChapterCodes → excluded', async () => {
    mockCreate
      .mockResolvedValueOnce(phase1Response())
      .mockResolvedValueOnce(phase2Response(['SEND']))
      .mockResolvedValueOnce(repairResponse(0, 'HOOK-1'));   // HOOK-1 not in story chapters!

    const report = await analyzeVideoFile({
      videoPath: '/fake/video.mp4', id: 'test-6', format: 'story', title: 'test',
    });

    const excluded = report.fixes.find(f => f.codeExcluded);
    expect(excluded).toBeDefined();
    expect(excluded.excludeReason).toMatch(/HOOK-1.*not in sent chapters/);
    expect(report.review_incomplete).toBe(true);
  });

  test('"HOOK" (story) → excluded immediately without calling boundedRepairFixes', async () => {
    // HOOK has no candidates in story chapters [4,13,16] → excluded in flagForRepairOrExclude
    mockCreate
      .mockResolvedValueOnce(phase1Response())
      .mockResolvedValueOnce(phase2Response(['HOOK']));

    const report = await analyzeVideoFile({
      videoPath: '/fake/video.mp4', id: 'test-7', format: 'story', title: 'test',
    });

    // No repair call — only Phase 1 and Phase 2 (2 total)
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(report.review_incomplete).toBe(true);
    expect(report.incomplete_recommendations).toHaveLength(1);
    expect(report.incomplete_recommendations[0].originalCode).toBe('HOOK');
  });
});
