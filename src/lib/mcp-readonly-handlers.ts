import { useAIStore } from '../store/ai';
import { useScriptStore } from '../store/script';
import { getRoleById } from './script-templates';
import { SCRIPT_TEMPLATE_SEEDS } from './prompts/script-template-defaults';

/**
 * MCP 只读型 Handler（App 启动时全局注册一次，独立于 ScriptWorkbench 页面生命周期）。
 * 这些 handler 只依赖 Zustand store，不依赖 ScriptWorkbench 的 ref/回调，
 * 必须全局注册，避免用户在 settings 等页面时 ScriptWorkbench 未挂载导致 MCP 工具调用卡死。
 * 返回取消注册函数。
 */
export function registerMcpReadonlyHandlers(): () => void {
  if (!window.mcpAPI) return () => {};
  const unsubs: Array<() => void> = [];

  // 获取编辑器状态
  unsubs.push(
    window.mcpAPI.onGetEditorState((payload: any) => {
      const state = useScriptStore.getState();
      window.mcpAPI!.reply(payload._replyChannel, {
        projectDir: state.projectDir,
        openFiles: state.fileEntries.map((f) => f.name),
        activeFile: state.openedFile,
        cursorPosition: null,
      });
    }),
  );

  // 读取脚本文件内容
  unsubs.push(
    window.mcpAPI.onReadScript((payload: any) => {
      const state = useScriptStore.getState();
      let filePath = payload.filePath || state.openedFile || 'script.md';
      // 标准化：将绝对路径转为项目目录下的相对路径
      if (state.projectDir && filePath.startsWith(state.projectDir)) {
        filePath = filePath.slice(state.projectDir.length).replace(/^\//, '');
      }
      let content = '';
      if (filePath === 'script.md') {
        content = state.scriptText;
      } else if (filePath === 'original.md') {
        content = state.originalText;
      } else {
        content = state.extraFileContents[filePath] ?? '';
      }
      const lineCount = content ? content.split('\n').length : 0;
      window.mcpAPI!.reply(payload._replyChannel, { filePath, content, lineCount });
    }),
  );

  // 提交审查批注
  unsubs.push(
    window.mcpAPI.onSubmitReview((payload: any) => {
      const state = useScriptStore.getState();
      const annotationsInput: Array<{
        quotedText?: string;
        line?: number;
        endLine?: number;
        text: string;
        suggestion?: string;
        severity?: string;
      }> = payload.annotations ?? [];
      const scriptContent = state.scriptText;
      const scriptLines = scriptContent.split('\n');

      // 预计算行偏移表（仅在需要行号定位时使用）
      const lineOffsets: number[] = [0];
      for (let i = 0; i < scriptLines.length; i++) {
        lineOffsets.push(lineOffsets[i] + scriptLines[i].length + 1);
      }

      const newAnnotations: typeof state.annotations = [];
      let skipped = 0;

      for (let idx = 0; idx < annotationsInput.length; idx++) {
        const a = annotationsInput[idx];
        let startOffset: number;
        let endOffset: number;
        let originalText: string;

        if (a.quotedText) {
          // 优先使用 quotedText 精确匹配
          const matchIdx = scriptContent.indexOf(a.quotedText);
          if (matchIdx === -1) {
            skipped++;
            continue;
          }
          startOffset = matchIdx;
          endOffset = matchIdx + a.quotedText.length;
          originalText = a.quotedText;
        } else if (a.line != null) {
          // 降级到行号定位
          const startLine = Math.max(1, Math.min(a.line, scriptLines.length));
          const endLine = Math.max(startLine, Math.min(a.endLine ?? startLine, scriptLines.length));
          startOffset = lineOffsets[startLine - 1];
          endOffset = lineOffsets[endLine] - 1;
          originalText = scriptLines.slice(startLine - 1, endLine).join('\n');
        } else {
          skipped++;
          continue;
        }

        newAnnotations.push({
          id: `mcp-review-${Date.now()}-${idx}`,
          startOffset,
          endOffset,
          originalText,
          quotedText: originalText,
          docVersion: state.scriptDocVersion,
          issue: a.text,
          suggestion: a.suggestion ?? '',
          severity: (['error', 'warning', 'info'].includes(a.severity ?? '') ? a.severity as 'error' | 'warning' | 'info' : 'info'),
          status: 'pending' as const,
        });
      }

      state.setAnnotations(newAnnotations);
      state.setReviewState(newAnnotations.length > 0 ? 'issues' : 'clean');

      window.mcpAPI!.reply(payload._replyChannel, {
        success: true,
        filePath: 'script.md',
        annotationCount: newAnnotations.length,
        skipped,
      });
    }),
  );

  // 列出项目文件
  unsubs.push(
    window.mcpAPI.onListProjectFiles((payload: any) => {
      const state = useScriptStore.getState();
      window.mcpAPI!.reply(payload._replyChannel, {
        projectDir: state.projectDir,
        files: state.fileEntries.map((f) => ({
          path: f.name,
          name: f.name,
          isDirectory: f.type === 'directory',
        })),
      });
    }),
  );

  // 获取项目上下文
  unsubs.push(
    window.mcpAPI.onGetProjectContext((payload: any) => {
      const state = useScriptStore.getState();
      // 直接从 AIStore 读口播模板条目，避免耦合 script-templates.ts
      const userTemplates = useAIStore.getState().userPromptEntries['script-template'] ?? [];
      // 极早期（App hydrate 尚未完成 loadUserPrompts）时用内置种子兜底
      const effectiveTemplates = userTemplates.length > 0
        ? userTemplates.map((entry) => ({
            id: entry.id,
            name: entry.name,
            description: entry.description,
            systemPrompt: entry.system,
          }))
        : SCRIPT_TEMPLATE_SEEDS.map((seed) => ({
            id: seed.id,
            name: seed.name,
            description: seed.description,
            systemPrompt: seed.system,
          }));
      const selectedTpl = effectiveTemplates.find((t) => t.id === state.selectedTemplate);
      const selectedRole = getRoleById(state.selectedRole);
      window.mcpAPI!.reply(payload._replyChannel, {
        projectName: state.projectDir?.split('/').pop() ?? null,
        projectDir: state.projectDir,
        selectedTemplate: state.selectedTemplate,
        selectedTemplatePrompt: selectedTpl?.systemPrompt ?? null,
        selectedRole: selectedRole ? {
          id: selectedRole.id,
          name: selectedRole.name,
          description: selectedRole.description,
          rolePrompt: selectedRole.rolePrompt,
        } : null,
        roleInstruction: selectedRole && selectedRole.id !== 'none'
          ? `【重要】用户已选择「${selectedRole.name}」作为口播角色。写稿时请严格遵循以下角色设定：\n${selectedRole.rolePrompt}\n请将此角色风格融入模板要求中生成口播稿。`
          : null,
        templates: effectiveTemplates,
        hasOriginalFile: state.workspaceFiles.hasOriginalFile,
        hasScriptFile: state.workspaceFiles.hasScriptFile,
      });
    }),
  );

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
  };
}
