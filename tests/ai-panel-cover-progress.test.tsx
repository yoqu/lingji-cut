// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AIPanel } from "../src/components/AIPanel";
import { useTaskProgressStore } from "../src/store/task-progress";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const mocks = vi.hoisted(() => {
  const analysisResult = {
    segments: [],
    cards: [],
    coverPrompts: ["一张克制的科技播客封面"],
    summary: "节目摘要",
    keywords: ["科技"],
  };
  return {
    loadAISettings: vi.fn(),
    generateCoverImages: vi.fn(),
    regenerateCoverPrompt: vi.fn(),
    aiState: {
      analysisResult,
      isAnalyzing: false,
      analysisError: null as string | null,
      coverCandidates: [],
      isGeneratingCovers: false,
      incrementalAnalysis: { active: false, skeletons: [], cards: [] },
      activeTab: "cover" as const,
      projectBindings: {},
      setAnalysisResult: vi.fn(),
      setPlannedAnalysisResult: vi.fn(),
      setAnalyzing: vi.fn(),
      setAnalysisError: vi.fn(),
      setCoverCandidates: vi.fn(),
      selectCover: vi.fn(),
      setGeneratingCovers: vi.fn(),
      setActiveTab: vi.fn(),
      beginIncrementalAnalysis: vi.fn(),
      endIncrementalAnalysis: vi.fn(),
      clearAnalysis: vi.fn(),
    },
    timelineState: {
      srtEntries: [{ index: 1, startMs: 0, endMs: 2_000, text: "科技节目字幕" }],
      timeline: {
        width: 1920,
        height: 1080,
        podcast: { srtPath: "/tmp/demo.srt", durationMs: 2_000 },
        tracks: [],
        overlays: [],
      },
      addAICardsToTimeline: vi.fn(),
      removeAICardOverlaysBySourceIds: vi.fn(),
      setGlobalBackground: vi.fn(),
    },
  };
});

vi.mock("../src/store/ai", () => ({
  useAIStore: Object.assign(() => mocks.aiState, { getState: () => mocks.aiState }),
  loadAISettings: mocks.loadAISettings,
}));

vi.mock("../src/store/timeline", () => ({
  useTimelineStore: () => mocks.timelineState,
  getProjectDir: () => "/tmp/project",
}));

let container: HTMLDivElement;
let root: Root;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AIPanel compact={false} />);
    await Promise.resolve();
  });
}

function findButton(label: string) {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(label),
  );
}

function findTask(label: string) {
  return [...useTaskProgressStore.getState().tasks.values()].find(
    (task) => task.label === label,
  );
}

beforeEach(() => {
  mocks.loadAISettings.mockReset().mockResolvedValue({
    llmProviders: [{
      id: "llm-1",
      name: "Test LLM",
      type: "openai_compatible",
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      models: ["model-1"],
    }],
    defaultProviderId: "llm-1",
    defaultModel: "model-1",
    imageProviders: [{ id: "image-1" }],
    defaultImageProviderId: "image-1",
  });
  mocks.generateCoverImages.mockReset().mockResolvedValue([
    {
      id: "cover-1",
      prompt: "一张克制的科技播客封面",
      imageUrl: "/tmp/cover.png",
      selected: true,
    },
  ]);
  mocks.regenerateCoverPrompt.mockReset().mockResolvedValue(["重写后的封面提示词"]);
  mocks.aiState.setAnalysisError.mockReset();
  mocks.aiState.setGeneratingCovers.mockReset();
  useTaskProgressStore.setState({
    tasks: new Map(),
    panelOpen: false,
    primaryTask: null,
    activeCount: 0,
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    generateCoverImages: mocks.generateCoverImages,
    regenerateCoverPrompt: mocks.regenerateCoverPrompt,
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  for (const task of useTaskProgressStore.getState().tasks.values()) {
    useTaskProgressStore.getState().removeTask(task.id);
  }
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("AIPanel cover progress", () => {
  it("tracks cover image generation through the unified task store", async () => {
    await mount();

    await act(async () => {
      findButton("生成封面图")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.generateCoverImages).toHaveBeenCalledTimes(1);
    expect(findTask("生成封面图")).toMatchObject({
      category: "cover",
      mode: "indeterminate",
      phase: "已生成 1 张封面图",
      status: "completed",
    });
  });

  it("tracks prompt rewriting and ignores a duplicate trigger", async () => {
    let resolvePrompt: ((value: string[]) => void) | null = null;
    mocks.regenerateCoverPrompt.mockImplementation(() => new Promise<string[]>((resolve) => {
      resolvePrompt = resolve;
    }));
    await mount();

    const button = findButton("重写提示词");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.regenerateCoverPrompt).toHaveBeenCalledTimes(1);
    expect(findTask("重写封面提示词")).toMatchObject({
      category: "cover",
      phase: "分析字幕并重写提示词",
      status: "active",
    });

    await act(async () => {
      resolvePrompt?.(["重写后的封面提示词"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findTask("重写封面提示词")).toMatchObject({
      phase: "封面提示词已重写",
      status: "completed",
    });
  });

  it("fails the cover task and keeps the inline error", async () => {
    mocks.generateCoverImages.mockRejectedValue(new Error("图像服务暂时不可用"));
    await mount();

    await act(async () => {
      findButton("生成封面图")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findTask("生成封面图")).toMatchObject({
      status: "error",
      error: "图像服务暂时不可用",
    });
    expect(mocks.aiState.setAnalysisError).toHaveBeenCalledWith("图像服务暂时不可用");
  });
});
