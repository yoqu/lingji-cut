import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useScriptStore } from '../src/store/script';

function createStorageMock() {
  const storage = new Map<string, string>();

  return {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  };
}

describe('script store', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageMock());
    useScriptStore.getState().reset();
  });

  it('tracks file dirty/conflict state', () => {
    const store = useScriptStore.getState();

    store.setOpenedFile('original.md');
    store.setFileDirty('original.md', true);
    store.setFileConflict('original.md', true);
    store.stashExternalContent('original.md', 'external version');

    expect(useScriptStore.getState().openedFile).toBe('original.md');
    expect(useScriptStore.getState().fileDirtyMap).toEqual({ 'original.md': true });
    expect(useScriptStore.getState().fileConflictMap).toEqual({ 'original.md': true });
    expect(useScriptStore.getState().stashedContent).toEqual({
      'original.md': 'external version',
    });

    store.clearConflict('original.md');
    store.clearAllDirty();

    expect(useScriptStore.getState().fileDirtyMap).toEqual({});
    expect(useScriptStore.getState().fileConflictMap).toEqual({});
    expect(useScriptStore.getState().stashedContent).toEqual({});
  });

  it('clears transient file state when restoring persisted script state', () => {
    const store = useScriptStore.getState();

    store.setOpenedFile('script.md');
    store.setFileDirty('script.md', true);
    store.setFileConflict('script.md', true);
    store.stashExternalContent('script.md', 'external');

    store.restoreState({
      projectDir: '/tmp/script-project',
      originalText: '# original',
      scriptText: '# script',
      selectedTemplate: 'news-broadcast',
      annotations: [],
      workspaceFiles: { hasOriginalFile: true, hasScriptFile: true },
      reviewState: 'idle',
      scriptDocVersion: 0,
    });

    expect(useScriptStore.getState().projectDir).toBe('/tmp/script-project');
    expect(useScriptStore.getState().openedFile).toBeNull();
    expect(useScriptStore.getState().fileDirtyMap).toEqual({});
    expect(useScriptStore.getState().fileConflictMap).toEqual({});
    expect(useScriptStore.getState().stashedContent).toEqual({});
    expect(useScriptStore.getState().workspaceFiles).toEqual({
      hasOriginalFile: true,
      hasScriptFile: true,
    });
    expect(useScriptStore.getState().reviewState).toBe('idle');
    expect(useScriptStore.getState().scriptDocVersion).toBe(0);
  });

  it('marks script file dirty after accepting an annotation change', () => {
    useScriptStore.setState({
      scriptText: '原始内容',
      annotations: [
        {
          id: 'annotation-1',
          startOffset: 0,
          endOffset: 4,
          originalText: '原始内容',
          quotedText: '原始内容',
          docVersion: 0,
          issue: '语气可以更口语化',
          suggestion: '修改后的内容',
          severity: 'info',
          status: 'pending',
        },
      ],
    });

    useScriptStore.getState().acceptAnnotation('annotation-1');

    expect(useScriptStore.getState().scriptText).toBe('修改后的内容');
    expect(useScriptStore.getState().annotations[0]?.status).toBe('accepted');
    expect(useScriptStore.getState().fileDirtyMap).toEqual({ 'script.md': true });
  });

  describe('agent operation state', () => {
    it('startAgentOperation sets operating state and editor readOnly', () => {
      useScriptStore.getState().startAgentOperation('generate');
      const state = useScriptStore.getState();
      expect(state.agentOperation.isOperating).toBe(true);
      expect(state.agentOperation.operationType).toBe('generate');
      expect(state.editorAgent.readOnly).toBe(true);
    });

    it('stopAgentOperation can preserve stopped stream for interrupted UI', () => {
      useScriptStore.getState().startAgentOperation('review');
      useScriptStore.getState().setActiveStream({
        streamId: 'stream-1',
        filePath: 'script.md',
        kind: 'generate',
        phase: 'stopped',
      });
      useScriptStore.getState().stopAgentOperation({ resetStream: false });
      const state = useScriptStore.getState();
      expect(state.agentOperation.isOperating).toBe(false);
      expect(state.activeStream.phase).toBe('stopped');
    });

    it('clearActiveStream resets stream state', () => {
      useScriptStore.getState().setActiveStream({
        streamId: 'stream-1',
        filePath: 'script.md',
        kind: 'update',
        phase: 'awaiting_commit',
      });
      useScriptStore.getState().clearActiveStream();
      const state = useScriptStore.getState();
      expect(state.activeStream.phase).toBe('idle');
    });

    it('markReviewStale transitions reviewState to stale', () => {
      useScriptStore.setState({ reviewState: 'issues' });
      useScriptStore.getState().markReviewStale();
      expect(useScriptStore.getState().reviewState).toBe('stale');
    });

    it('bumpScriptDocVersion increments doc version', () => {
      useScriptStore.setState({ scriptDocVersion: 2 });
      useScriptStore.getState().bumpScriptDocVersion();
      expect(useScriptStore.getState().scriptDocVersion).toBe(3);
    });
  });

  describe('workspace files state', () => {
    it('setWorkspaceFiles merges partial state', () => {
      useScriptStore.getState().setWorkspaceFiles({ hasOriginalFile: true });
      expect(useScriptStore.getState().workspaceFiles).toEqual({
        hasOriginalFile: true,
        hasScriptFile: false,
      });
    });
  });

  describe('editor agent state', () => {
    it('setEditorAgent merges partial state', () => {
      useScriptStore.getState().setEditorAgent({ readOnly: true });
      expect(useScriptStore.getState().editorAgent).toEqual({
        readOnly: true,
        virtualCursorPos: null,
        streamingActive: false,
      });
    });

    it('startAgentOperation with review does not set streamingActive', () => {
      useScriptStore.getState().startAgentOperation('review');
      expect(useScriptStore.getState().editorAgent.streamingActive).toBe(false);
    });

    it('startAgentOperation with generate sets streamingActive', () => {
      useScriptStore.getState().startAgentOperation('generate');
      expect(useScriptStore.getState().editorAgent.streamingActive).toBe(true);
    });
  });

  describe('active stream state', () => {
    it('setActiveStream merges partial state', () => {
      useScriptStore.getState().setActiveStream({
        streamId: 'stream-42',
        kind: 'update',
        phase: 'playing',
      });
      expect(useScriptStore.getState().activeStream).toEqual({
        streamId: 'stream-42',
        filePath: null,
        kind: 'update',
        phase: 'playing',
      });
    });

    it('stopAgentOperation resets stream by default', () => {
      useScriptStore.getState().startAgentOperation('generate');
      useScriptStore.getState().setActiveStream({
        streamId: 'stream-1',
        filePath: 'script.md',
        kind: 'rewrite',
        phase: 'playing',
      });
      useScriptStore.getState().stopAgentOperation();
      expect(useScriptStore.getState().activeStream.phase).toBe('idle');
      expect(useScriptStore.getState().activeStream.streamId).toBeNull();
      expect(useScriptStore.getState().activeStream.kind).toBeNull();
    });
  });

  describe('review state', () => {
    it('setReviewState sets review state directly', () => {
      useScriptStore.getState().setReviewState('pending');
      expect(useScriptStore.getState().reviewState).toBe('pending');
    });
  });

  describe('workbench stage override', () => {
    it('stores and clears the manual stage override', () => {
      useScriptStore.getState().setManualStageOverride('review_clean');
      expect(useScriptStore.getState().manualStageOverride).toBe('review_clean');

      useScriptStore.getState().clearManualStageOverride();
      expect(useScriptStore.getState().manualStageOverride).toBeNull();
    });
  });

  describe('reset clears new state fields', () => {
    it('reset restores all new fields to initial values', () => {
      useScriptStore.getState().startAgentOperation('generate');
      useScriptStore.getState().setReviewState('issues');
      useScriptStore.getState().bumpScriptDocVersion();
      useScriptStore.getState().setWorkspaceFiles({ hasOriginalFile: true });

      useScriptStore.getState().reset();

      const state = useScriptStore.getState();
      expect(state.agentOperation.isOperating).toBe(false);
      expect(state.reviewState).toBe('idle');
      expect(state.scriptDocVersion).toBe(0);
      expect(state.workspaceFiles.hasOriginalFile).toBe(false);
      expect(state.editorAgent.readOnly).toBe(false);
      expect(state.activeStream.phase).toBe('idle');
      expect(state.activeStream.kind).toBeNull();
    });
  });

  describe('video import state', () => {
    it('tracks the latest video import progress and result', () => {
      useScriptStore.getState().setVideoImportProgress({
        importId: 'douyin_001',
        sourceType: 'douyin',
        status: 'transcribing',
        progress: 72,
        stepLabel: '正在进行 bcut 转录',
      });
      useScriptStore.getState().setLastVideoImport({
        importId: 'douyin_001',
        sourceType: 'douyin',
        videoId: '001',
        title: '测试视频',
        projectDir: '/tmp/demo',
        importDir: '/tmp/demo/imports/douyin/001',
        videoPath: '/tmp/demo/imports/douyin/001/video.mp4',
        audioPath: '/tmp/demo/imports/douyin/001/audio.mp3',
        transcriptPath: '/tmp/demo/imports/douyin/001/transcript.md',
        transcriptSrtPath: '/tmp/demo/imports/douyin/001/transcript.srt',
        originalPath: '/tmp/demo/original.md',
        sourceMetadataPath: '/tmp/demo/imports/douyin/001/source.json',
        resultMetadataPath: '/tmp/demo/imports/douyin/001/import-result.json',
        previewMetadataPath: '/tmp/demo/imports/douyin/001/preview.json',
        sourceUrl: 'https://v.douyin.com/demo',
        resolvedPageUrl: 'https://www.douyin.com/video/001',
        engine: 'bcut',
        syncedToOriginal: true,
        createdAt: '2026-04-10T00:00:00.000Z',
      });

      const state = useScriptStore.getState();
      expect(state.videoImportStatus).toBe('transcribing');
      expect(state.videoImportProgress?.progress).toBe(72);
      expect(state.lastVideoImport?.videoId).toBe('001');
    });

    it('reset clears video import state', () => {
      useScriptStore.getState().setVideoImportProgress({
        importId: 'douyin_001',
        sourceType: 'douyin',
        status: 'error',
        progress: 100,
        stepLabel: '失败',
        error: 'network',
      });

      useScriptStore.getState().reset();

      const state = useScriptStore.getState();
      expect(state.videoImportStatus).toBeNull();
      expect(state.videoImportProgress).toBeNull();
      expect(state.lastVideoImport).toBeNull();
    });
  });

  describe('clearProjectSession', () => {
    it('fully clears the active project and transient editor state', () => {
      useScriptStore.setState({
        projectDir: '/tmp/old-project',
        originalText: '旧原稿',
        scriptText: '旧口播稿',
        openedFile: 'script.md',
        workspaceFiles: { hasOriginalFile: true, hasScriptFile: true },
        reviewState: 'issues',
      });

      useScriptStore.getState().clearProjectSession();

      const state = useScriptStore.getState();
      expect(state.projectDir).toBeNull();
      expect(state.originalText).toBe('');
      expect(state.scriptText).toBe('');
      expect(state.openedFile).toBeNull();
      expect(state.workspaceFiles).toEqual({
        hasOriginalFile: false,
        hasScriptFile: false,
      });
      expect(state.reviewState).toBe('idle');
    });
  });
});
