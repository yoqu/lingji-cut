import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { SrtEntry } from '../src/types';
import type { AISettings, LLMProvider } from '../src/types/ai';
import { loadProjectFile } from '../electron/project-file';
import {
  buildDirectorPlanFromAgentDraft,
  validateShowDirectorDraft,
  type DirectorAgentCandidate,
  type ShowDirectorDraft,
} from '../electron/director-agent/contract';
import {
  createShowDirectorTools,
  scopedDirectorCandidateId,
  SHOW_DIRECTOR_TOOL_NAMES,
} from '../electron/director-agent/tools';
import {
  buildShowDirectorCompletionPrompt,
  resolveShowDirectorModel,
  resolveShowDirectorModelCandidates,
  runShowDirectorAgent,
} from '../electron/director-agent/show-director-run';
import { projectProviderToPi } from '../electron/agent-runtime/pi-provider-projection';
import { validateDirectorPlanForApproval } from '../src/lib/director-plan-validation';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const entries: SrtEntry[] = [
  { index: 1, startMs: 0, endMs: 2_000, text: '世界第九十一位，不是突然发生的。' },
  { index: 2, startMs: 2_000, endMs: 4_000, text: '真正值得看的是长期积累。' },
];
const longEntries: SrtEntry[] = Array.from({ length: 10 }, (_, index) => ({
  index: index + 1,
  startMs: index * 2_000,
  endMs: (index + 1) * 2_000,
  text: `长期积累的第 ${index + 1} 个观察。`,
}));

const settings = {
  kacut: { enabled: false, baseUrl: 'http://127.0.0.1:8765' },
  promptBindings: {},
} as unknown as AISettings;

function motionDraft(): ShowDirectorDraft {
  return {
    title: '世界第91位不是突然发生的',
    summary: '排名只是结果，更值得看的是长期积累如何一步步成为今天的位置。',
    keywords: ['长期积累', '世界排名', '制造能力'],
    coverDirection: {
      prompt: '画面唯一主标题为“世界第91位不是突然发生的”，不得出现其他文字。',
      composition: '真实产品细节与克制的信息层形成主次关系',
    },
    audioDirection: {
      bgmEnabled: false,
      soundEffectsEnabled: true,
      bgmStyle: '克制、现代',
      energy: 2,
      soundDensity: 'quiet',
    },
    visualThesis: '把排名作为结果，把长期能力作为视觉主线。',
    rhythmDensity: 'balanced',
    styleRules: { paletteUse: '中性色为主，关键数字使用暖色', typographyUse: '短标题与清晰数字层级' },
    defaultTransition: 'hard-cut',
    matchCuts: [],
    segments: [{
      key: 'opening',
      firstEntryIndex: 1,
      lastEntryIndex: 2,
      title: '结果并非突然出现',
      summary: '从排名结果回看长期积累。',
      semanticType: 'explanation',
      complexityLevel: 'medium',
      visualizationScore: 78,
      pacingNeed: 'accent',
      keywords: ['排名', '积累'],
      entities: [],
      enabled: true,
      purpose: 'explain',
      carrier: 'concept',
      intensity: 3,
      renderStrategy: 'motion-card',
      strategyReason: '这一段表达抽象因果，真实素材没有独立证据价值。',
      confidence: 0.92,
      strategyStatus: 'ready',
    }],
    zeroCompositeReason: '逐段检查后，现有口播只建立抽象因果，没有同时需要来源特定素材证据与额外信息层的镜头。',
    warnings: [],
  };
}

function longMotionDraft(): ShowDirectorDraft {
  const draft = motionDraft();
  const source = draft.segments[0];
  return {
    ...draft,
    segments: longEntries.map((entry) => ({
      ...source,
      key: `shot-${entry.index}`,
      firstEntryIndex: entry.index,
      lastEntryIndex: entry.index,
      title: `观察 ${entry.index}`,
      summary: entry.text,
    })),
  };
}

function draftHeader(draft: ShowDirectorDraft): Omit<ShowDirectorDraft, 'segments'> {
  const { segments: _segments, ...header } = draft;
  return header;
}

function candidate(inspected = true, score = 0.82): DirectorAgentCandidate {
  return {
    query: '工厂 生产线 汽车 制造',
    shotKey: 'opening',
    inspected,
    clip: {
      id: 'candidate-1',
      filename: 'factory.mp4',
      path: '/tmp/factory.mp4',
      kind: 'video',
      score,
      durationSec: 8,
      matchedSegmentStart: 1,
    },
  };
}

function compositeDraft(): ShowDirectorDraft {
  const draft = motionDraft();
  draft.segments[0] = {
    ...draft.segments[0],
    renderStrategy: 'agent-composite',
    visualType: 'footage',
    footageQuery: '工厂 生产线 汽车 制造',
    fallbackPolicy: 'block',
    compositionIntent: {
      narrativeGoal: '先建立真实制造现场，再让排名结果回应长期积累。',
      focalPriority: '真实生产动作与第91位结论',
      temporalRelationship: '现场先建立证据，结论在口播重音进入并共同收束。',
      mustShow: ['真实生产线', '第91位'],
      avoid: ['广告式产品陈列'],
    },
    selectedAssets: [{
      candidateId: 'candidate-1',
      usage: 'required',
      reason: '代表帧中生产动作清晰，能提供长期制造能力的具体证据。',
      confidence: 0.9,
    }],
    mediaIndispensability: '真实生产动作是抽象 Motion 无法诚实替代的来源特定证据。',
    graphicsIndispensability: '素材本身不包含排名与因果结论，需要信息层建立阅读顺序。',
  };
  draft.zeroCompositeReason = undefined;
  return draft;
}

