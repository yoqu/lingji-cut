// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SubtitleInspector } from "../src/components/SubtitleInspector";
import { useTaskProgressStore } from "../src/store/task-progress";
import { createDefaultSubtitleStyle } from "../src/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  generateHighlights: vi.fn(),
  setSubtitleHighlights: vi.fn(),
  updateSubtitleStyle: vi.fn(),
  timelineState: {
    srtEntries: [{ index: 1, startMs: 0, endMs: 2_000, text: "这里是关键词" }],
    originalSrtEntries: [{ index: 1, startMs: 0, endMs: 2_000, text: "这里是关键词" }],
    setSubtitleHighlights: vi.fn(),
    setSubtitleMaxChars: vi.fn(),
    setAutoResegment: vi.fn(),
    resegmentSubtitles: vi.fn(() => ({ droppedHighlights: 0 })),
    restoreOriginalSubtitles: vi.fn(),
    timeline: {
      podcast: { srtPath: "/tmp/demo.srt" },
      subtitle: null as unknown,
      subtitleHighlights: [] as unknown[],
    },
    updateSubtitleStyle: vi.fn(),
  },
}));

vi.mock("../src/store/ai", () => ({
  loadAISettings: vi.fn(async () => ({
    llmProviders: [{
      id: "provider-1",
      name: "Test",
      type: "openai_compatible",
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      models: ["model-1"],
    }],
    defaultProviderId: "provider-1",
    defaultModel: "model-1",
  })),
}));

vi.mock("../src/store/timeline", () => ({
  useTimelineStore: () => mocks.timelineState,
}));

vi.mock("../src/lib/subtitle-highlight-runner", () => ({
  generateSubtitleHighlights: mocks.generateHighlights,
}));

let container: HTMLDivElement;
let root: Root;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SubtitleInspector />);
  });
}

function progressTask() {
  return [...useTaskProgressStore.getState().tasks.values()].find(
    (task) => task.label === "生成关键词高亮",
  );
}

beforeEach(() => {
  mocks.generateHighlights.mockReset();
  mocks.timelineState.setSubtitleHighlights.mockReset();
  mocks.timelineState.updateSubtitleStyle.mockReset();
  mocks.timelineState.timeline.subtitle = createDefaultSubtitleStyle();
  mocks.timelineState.timeline.subtitleHighlights = [];
  useTaskProgressStore.setState({
    tasks: new Map(),
    panelOpen: false,
    primaryTask: null,
    activeCount: 0,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  for (const task of useTaskProgressStore.getState().tasks.values()) {
    useTaskProgressStore.getState().removeTask(task.id);
  }
});

describe("SubtitleInspector unified progress", () => {
  it("reports real batch progress and completes with the generated result", async () => {
    mocks.generateHighlights.mockImplementation(async (_entries, _settings, options) => {
      options.onProgress?.({
        batchIndex: 1,
        batchTotal: 1,
        processedEntries: 1,
        totalEntries: 1,
        percent: 100,
      });
      return [{
        entryIndex: 1,
        highlightText: "关键词",
        start: 3,
        end: 6,
        sourceText: "这里是关键词",
      }];
    });
    await mount();

    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("生成关键词高亮"),
    );
    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.generateHighlights).toHaveBeenCalledTimes(1);
    expect(mocks.timelineState.setSubtitleHighlights).toHaveBeenCalledTimes(1);
    expect(mocks.timelineState.updateSubtitleStyle).toHaveBeenCalledWith({
      highlightEnabled: true,
    });
    expect(progressTask()).toMatchObject({
      category: "ai-analyze",
      mode: "determinate",
      progress: 100,
      phase: "已生成 1 个关键词高亮",
      status: "completed",
    });
    expect(container.textContent).toContain("已生成 1 个关键词高亮");
  });

  it("keeps an actionable inline message and fails the shared task", async () => {
    mocks.generateHighlights.mockRejectedValue(new Error("模型服务暂时不可用"));
    await mount();

    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("生成关键词高亮"),
    );
    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(progressTask()).toMatchObject({
      status: "error",
      error: "模型服务暂时不可用",
    });
    expect(container.textContent).toContain("模型服务暂时不可用");
    expect(container.textContent).toContain("请检查 AI 配置或网络后重新生成");
    expect(container.textContent).toContain("重新生成");
  });
});
