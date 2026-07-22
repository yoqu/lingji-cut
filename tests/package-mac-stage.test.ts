import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  RENDER_RUNTIME_ASAR_UNPACK_DIRS,
  buildReleaseManifest,
  shouldStageProjectPath,
  shouldStageNodeModulePath,
} = require('../scripts/package-mac-helpers.cjs');

describe('package mac staging helpers', () => {
  it('builds a slim runtime manifest for the staged app', () => {
    const manifest = buildReleaseManifest({
      name: 'lingjijianying',
      productName: '灵机剪影',
      version: '1.0.0',
      main: 'dist-electron/main.js',
      scripts: {
        dev: 'electron-vite dev --watch',
        build: 'electron-vite build',
      },
      dependencies: {
        react: '^19.2.4',
        hyperframes: '^0.6.52',
      },
      devDependencies: {
        vitest: '^2.1.9',
      },
    });

    expect(manifest).toEqual({
      name: 'lingjijianying',
      productName: '灵机剪影',
      version: '1.0.0',
      main: 'dist-electron/main.js',
    });
  });

  it('stages only runtime project files from the repository root', () => {
    expect(shouldStageProjectPath('dist/index.html')).toBe(true);
    expect(shouldStageProjectPath('dist-cli/lingji.mjs')).toBe(true);
    expect(shouldStageProjectPath('dist-electron/main.js')).toBe(true);
    expect(shouldStageProjectPath('src/hyperframes/composition.ts')).toBe(true);

    expect(shouldStageProjectPath('vendor/ffmpeg/win32/x64/ffmpeg.exe')).toBe(false);
    expect(shouldStageProjectPath('.tmp/design-review/result.png')).toBe(false);
    expect(shouldStageProjectPath('docs/readme.md')).toBe(false);
    expect(shouldStageProjectPath('images/generated-1.png')).toBe(false);
    expect(shouldStageProjectPath('.env.example')).toBe(false);
    expect(shouldStageProjectPath('AGENT.md')).toBe(false);
    expect(shouldStageProjectPath('package-lock.json')).toBe(false);
  });

  it('drops caches and renderer-only packages from staged node_modules', () => {
    expect(shouldStageNodeModulePath('remotion/dist/index.js')).toBe(true);
    expect(shouldStageNodeModulePath('@remotion/renderer/dist/index.js')).toBe(true);
    expect(shouldStageNodeModulePath('@langchain/core/messages.js')).toBe(true);
    expect(shouldStageNodeModulePath('react/index.js')).toBe(true);
    // HyperFrames 已移除，不再 stage
    expect(shouldStageNodeModulePath('hyperframes/dist/cli.js')).toBe(false);
    expect(shouldStageNodeModulePath('@hyperframes/player/dist/index.js')).toBe(false);

    expect(shouldStageNodeModulePath('.cache/webpack/index.pack')).toBe(false);
    expect(shouldStageNodeModulePath('lucide-react/dist/lucide-react.js')).toBe(false);
    expect(shouldStageNodeModulePath('react-day-picker/dist/index.js')).toBe(false);
  });

  it('includes any package declared in root dependencies automatically', () => {
    // 新增 npm 依赖不再需要手动维护白名单——只要出现在 package.json 的 dependencies 中，
    // 除非明确列入 RENDERER_ONLY_PACKAGES 排除，否则都应被 stage。
    expect(shouldStageNodeModulePath('@langchain/google-genai/dist/index.js')).toBe(true);
    // pi 进程内 SDK：作为 npm 依赖应被 stage（其传递依赖由 closure 递归纳入）。
    expect(shouldStageNodeModulePath('@earendil-works/pi-coding-agent/dist/index.js')).toBe(true);
  });

  it('unpacks runtime artifacts (incl. in-process pi) from app.asar for packaged exports', () => {
    expect(RENDER_RUNTIME_ASAR_UNPACK_DIRS).toBe(
      '{dist-cli,dist-remotion,vendor/ffmpeg,node_modules/@earendil-works,node_modules/@mariozechner,node_modules/@remotion,node_modules/@rspack,node_modules/esbuild,node_modules/@esbuild,node_modules/@puppeteer,node_modules/puppeteer-core,node_modules/sharp,node_modules/onnxruntime-node,node_modules/ffmpeg-static,node_modules/@ffprobe-installer,node_modules/playwright,node_modules/playwright-core,node_modules/node-pty}',
    );
  });
});