async function executeTool(tools: ToolDefinition[], name: string, params: unknown) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return (tool.execute as (...args: unknown[]) => Promise<unknown>)(
    `call-${name}`,
    params,
    undefined,
    undefined,
    {} as never,
  ) as Promise<{ content: Array<{ type: string; text?: string }>; terminate?: boolean }>;
}

function toolPayload(result: Awaited<ReturnType<typeof executeTool>>): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

function materialRpcResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: false,
      },
    }),
  } as Response;
}

async function createMaterialRuntime(projectDir: string) {
  const project = await loadProjectFile(projectDir);
  return createShowDirectorTools({
    entries,
    settings: {
      ...settings,
      kacut: { enabled: true, baseUrl: 'http://127.0.0.1:8765' },
    } as AISettings,
    project,
    projectDir,
    revision: 1,
    roleVersion: '4',
    workflowVersion: '4',
    snapshot: {
      draftRevision: project.production?.draftPlan?.revision ?? null,
      approvedRevision: project.production?.approvedPlan?.revision ?? null,
      productionUpdatedAt: project.production?.updatedAt ?? null,
    },
    loadProduction: async () => project.production,
    persistDraft: async () => undefined,
  });
}

describe('Show Director agent contract', () => {
  it('requires inspected, relevant real material and dual indispensability for composites', () => {
    const candidates = new Map([['candidate-1', candidate(false, 0.82)]]);
    const invalid = validateShowDirectorDraft(compositeDraft(), { entries, candidates });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.issues.map((item) => item.code)).toContain('asset_not_inspected');

    candidates.set('candidate-1', candidate(true, 0.82));
    const valid = validateShowDirectorDraft(compositeDraft(), { entries, candidates });
    expect(valid).toEqual({ ok: true, draft: compositeDraft() });
  });

  it('allows an inspected low-score candidate when the Agent explicitly selects it', () => {
    const candidates = new Map([['candidate-1', candidate(true, 0.18)]]);
    const draft = compositeDraft();
    const validated = validateShowDirectorDraft(draft, { entries, candidates });

    expect(validated).toEqual({ ok: true, draft });
    const plan = buildDirectorPlanFromAgentDraft(draft, {
      entries,
      revision: 1,
      candidates,
      now: 10,
    });
    expect(validateDirectorPlanForApproval(plan)).toEqual([]);
  });

  it('persists the raw material id for approval while keeping shot-scoped ids inside the Agent session', () => {
    const scopedId = scopedDirectorCandidateId('opening', 'candidate-1');
    const scopedCandidate = candidate(true, 0.82);
    scopedCandidate.candidateId = scopedId;
    const draft = compositeDraft();
    draft.segments[0].selectedAssets = [{
      candidateId: scopedId,
      usage: 'required',
      reason: '代表帧中生产动作清晰，能提供长期制造能力的具体证据。',
    }];
    const plan = buildDirectorPlanFromAgentDraft(draft, {
      entries,
      revision: 1,
      candidates: new Map([[scopedId, scopedCandidate]]),
      now: 10,
    });

    expect(plan.segments[0].compositionAssets?.[0].asset.id).toBe('candidate-1');
    expect(plan.segments[0].assetDecisions?.[0]).toMatchObject({
      candidateId: 'candidate-1',
      inspected: true,
    });
    expect(validateDirectorPlanForApproval(plan)).toEqual([]);
  });

  it('requires a real, resolved and decision-complete material audit before accepting all-Motion', () => {
    const unsearched = validateShowDirectorDraft(motionDraft(), {
      entries,
      candidates: new Map(),
      materialReview: { enabled: true, searchAttempts: 0, searchFailures: 0, searches: [] },
    });
    expect(unsearched.ok).toBe(false);
    if (!unsearched.ok) expect(unsearched.issues.map((item) => item.code)).toContain('all_motion_search_required');

    const failed = validateShowDirectorDraft(motionDraft(), {
      entries,
      candidates: new Map(),
      materialReview: { enabled: true, searchAttempts: 2, searchFailures: 2 },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.issues.map((item) => item.code)).toContain('all_motion_search_failed');

    const uninspected = validateShowDirectorDraft(motionDraft(), {
      entries,
      candidates: new Map([['candidate-1', candidate(false)]]),
      materialReview: { enabled: true, searchAttempts: 1, searchFailures: 0 },
    });
    expect(uninspected.ok).toBe(false);
    if (!uninspected.ok) expect(uninspected.issues.map((item) => item.code)).toContain('all_motion_candidates_uninspected');

    const undecided = validateShowDirectorDraft(motionDraft(), {
      entries,
      candidates: new Map([['candidate-1', candidate(true)]]),
      materialReview: { enabled: true, searchAttempts: 1, searchFailures: 0 },
    });
    expect(undecided.ok).toBe(false);
    if (!undecided.ok) expect(undecided.issues.map((item) => item.code)).toContain('all_motion_candidate_decision_missing');

    const accepted = motionDraft();
    accepted.segments[0].rejectedAssets = [{
      candidateId: 'candidate-1',
      reason: '代表帧只有通用生产线，无法为本段抽象因果提供独立叙事价值。',
    }];
    expect(validateShowDirectorDraft(accepted, {
      entries,
      candidates: new Map([['candidate-1', candidate(true)]]),
      materialReview: { enabled: true, searchAttempts: 1, searchFailures: 0 },
    })).toEqual({ ok: true, draft: accepted });
  });

  it('rejects an all-Motion conclusion that only searched video', () => {
    const result = validateShowDirectorDraft(motionDraft(), {
      entries,
      candidates: new Map(),
      materialReview: {
        enabled: true,
        searchAttempts: 1,
        searchFailures: 0,
        searches: [{
          shotKey: 'opening',
          query: '制造现场',
          queriesTried: ['制造现场'],
          kinds: ['video'],
          outcome: 'empty',
          candidateCount: 0,
          errorCount: 0,
        }],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain('all_motion_media_audit_incomplete');
  });

  it.each(['context', 'transition', 'breath'] as const)(
    'requires a material search for an all-Motion %s shot',
    (purpose) => {
      const draft = motionDraft();
      draft.segments[0].purpose = purpose;
      const result = validateShowDirectorDraft(draft, {
        entries,
        candidates: new Map(),
        materialReview: {
          enabled: true,
          searchAttempts: 1,
          searchFailures: 0,
          searches: [{
            shotKey: 'other-shot',
            query: '城市道路',
            queriesTried: ['城市道路'],
            kinds: ['video', 'image'],
            outcome: 'empty',
            candidateCount: 0,
            errorCount: 0,
          }],
        },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((item) => item.code)).toContain('all_motion_broll_search_required');
    },
  );

  it('does not let another shot hide an unresolved material search', () => {
    const draft = motionDraft();
    const result = validateShowDirectorDraft(draft, {
      entries,
      candidates: new Map(),
      materialReview: {
        enabled: true,
        searchAttempts: 2,
        searchFailures: 1,
        searches: [
          { shotKey: 'opening', query: '制造现场', outcome: 'retryable-error', candidateCount: 0, errorCount: 1 },
          { shotKey: 'other-shot', query: '城市道路', outcome: 'empty', candidateCount: 0, errorCount: 0 },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain('all_motion_search_unresolved');

    draft.segments[0].strategyStatus = 'blocked';
    draft.segments[0].blockedReason = '素材服务两次超时，恢复服务后重新检索制造现场。';
    expect(validateShowDirectorDraft(draft, {
      entries,
      candidates: new Map(),
      materialReview: {
        enabled: true,
        searchAttempts: 1,
        searchFailures: 1,
        searches: [
          { shotKey: 'opening', query: '制造现场', outcome: 'retryable-error', candidateCount: 0, errorCount: 1 },
        ],
      },
    })).toEqual({ ok: true, draft });
  });

  it('rejects a candidate searched for another shot', () => {
    const wrongShot = candidate(true, 0.9);
    wrongShot.shotKey = 'closing';
    const result = validateShowDirectorDraft(compositeDraft(), {
      entries,
      candidates: new Map([['candidate-1', wrongShot]]),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain('asset_shot_mismatch');
  });

  it('machine-checks the title and intro lengths promised by the director prompt', () => {
    const draft = motionDraft();
    draft.title = '太短';
    draft.summary = '也太短';
    const result = validateShowDirectorDraft(draft, { entries, candidates: new Map() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
        'title_length_invalid',
        'summary_length_invalid',
      ]));
    }
  });

  it('migrates user locks by subtitle overlap when Pi splits a prior shot', () => {
    const existing = buildDirectorPlanFromAgentDraft(motionDraft(), {
      entries,
      revision: 1,
      candidates: new Map(),
      now: 10,
    });
    existing.segments[0] = {
      ...existing.segments[0],
      purpose: 'evidence',
      intensity: 3,
      userLocks: { direction: true },
    };
    const split = motionDraft();
    split.segments = [1, 2].map((entryIndex) => ({
      ...split.segments[0],
      key: `split-${entryIndex}`,
      firstEntryIndex: entryIndex,
      lastEntryIndex: entryIndex,
      title: `拆分镜头${entryIndex}`,
      summary: entries[entryIndex - 1].text,
    }));

    const replanned = buildDirectorPlanFromAgentDraft(split, {
      entries,
      revision: 2,
      candidates: new Map(),
      existingPlan: existing,
      now: 20,
    });

    expect(replanned.segments).toHaveLength(2);
    expect(replanned.segments.every((segment) => segment.purpose === 'evidence')).toBe(true);
    expect(replanned.segments.every((segment) => segment.intensity === 3)).toBe(true);
    expect(replanned.segments.every((segment) => segment.userLocks?.direction === true)).toBe(true);
  });

  it('requires an explicit zero-composite audit instead of silently defaulting to Motion', () => {
    const draft = motionDraft();
    draft.zeroCompositeReason = undefined;
    const result = validateShowDirectorDraft(draft, { entries, candidates: new Map() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.code)).toContain('zero_composite_reason_required');
  });

  it('normalizes only mechanical fields and keeps the cover title identical', () => {
    const candidates = new Map([['candidate-1', candidate()]]);
    const plan = buildDirectorPlanFromAgentDraft(compositeDraft(), {
      entries,
      revision: 4,
      globalPrompt: '用户明确要求优先采用可信真实素材',
      candidates,
      now: 123,
    });
    expect(plan.revision).toBe(4);
    expect(plan.userPrompt).toBe('用户明确要求优先采用可信真实素材');
    expect(plan.coverDirection.prompt).toContain(`“${plan.title}”`);
    expect(plan.segments[0]).toMatchObject({
      startMs: 0,
      endMs: 4_000,
      renderStrategy: 'agent-composite',
      strategyConfidence: 0.92,
      compositionAssets: [{ usage: 'required', asset: { id: 'candidate-1' } }],
    });
  });
});

describe('Show Director domain tools', () => {
  it('scopes the same material to each shot so later searches cannot overwrite its provenance', () => {
    const first = scopedDirectorCandidateId('opening', 'shared-asset');
    const second = scopedDirectorCandidateId('evidence', 'shared-asset');

    expect(first).not.toBe(second);
    expect(first).toBe(scopedDirectorCandidateId('opening', 'shared-asset'));
    expect(first).toContain('shared-asset');
  });

  it('submits only through a revision-guarded typed tool', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'show-director-tools-'));
    tempDirs.push(projectDir);
    const project = await loadProjectFile(projectDir);
    let persisted: import('../src/types/director').DirectorPlan | null = null;
    const runtime = await createShowDirectorTools({
      entries,
      settings,
      project,
      projectDir,
      revision: 1,
      roleVersion: '1',
      workflowVersion: '1',
      snapshot: {
        draftRevision: project.production?.draftPlan?.revision ?? null,
        approvedRevision: project.production?.approvedPlan?.revision ?? null,
        productionUpdatedAt: project.production?.updatedAt ?? null,
      },
      loadProduction: async () => project.production,
      persistDraft: async (plan) => { persisted = plan; },
    });
    try {
      const validation = await executeTool(runtime.tools, 'director_validate_draft', { draft: motionDraft() });
      expect(JSON.parse(validation.content[0].text!)).toEqual({ ok: true, issueCount: 0 });
      const result = await executeTool(runtime.tools, 'director_submit_draft', {
        expectedRevision: 1,
        draft: motionDraft(),
      });
      expect(result.terminate).toBe(true);
      expect(JSON.parse(result.content[0].text!)).toMatchObject({ ok: true, revision: 1 });
      expect(persisted).not.toBeNull();
      expect((persisted as unknown as { agentPlanning: { toolCalls: number } }).agentPlanning.toolCalls).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it('reports materialKind without reusing the telemetry event kind field', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'show-director-tool-telemetry-'));
    tempDirs.push(projectDir);
    const project = await loadProjectFile(projectDir);
    const calls: Array<{ name: string; detail?: Record<string, unknown> }> = [];
    const runtime = await createShowDirectorTools({
      entries,
      settings,
      project,
      projectDir,
      revision: 1,
      roleVersion: '3',
      workflowVersion: '3',
      snapshot: {
        draftRevision: null,
        approvedRevision: null,
        productionUpdatedAt: null,
      },
      loadProduction: async () => project.production,
      persistDraft: async () => undefined,
      onToolCall: (name, detail) => calls.push({ name, detail }),
    });
    try {
      await executeTool(runtime.tools, 'director_search_materials', {
        shotKey: 'opening',
        narrativeNeed: '建立城市道路环境',
        selectedTags: ['城市', '道路'],
        query: '城市 道路 行驶',
        kind: 'video',
      });
      expect(calls.at(-1)).toEqual({
        name: 'director_search_materials',
        detail: expect.objectContaining({ materialKind: 'video', selectedTagCount: 2 }),
      });
      expect(calls.at(-1)?.detail).not.toHaveProperty('kind');
    } finally {
      await runtime.dispose();
    }
  });

  it('returns the complete scene-tag catalog to the director without truncating it', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'show-director-tag-catalog-'));
    tempDirs.push(projectDir);
    const sceneTagCatalog = Array.from({ length: 60 }, (_, index) => ({
      tag: `标签-${String(index).padStart(2, '0')}`,
      count: 60 - index,
      kindCounts: { video: 60 - index, image: index },
    }));
    const fetchMock = vi.fn(async () => materialRpcResponse({
      libraryCount: 1,
      itemCount: 665,
      indexedItemCount: 665,
      kindCounts: { video: 500, image: 165 },
      topSceneTags: sceneTagCatalog.slice(0, 50).map(({ tag, count }) => ({ tag, count })),
      sceneTagCatalog,
      libraries: [{ id: 'library-1', name: '素材库', itemCount: 665 }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = await createMaterialRuntime(projectDir);
    try {
      const context = toolPayload(await executeTool(runtime.tools, 'director_get_context', {}));
      expect(context.materialLibrary).toMatchObject({
        itemCount: 665,
        topSceneTags: expect.arrayContaining([expect.objectContaining({ tag: '标签-49' })]),
        sceneTagCatalog: expect.arrayContaining([expect.objectContaining({ tag: '标签-59' })]),
      });
      expect((context.materialLibrary as { sceneTagCatalog: unknown[] }).sceneTagCatalog).toHaveLength(60);
      const missing = toolPayload(await executeTool(runtime.tools, 'director_search_materials', {
        shotKey: 'opening',
        narrativeNeed: '呈现真实道路环境',
        query: '道路环境',
        kind: 'video',
      }));
      expect(missing).toMatchObject({
        ok: false,
        outcome: 'invalid-input',
        code: 'selected_tags_required',
        candidateCount: 0,
      });
      const invalid = toolPayload(await executeTool(runtime.tools, 'director_search_materials', {
        shotKey: 'opening',
        narrativeNeed: '呈现真实道路环境',
        selectedTags: ['目录外标签'],
        query: '目录外标签 道路',
        kind: 'video',
      }));
      expect(invalid).toMatchObject({
        ok: false,
        outcome: 'invalid-input',
        code: 'selected_tags_not_in_catalog',
        unknownTags: ['目录外标签'],
        candidateCount: 0,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  });

  it('serializes the complete material search transaction and persists every candidate safely', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'show-director-search-queue-'));
    tempDirs.push(projectDir);
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { arguments: { query: string; kind: string } };
      };
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      const { query, kind } = body.params.arguments;
      return materialRpcResponse([{
        id: `clip-${query}`,
        filename: `${query}.mp4`,
        path: `/library/${query}.mp4`,
        kind,
        score: 0.8,
      }]);
    }));
    const runtime = await createMaterialRuntime(projectDir);
    try {
      const results = await Promise.all(['opening', 'middle', 'ending'].map((shotKey) => (
        executeTool(runtime.tools, 'director_search_materials', {
          shotKey,
          narrativeNeed: `呈现 ${shotKey} 的真实场景`,
          query: shotKey,
          kind: 'video',
        })
      )));

      expect(maxActive).toBe(1);
      expect(results.map(toolPayload)).toEqual(results.map(() => expect.objectContaining({
        ok: true,
        outcome: 'candidates',
        candidateCount: 1,
        errorCount: 0,
      })));
      const checkpoint = JSON.parse(await fs.readFile(
        path.join(projectDir, '.lingji', 'director-working-draft.json'),
        'utf-8',
      )) as { candidates: unknown[]; materialSearches: unknown[] };
      expect(checkpoint.candidates).toHaveLength(3);
      expect(checkpoint.materialSearches).toHaveLength(3);
    } finally {
      await runtime.dispose();
    }
  });

  it('runs AI-provided related queries serially and records the query that matched each candidate', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'show-director-search-expand-'));
    tempDirs.push(projectDir);
    let active = 0;
    let maxActive = 0;
    const queries: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { arguments: { query: string; kind: string } };
      };
      active += 1;
      maxActive = Math.max(maxActive, active);
      const { query, kind } = body.params.arguments;
      queries.push(query);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (query !== '动态关联空镜') return materialRpcResponse([]);
      return materialRpcResponse(Array.from({ length: 4 }, (_, index) => ({
        id: `shipping-${index}`,
        filename: `shipping-${index}.mp4`,
        path: `/library/shipping-${index}.mp4`,
        kind,
        score: 0.9 - index * 0.05,
      })));
    }));
    const runtime = await createMaterialRuntime(projectDir);
    try {
      const result = toolPayload(await executeTool(runtime.tools, 'director_search_materials', {
        shotKey: 'shipping',
        narrativeNeed: '用海上运输空镜承接出海转场',
        selectedTags: [' 港口 ', '海面', '港口'],
        query: '港口运输场景',
        relatedQueries: ['动态关联空镜', '远景运输动作'],
        kind: 'video',
      }));

      expect(maxActive).toBe(1);
      expect(queries).toEqual(['港口运输场景', '动态关联空镜']);
      expect(result).toMatchObject({
        ok: true,
        outcome: 'candidates',
        selectedTags: ['港口', '海面'],
        queriesTried: ['港口运输场景', '动态关联空镜'],
        kinds: ['video'],
        candidateCount: 4,
      });
      expect(result.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ query: '动态关联空镜', shotKey: 'shipping' }),
      ]));
      const checkpoint = JSON.parse(await fs.readFile(
        path.join(projectDir, '.lingji', 'director-working-draft.json'),
        'utf-8',
      )) as { materialSearches: Array<Record<string, unknown>> };
      expect(checkpoint.materialSearches).toEqual([
        expect.objectContaining({
          selectedTags: ['港口', '海面'],
          queriesTried: ['港口运输场景', '动态关联空镜'],
          kinds: ['video'],
        }),
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it('distinguishes a semantic empty result from a retryable transport failure', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'show-director-search-outcome-'));
    tempDirs.push(projectDir);
    const runtime = await createMaterialRuntime(projectDir);
    try {
      const emptyFetch = vi.fn(async () => materialRpcResponse([]));
      vi.stubGlobal('fetch', emptyFetch);
      const empty = toolPayload(await executeTool(runtime.tools, 'director_search_materials', {
        shotKey: 'opening',
        narrativeNeed: '呈现制造现场',
        query: '制造 现场',
        kind: 'video',
      }));
      expect(empty).toMatchObject({ ok: true, outcome: 'empty', candidateCount: 0, errorCount: 0 });
      expect(empty.queriesTried).toEqual(['制造 现场']);
      expect(emptyFetch).toHaveBeenCalledTimes(1);

      const fetchMock = vi.fn(async () => {
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      });
      vi.stubGlobal('fetch', fetchMock);
      const retryable = toolPayload(await executeTool(runtime.tools, 'director_search_materials', {
        shotKey: 'opening',
        narrativeNeed: '呈现制造现场',
        query: '制造 现场',
        kind: 'video',
      }));
      expect(retryable).toMatchObject({
        ok: false,
        outcome: 'retryable-error',
        candidateCount: 0,
        errorCount: 1,
      });
      expect(String(retryable.next)).toContain('不能把本结果当成零候选');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  });

  it('returns partial when one requested material kind succeeds and the other times out', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'show-director-search-partial-'));
    tempDirs.push(projectDir);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { arguments: { kind: string } };
      };
      if (body.params.arguments.kind === 'image') {
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
      return materialRpcResponse([{
        id: 'factory-video',
        filename: 'factory.mp4',
        path: '/library/factory.mp4',
        kind: 'video',
        score: 0.83,
      }]);
    }));
    const runtime = await createMaterialRuntime(projectDir);
    try {
      const partial = toolPayload(await executeTool(runtime.tools, 'director_search_materials', {
        shotKey: 'opening',
        narrativeNeed: '呈现真实生产动作',
        query: '工厂 生产线',
        kind: 'any',
      }));
      expect(partial).toMatchObject({
        ok: true,
        outcome: 'partial',
        candidateCount: 1,
        errorCount: 1,
      });
      expect(partial.failures).toEqual([
        expect.objectContaining({ kind: 'image', retryable: true }),
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it('restores material-search audit counters with an interrupted working draft', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'show-director-search-resume-'));
    tempDirs.push(projectDir);
    vi.stubGlobal('fetch', vi.fn(async () => materialRpcResponse([])));
    const firstRuntime = await createMaterialRuntime(projectDir);
    await executeTool(firstRuntime.tools, 'director_search_materials', {
      shotKey: 'opening',
      narrativeNeed: '确认真实制造场景是否有独立叙事价值',
      query: '汽车 制造 生产线',
      kind: 'video',
    });
    await firstRuntime.dispose();

    const resumedRuntime = await createMaterialRuntime(projectDir);
    try {
      expect(resumedRuntime.getWorkingDraftStatus()).toMatchObject({
        materialSearchAttempts: 1,
        materialSearchFailures: 0,
      });
    } finally {
      await resumedRuntime.dispose();
    }
  });

  it('assembles, reviews and submits a long working draft without retransmitting the full plan', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'show-director-working-tools-'));
    tempDirs.push(projectDir);
    const project = await loadProjectFile(projectDir);
    const draft = longMotionDraft();
    let persisted: import('../src/types/director').DirectorPlan | null = null;
    const runtime = await createShowDirectorTools({
      entries: longEntries,
      settings,
      project,
      projectDir,
      revision: 3,
      roleVersion: '2',
      workflowVersion: '2',
      snapshot: {
        draftRevision: project.production?.draftPlan?.revision ?? null,
        approvedRevision: project.production?.approvedPlan?.revision ?? null,
        productionUpdatedAt: project.production?.updatedAt ?? null,
      },
      loadProduction: async () => project.production,
      persistDraft: async (plan) => { persisted = plan; },
    });
    try {
      const initialized = await executeTool(runtime.tools, 'director_initialize_working_draft', {
        header: draftHeader(draft),
      });
      expect(JSON.parse(initialized.content[0].text!)).toMatchObject({
        ok: true,
        workingVersion: 1,
        segmentCount: 0,
        message: expect.stringContaining('仅草案，尚未生成画面'),
      });

      await executeTool(runtime.tools, 'director_patch_working_segments', {
        segments: draft.segments.slice(8),
      });
      await executeTool(runtime.tools, 'director_patch_working_segments', {
        segments: draft.segments.slice(0, 8),
      });
      const recut = { ...draft.segments[9], key: 'shot-10-recut', title: '观察 10 重排' };
      const recutResult = await executeTool(runtime.tools, 'director_patch_working_segments', {
        deleteKeys: ['shot-10'],
        segments: [recut],
      });
      expect(JSON.parse(recutResult.content[0].text!)).toMatchObject({
        ok: true,
        deletedKeys: ['shot-10'],
        segmentCount: 10,
        message: expect.stringContaining('分镜规划检查点已记录'),
      });
      const revisedSummary = '排名只是结果，长片按十个观察回看长期积累如何形成今天的位置。';
      const headerUpdate = await executeTool(runtime.tools, 'director_initialize_working_draft', {
        header: { ...draftHeader(draft), summary: revisedSummary },
      });
      expect(JSON.parse(headerUpdate.content[0].text!)).toMatchObject({
        ok: true,
        segmentCount: 10,
        resetSegmentCount: 0,
      });

      const firstPage = await executeTool(runtime.tools, 'director_read_working_draft', {
        offset: 0,
        limit: 3,
      });
      const firstPagePayload = JSON.parse(firstPage.content[0].text!);
      expect(firstPagePayload).not.toHaveProperty('header');
      expect(firstPagePayload).toMatchObject({ segmentCount: 10, nextOffset: 3 });
      expect(firstPagePayload.segments.map((segment: { key: string }) => segment.key)).toEqual([
        'shot-1',
        'shot-2',
        'shot-3',
      ]);
      const lastPage = await executeTool(runtime.tools, 'director_read_working_draft', {
        offset: 8,
        limit: 3,
        includeHeader: true,
      });
      const lastPagePayload = JSON.parse(lastPage.content[0].text!);
      expect(lastPagePayload.header.title).toBe(draft.title);
      expect(lastPagePayload.header.summary).toBe(revisedSummary);
      expect(lastPagePayload.segments.map((segment: { key: string }) => segment.key)).toEqual([
        'shot-9',
        'shot-10-recut',
      ]);
      expect(lastPagePayload.nextOffset).toBeNull();

      const validation = await executeTool(runtime.tools, 'director_validate_working_draft', {});
      expect(JSON.parse(validation.content[0].text!)).toMatchObject({
        ok: true,
        segmentCount: 10,
      });
      await executeTool(runtime.tools, 'director_patch_working_segments', {
        segments: [{ ...draft.segments[4], title: '观察 5 已修订' }],
      });
      const staleSubmit = await executeTool(runtime.tools, 'director_submit_working_draft', {
        expectedRevision: 3,
      });
      expect(JSON.parse(staleSubmit.content[0].text!)).toMatchObject({
        ok: false,
        code: 'working_draft_validation_required',
      });
      expect(persisted).toBeNull();

      await executeTool(runtime.tools, 'director_validate_working_draft', {});
      const submitted = await executeTool(runtime.tools, 'director_submit_working_draft', {
        expectedRevision: 3,
      });
      expect(submitted.terminate).toBe(true);
      expect(JSON.parse(submitted.content[0].text!)).toMatchObject({
        ok: true,
        revision: 3,
        segmentCount: 10,
      });
      expect(persisted).not.toBeNull();
      const saved = persisted as unknown as import('../src/types/director').DirectorPlan;
      expect(saved.segments).toHaveLength(10);
      expect(saved.segments[4].title).toBe('观察 5 已修订');
      expect(saved.segments[9].title).toBe('观察 10 重排');
      expect(saved.agentPlanning).toMatchObject({
        roleVersion: '2',
        workflowVersion: '2',
        repairRounds: 1,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('guards working drafts against missing state, oversized batches and project revision conflicts', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'show-director-working-guards-'));
    tempDirs.push(projectDir);
    const project = await loadProjectFile(projectDir);
    let persisted = false;
    const runtime = await createShowDirectorTools({
      entries,
      settings,
      project,
      projectDir,
      revision: 1,
      roleVersion: '2',
      workflowVersion: '2',
      snapshot: {
        draftRevision: project.production?.draftPlan?.revision ?? null,
        approvedRevision: project.production?.approvedPlan?.revision ?? null,
        productionUpdatedAt: project.production?.updatedAt ?? null,
      },
      loadProduction: async () => ({
        ...project.production!,
        updatedAt: (project.production?.updatedAt ?? 0) + 1,
      }),
      persistDraft: async () => { persisted = true; },
    });
    try {
      const missing = await executeTool(runtime.tools, 'director_submit_working_draft', {
        expectedRevision: 1,
      });
      expect(JSON.parse(missing.content[0].text!)).toMatchObject({
        ok: false,
        code: 'working_draft_not_initialized',
      });

      const draft = motionDraft();
      await executeTool(runtime.tools, 'director_initialize_working_draft', {
        header: draftHeader(draft),
      });
      const oversized = await executeTool(runtime.tools, 'director_patch_working_segments', {
        segments: Array.from({ length: 9 }, (_, index) => ({
          ...draft.segments[0],
          key: `oversized-${index + 1}`,
        })),
      });
      expect(JSON.parse(oversized.content[0].text!)).toMatchObject({
        ok: false,
        code: 'working_draft_batch_too_large',
        maximum: 8,
      });

      await executeTool(runtime.tools, 'director_patch_working_segments', {
        segments: draft.segments,
      });
      await executeTool(runtime.tools, 'director_validate_working_draft', {});
      const conflicted = await executeTool(runtime.tools, 'director_submit_working_draft', {
        expectedRevision: 1,
      });
      expect(conflicted.terminate).toBe(true);
      expect(JSON.parse(conflicted.content[0].text!)).toMatchObject({
        ok: false,
        code: 'director_revision_conflict',
      });
      expect(persisted).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it('restores an interrupted working draft from disk and removes the checkpoint after submit', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'show-director-working-resume-'));
    tempDirs.push(projectDir);
    const project = await loadProjectFile(projectDir);
    const runtimeOptions = {
      entries,
      settings,
      project,
      projectDir,
      revision: 2,
      roleVersion: '2',
      workflowVersion: '2',
      snapshot: {
        draftRevision: project.production?.draftPlan?.revision ?? null,
        approvedRevision: project.production?.approvedPlan?.revision ?? null,
        productionUpdatedAt: project.production?.updatedAt ?? null,
      },
      loadProduction: async () => project.production,
    };
    const draft = motionDraft();
    const firstRuntime = await createShowDirectorTools({
      ...runtimeOptions,
      persistDraft: async () => undefined,
    });
    await executeTool(firstRuntime.tools, 'director_initialize_working_draft', {
      header: draftHeader(draft),
    });
    await executeTool(firstRuntime.tools, 'director_patch_working_segments', {
      segments: draft.segments,
    });
    expect(firstRuntime.getWorkingDraftStatus()).toMatchObject({
      initialized: true,
      segmentCount: 1,
      firstEntryIndex: 1,
      lastEntryIndex: 2,
    });
    await firstRuntime.dispose();

    const checkpoint = path.join(projectDir, '.lingji', 'director-working-draft.json');
    await expect(fs.access(checkpoint)).resolves.toBeUndefined();

    let persisted: import('../src/types/director').DirectorPlan | null = null;
    const resumedRuntime = await createShowDirectorTools({
      ...runtimeOptions,
      persistDraft: async (plan) => { persisted = plan; },
    });
    try {
      expect(resumedRuntime.getWorkingDraftStatus()).toMatchObject({
        initialized: true,
        validated: false,
        segmentCount: 1,
        firstEntryIndex: 1,
        lastEntryIndex: 2,
      });
      const contextResult = await executeTool(resumedRuntime.tools, 'director_get_context', {});
      expect(JSON.parse(contextResult.content[0].text!)).toMatchObject({
        workingDraftCheckpoint: {
          restored: true,
          segmentCount: 1,
          validated: false,
        },
      });
      await executeTool(resumedRuntime.tools, 'director_initialize_working_draft', {
        header: draftHeader(draft),
      });
      const page = await executeTool(resumedRuntime.tools, 'director_read_working_draft', {
        offset: 0,
        limit: 8,
      });
      expect(JSON.parse(page.content[0].text!).segments).toHaveLength(1);
      await executeTool(resumedRuntime.tools, 'director_validate_working_draft', {});
      const submitted = await executeTool(resumedRuntime.tools, 'director_submit_working_draft', {
        expectedRevision: 2,
      });
      expect(submitted.terminate).toBe(true);
      expect(persisted).not.toBeNull();
      await expect(fs.access(checkpoint)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await resumedRuntime.dispose();
    }
  });
});

