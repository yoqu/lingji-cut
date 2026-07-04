import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { writePiConfig } from '../../electron/agent-runtime/pi-config-seed';
import type { AISettings } from '../../src/types/ai';

describe('writePiConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(os.tmpdir(), `pi-cfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes models.json, settings.json, and auth.json from AISettings', async () => {
    const ai = {
      llmProviders: [
        { id: 'a', name: 'A', type: 'openai_compatible', baseUrl: 'https://a/v1', apiKey: 'k', models: ['m1'] },
        {
          id: 'openai-app',
          name: 'OpenAI',
          type: 'openai_compatible',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-live',
          models: ['gpt-5.1'],
          pi: { builtinProviderId: 'openai' },
        },
      ],
      defaultProviderId: 'openai-app', defaultModel: 'gpt-5.1',
    } as unknown as AISettings;
    await writePiConfig(dir, ai);
    const models = JSON.parse(await fs.readFile(path.join(dir, 'models.json'), 'utf-8'));
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf-8'));
    const auth = JSON.parse(await fs.readFile(path.join(dir, 'auth.json'), 'utf-8'));
    expect(models.providers.a.api).toBe('openai-completions');
    expect(models.providers['openai-app']).toBeUndefined();
    expect(settings.defaultProvider).toBe('openai');
    expect(auth.openai).toEqual({ type: 'api_key', key: 'sk-live' });
    // defaultThinkingLevel 不再写死注入（思考程度走会话级 --thinking）
    expect(settings).not.toHaveProperty('defaultThinkingLevel');
  });

  it('creates the directory if missing and handles empty providers', async () => {
    const ai = { llmProviders: [], defaultProviderId: null, defaultModel: null } as unknown as AISettings;
    await writePiConfig(dir, ai);
    const models = JSON.parse(await fs.readFile(path.join(dir, 'models.json'), 'utf-8'));
    const auth = JSON.parse(await fs.readFile(path.join(dir, 'auth.json'), 'utf-8'));
    expect(models).toEqual({ providers: {} });
    expect(auth).toEqual({});
  });

  it('并发调用不撕裂配置文件（并行重试回归）', async () => {
    // 复刻批量并行重试：同一 pi 配置目录被 N 个 writePiConfig 同时命中。
    // 修复前 auth.json 的 read-modify-write + 非原子写会读到半截 JSON 抛
    // "Unexpected end of JSON input"；修复后串行化 + 原子写应全部成功。
    const ai = {
      llmProviders: [
        { id: 'a', name: 'A', type: 'openai_compatible', baseUrl: 'https://a/v1', apiKey: 'k', models: ['m1'] },
      ],
      defaultProviderId: 'a', defaultModel: 'm1',
    } as unknown as AISettings;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => writePiConfig(dir, ai)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    // 三个文件仍是完整可解析 JSON，且无残留 .tmp-* 临时文件。
    const models = JSON.parse(await fs.readFile(path.join(dir, 'models.json'), 'utf-8'));
    expect(models.providers.a.api).toBe('openai-completions');
    JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf-8'));
    JSON.parse(await fs.readFile(path.join(dir, 'auth.json'), 'utf-8'));
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('merges auth.json instead of replacing existing pi credentials', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'auth.json'),
      JSON.stringify({
        anthropic: { type: 'api_key', key: 'sk-ant-existing' },
        customOauth: { type: 'oauth', refreshToken: 'keep-me' },
      }),
      'utf-8',
    );

    const ai = {
      llmProviders: [
        {
          id: 'openai-app',
          name: 'OpenAI',
          type: 'openai_compatible',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-live',
          models: ['gpt-5.1'],
          pi: { builtinProviderId: 'openai' },
        },
      ],
      defaultProviderId: 'openai-app',
      defaultModel: 'gpt-5.1',
    } as unknown as AISettings;

    await writePiConfig(dir, ai);
    const auth = JSON.parse(await fs.readFile(path.join(dir, 'auth.json'), 'utf-8'));
    expect(auth).toEqual({
      anthropic: { type: 'api_key', key: 'sk-ant-existing' },
      customOauth: { type: 'oauth', refreshToken: 'keep-me' },
      openai: { type: 'api_key', key: 'sk-live' },
    });
  });
});
