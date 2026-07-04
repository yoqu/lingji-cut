import { app, ipcMain } from 'electron';
import path from 'node:path';
import {
  readPromptUserText,
  writePromptUserText,
  deletePromptYaml,
  listPromptOverview,
  loadEffectivePromptTemplate,
} from './prompts-io';
import {
  readPromptBindings,
  writePromptBindings,
} from './prompt-bindings-io';
import {
  assertPromptCategory,
  deleteUserPromptEntry,
  getUserPromptSeed,
  listUserPromptEntries,
  readUserPromptEntry,
  writeUserPromptEntry,
} from './user-prompts-io';
import {
  PROMPT_CATEGORY_META,
  PROMPT_KIND_META,
  PROMPT_KINDS,
  getBuiltinPromptTemplate,
  isPromptKind,
  type PromptKind,
  type PromptScope,
} from '../src/lib/prompts';

function assertPromptKind(kind: unknown): PromptKind {
  if (!isPromptKind(kind)) {
    throw new Error(`未知的 prompt kind：${String(kind)}`);
  }
  return kind;
}

function assertPromptScope(scope: unknown): PromptScope {
  if (scope === 'global' || scope === 'project' || scope === 'builtin') return scope;
  throw new Error(`未知的 prompt scope：${String(scope)}`);
}

function assertWritableScope(scope: unknown): 'global' | 'project' {
  if (scope === 'global' || scope === 'project') return scope;
  throw new Error(`不可写的 prompt scope：${String(scope)}`);
}

export function registerPromptsIpc(): void {
  ipcMain.handle('prompts:list', async (_event, args: { projectDir?: string } = {}) => {
    const userDataPath = app.getPath('userData');
    const overview = await listPromptOverview({ userDataPath, projectDir: args.projectDir });
    return overview.map((item) => ({
      ...item,
      meta: PROMPT_KIND_META[item.kind],
    }));
  });

  ipcMain.handle('prompts:kinds', async () => {
    return PROMPT_KINDS.map((kind) => ({
      kind,
      meta: PROMPT_KIND_META[kind],
    }));
  });

  ipcMain.handle(
    'prompts:read',
    async (
      _event,
      args: { kind: string; scope: string; projectDir?: string },
    ) => {
      const kind = assertPromptKind(args.kind);
      const scope = assertPromptScope(args.scope);
      const userDataPath = app.getPath('userData');
      const content = await readPromptUserText(scope, kind, {
        userDataPath,
        projectDir: args.projectDir,
      });
      return { kind, scope, content };
    },
  );

  ipcMain.handle(
    'prompts:read-effective',
    async (_event, args: { kind: string; projectDir?: string }) => {
      const kind = assertPromptKind(args.kind);
      const userDataPath = app.getPath('userData');
      const effective = await loadEffectivePromptTemplate(kind, {
        userDataPath,
        projectDir: args.projectDir,
      });
      return { kind, ...effective };
    },
  );

  ipcMain.handle(
    'prompts:write',
    async (
      _event,
      args: { kind: string; scope: string; content: string; projectDir?: string },
    ) => {
      const kind = assertPromptKind(args.kind);
      const scope = assertWritableScope(args.scope);
      const userDataPath = app.getPath('userData');
      const filePath = await writePromptUserText(scope, kind, args.content, {
        userDataPath,
        projectDir: args.projectDir,
      });
      return { kind, scope, filePath };
    },
  );

  ipcMain.handle(
    'prompts:delete',
    async (
      _event,
      args: { kind: string; scope: string; projectDir?: string },
    ) => {
      const kind = assertPromptKind(args.kind);
      const scope = assertWritableScope(args.scope);
      const userDataPath = app.getPath('userData');
      const removed = await deletePromptYaml(scope, kind, {
        userDataPath,
        projectDir: args.projectDir,
      });
      return { kind, scope, removed };
    },
  );

  ipcMain.handle('prompts:default', async (_event, args: { kind: string }) => {
    const kind = assertPromptKind(args.kind);
    return { kind, content: getBuiltinPromptTemplate(kind).user };
  });

  ipcMain.handle(
    'prompts:readBindings',
    async (_event, args: { scope: 'project'; projectDir: string }) => {
      if (args.scope !== 'project') throw new Error('readBindings: 仅支持 project scope');
      if (!args.projectDir || !path.isAbsolute(args.projectDir)) {
        throw new Error('readBindings: 需要绝对路径 projectDir');
      }
      return readPromptBindings({ projectDir: args.projectDir });
    },
  );

  ipcMain.handle(
    'prompts:writeBindings',
    async (
      _event,
      args: { scope: 'project'; bindings: unknown; projectDir: string },
    ) => {
      if (args.scope !== 'project') throw new Error('writeBindings: 仅支持 project scope');
      if (!args.projectDir || !path.isAbsolute(args.projectDir)) {
        throw new Error('writeBindings: 需要绝对路径 projectDir');
      }
      if (!args.bindings || typeof args.bindings !== 'object') {
        throw new Error('writeBindings: bindings 必须是对象');
      }
      await writePromptBindings(
        args.bindings as Parameters<typeof writePromptBindings>[0],
        { projectDir: args.projectDir },
      );
    },
  );

  ipcMain.handle('user-prompts:categories', async () => {
    return Object.values(PROMPT_CATEGORY_META);
  });

  ipcMain.handle(
    'user-prompts:list',
    async (_event, args: { category: string }) => {
      const category = assertPromptCategory(args?.category);
      const userDataPath = app.getPath('userData');
      const entries = await listUserPromptEntries(category, { userDataPath });
      return entries;
    },
  );

  ipcMain.handle(
    'user-prompts:read',
    async (_event, args: { category: string; id: string }) => {
      const category = assertPromptCategory(args?.category);
      const userDataPath = app.getPath('userData');
      const entry = await readUserPromptEntry(category, args.id, { userDataPath });
      return entry;
    },
  );

  ipcMain.handle(
    'user-prompts:write',
    async (
      _event,
      args: {
        category: string;
        id: string;
        name: string;
        description: string;
        version?: number;
        system: string;
        user: string;
        ttsStyle?: string;
        ttsAnnotateHint?: string;
      },
    ) => {
      const category = assertPromptCategory(args?.category);
      const userDataPath = app.getPath('userData');
      if (!args.id || typeof args.id !== 'string') {
        throw new Error('user-prompts:write 缺少 id');
      }
      if (!args.name || typeof args.name !== 'string') {
        throw new Error('user-prompts:write 缺少 name');
      }
      if (typeof args.user !== 'string' || !args.user.trim()) {
        throw new Error('user-prompts:write 缺少 user');
      }
      const entry = await writeUserPromptEntry(
        {
          id: args.id,
          category,
          name: args.name,
          description: args.description ?? '',
          version: args.version,
          system: args.system ?? '',
          user: args.user,
          ttsStyle: args.ttsStyle,
          ttsAnnotateHint: args.ttsAnnotateHint,
        },
        { userDataPath },
      );
      return entry;
    },
  );

  ipcMain.handle(
    'user-prompts:delete',
    async (_event, args: { category: string; id: string }) => {
      const category = assertPromptCategory(args?.category);
      const userDataPath = app.getPath('userData');
      const result = await deleteUserPromptEntry(category, args.id, { userDataPath });
      return result;
    },
  );

  ipcMain.handle(
    'user-prompts:seed',
    async (_event, args: { category: string; id: string }) => {
      const category = assertPromptCategory(args?.category);
      const seed = getUserPromptSeed(category, args.id);
      return seed;
    },
  );
}