describe('Show Director orchestration', () => {
  it('uses working-draft state to rescue an unfinished Pi turn without restarting', () => {
    const base = {
      initialized: false,
      workingVersion: 0,
      validated: false,
      segmentCount: 0,
      firstEntryIndex: null,
      lastEntryIndex: null,
      expectedEntryCount: 10,
      candidateCount: 24,
      inspectedCandidateCount: 2,
    };
    expect(buildShowDirectorCompletionPrompt(base, 10)).toContain('立即调用 director_initialize_working_draft');
    expect(buildShowDirectorCompletionPrompt({ ...base, initialized: true, workingVersion: 1 }, 10))
      .toContain('立即调用 director_patch_working_segments');
    expect(buildShowDirectorCompletionPrompt({
      ...base,
      initialized: true,
      workingVersion: 2,
      segmentCount: 4,
      firstEntryIndex: 1,
      lastEntryIndex: 6,
    }, 10)).toContain('字幕覆盖尚未完成');
    expect(buildShowDirectorCompletionPrompt({
      ...base,
      initialized: true,
      workingVersion: 3,
      segmentCount: 7,
      firstEntryIndex: 1,
      lastEntryIndex: 10,
    }, 10)).toContain('调用 director_validate_working_draft');
    expect(buildShowDirectorCompletionPrompt({
      ...base,
      initialized: true,
      workingVersion: 3,
      validated: true,
      segmentCount: 7,
      firstEntryIndex: 1,
      lastEntryIndex: 10,
    }, 10)).toContain('立即调用 director_submit_working_draft');
  });

  it('uses an independently bound image-capable production.director model', () => {
    const directorProvider: LLMProvider = {
      id: 'director-vision',
      name: 'Director Vision',
      type: 'openai_compatible',
      baseUrl: 'https://director.invalid/v1',
      apiKey: 'test',
      models: ['director-model'],
      pi: { model: { input: ['text', 'image'] } },
    };
    const directorSettings = {
      defaultProviderId: 'text-provider',
      defaultModel: 'text-model',
      llmProviders: [{
        id: 'text-provider',
        name: 'Text only',
        type: 'openai_compatible',
        baseUrl: 'https://text.invalid/v1',
        apiKey: 'test',
        models: ['text-model'],
      }, directorProvider],
      promptBindings: {
        'planning.segment': { providerId: 'text-provider', model: 'text-model' },
        'production.director': { providerId: 'director-vision', model: 'director-model' },
      },
    } as unknown as AISettings;

    expect(resolveShowDirectorModel(directorSettings, null)).toBe(
      'director-vision/director-model',
    );
    expect(projectProviderToPi(directorProvider)?.entry.models[0].input).toContain('image');
  });

  it('keeps planning.segment as a visual fallback after an explicit text-only director binding', () => {
    const fallbackSettings = {
      defaultProviderId: 'text-provider',
      defaultModel: 'text-model',
      llmProviders: [{
        id: 'text-provider',
        name: 'Text only',
        type: 'openai_compatible',
        baseUrl: 'https://text.invalid/v1',
        apiKey: 'test',
        models: ['text-model'],
      }, {
        id: 'vision-provider',
        name: 'Planning Vision',
        type: 'openai_compatible',
        baseUrl: 'https://vision.invalid/v1',
        apiKey: 'test',
        models: ['vision-model'],
        pi: { model: { input: ['text', 'image'] } },
      }],
      promptBindings: {
        'production.director': { providerId: 'text-provider', model: 'text-model' },
        'planning.segment': { providerId: 'vision-provider', model: 'vision-model' },
      },
    } as unknown as AISettings;

    expect(resolveShowDirectorModelCandidates(fallbackSettings, null)).toEqual([
      'text-provider/text-model',
      'vision-provider/vision-model',
    ]);
  });

  it('reuses the established planning model when production.director is not bound yet', () => {
    const compatibilitySettings = {
      defaultProviderId: 'text-provider',
      defaultModel: 'text-model',
      llmProviders: [{
        id: 'text-provider',
        name: 'Text only',
        type: 'openai_compatible',
        baseUrl: 'https://text.invalid/v1',
        apiKey: 'test',
        models: ['text-model'],
      }, {
        id: 'vision-provider',
        name: 'Existing planning model',
        type: 'openai_compatible',
        baseUrl: 'https://vision.invalid/v1',
        apiKey: 'test',
        models: ['vision-model'],
        pi: { model: { input: ['text', 'image'] } },
      }],
      promptBindings: {
        'planning.segment': { providerId: 'vision-provider', model: 'vision-model' },
      },
    } as unknown as AISettings;

    expect(resolveShowDirectorModel(compatibilitySettings, null)).toBe(
      'vision-provider/vision-model',
    );
  });

  it('gives Pi only the domain tools and persists the submitted draft', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'show-director-run-'));
    tempDirs.push(projectDir);
    const resourcesRoot = path.resolve('resources/pi-agents');
    let exposedTools: string[] = [];
    let requiresImages = false;
    const telemetry = { emit: vi.fn() };
    const plan = await runShowDirectorAgent({
      userDataPath: projectDir,
      projectDir,
      resourcesRoot,
      entries,
      settings,
      revision: 1,
      telemetry,
      deps: {
        ensureConfig: async () => undefined,
        ensureRoles: async () => undefined,
        loadRole: async () => ({
          name: 'show-director',
          version: '2',
          tools: [...SHOW_DIRECTOR_TOOL_NAMES],
          systemPrompt: '测试总导演角色',
        }),
        createSession: async (input) => {
          exposedTools = input.tools;
          requiresImages = input.requireImageInput === true
            && Array.isArray(input.modelCandidates);
          return {
            prompt: async () => {
              const tools = input.customTools ?? [];
              input.onEvent?.({
                type: 'tool_result',
                toolUseId: 'search-1',
                name: 'director_search_materials',
                content: JSON.stringify({
                  ok: false,
                  outcome: 'retryable-error',
                  candidateCount: 0,
                  errorCount: 1,
                  durationMs: 15_001,
                }),
                isError: false,
              });
              await executeTool(tools, 'director_get_context', {});
              await executeTool(tools, 'director_initialize_working_draft', {
                header: draftHeader(motionDraft()),
              });
              await executeTool(tools, 'director_patch_working_segments', {
                segments: motionDraft().segments,
              });
              await executeTool(tools, 'director_validate_working_draft', {});
              await executeTool(tools, 'director_submit_working_draft', { expectedRevision: 1 });
              return '';
            },
            abort: () => undefined,
            dispose: () => undefined,
          };
        },
      },
    });
    expect(exposedTools).toEqual([...SHOW_DIRECTOR_TOOL_NAMES]);
    expect(exposedTools).not.toContain('bash');
    expect(exposedTools).not.toContain('write');
    expect(requiresImages).toBe(true);
    expect(telemetry.emit).toHaveBeenCalledWith('director.agent.tool-result', {
      name: 'director_search_materials',
      ok: false,
      outcome: 'retryable-error',
      candidateCount: 0,
      errorCount: 1,
      durationMs: 15_001,
    });
    expect(plan.agentPlanning).toMatchObject({ roleVersion: '2', workflowVersion: '8', toolCalls: 5 });
    const persisted = await loadProjectFile(projectDir);
    expect(persisted.production?.draftPlan?.title).toBe(motionDraft().title);
    expect(persisted.production?.workflow.stage).toBe('director-review');
  });
});
