import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('render-video extraction', () => {
  it('renderVideoHeadless module exists and exports the function', () => {
    const src = readFileSync(new URL('../electron/remotion/render-video-headless.ts', import.meta.url), 'utf8');
    expect(src).toContain('export async function renderVideoHeadless');
    expect(src).toContain('onProgress');
  });
  it('main.ts render-video handler delegates to renderVideoHeadless', () => {
    const src = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
    expect(src).toContain('renderVideoHeadless');
  });

  it('guards render progress sends after the main window has been destroyed', () => {
    const src = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');

    expect(src).toContain("from './safe-window-send'");
    expect(src).toContain("sendToLiveWindow(mainWindow, 'render-progress', f)");
  });

  it('passes the bundled browser executable through the Remotion render boundary', () => {
    const headless = readFileSync(
      new URL('../electron/remotion/render-video-headless.ts', import.meta.url),
      'utf8',
    );
    const render = readFileSync(new URL('../electron/remotion/render.ts', import.meta.url), 'utf8');

    expect(headless).toContain('resolveBundledRemotionBrowserExecutable');
    expect(headless).toContain('const browserExecutable = resolveBundledRemotionBrowserExecutable');
    expect(headless).toContain('browserExecutable,');
    expect(render.match(/browserExecutable: params\.browserExecutable/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('serves packaged Remotion assets from an explicit IPv4 loopback URL', () => {
    const headless = readFileSync(
      new URL('../electron/remotion/render-video-headless.ts', import.meta.url),
      'utf8',
    );

    expect(headless).toContain('startRemotionLocalServer');
    expect(headless).toContain('serveUrl = localServeServer.serveUrl');
    expect(headless).toContain('await localServeServer.close()');
  });

  it('probes and records local-server diagnostics around the Remotion boundary', () => {
    const headless = readFileSync(
      new URL('../electron/remotion/render-video-headless.ts', import.meta.url),
      'utf8',
    );
    const render = readFileSync(new URL('../electron/remotion/render.ts', import.meta.url), 'utf8');

    expect(headless).toContain('await localServeServer.probe()');
    expect(headless).toContain("tel.emit('render.server.probe'");
    expect(headless).toContain("tel.emit('render.server.summary'");
    expect(render).toContain("phase: 'select-composition.start'");
    expect(render).toContain("phase: 'select-composition.end'");
    expect(render).toContain("phase: 'render-media.start'");
    expect(render).toContain("phase: 'render-media.end'");
    expect(render).toContain("logLevel: 'verbose'");
  });

  it('revalidates frozen footage fingerprints at every quality gate', () => {
    const headless = readFileSync(
      new URL('../electron/remotion/render-video-headless.ts', import.meta.url),
      'utf8',
    );

    expect(headless).toContain('auditProductionFingerprints');
    expect(headless.match(/const fingerprintAudit = await auditProductionFingerprints/g)?.length ?? 0)
      .toBe(3);
    expect(headless).toContain('inputPath: temporaryOutputPath');
    expect(headless.indexOf('await atomicallyReplaceOutput'))
      .toBeGreaterThan(headless.lastIndexOf('const fingerprintAudit = await auditProductionFingerprints'));
    expect(headless).toContain('qualityExportSnapshotHash');
    expect(headless.lastIndexOf('await assertQualityExportSnapshotCurrent'))
      .toBeLessThan(headless.indexOf('await atomicallyReplaceOutput'));
    expect(headless).toContain('if (temporaryOutputPath) {');
    expect(headless.lastIndexOf('await fs.rm(temporaryOutputPath, { force: true })'))
      .toBeGreaterThan(headless.indexOf('} finally {'));
  });

  it('runs the production gate for every encoding preset', () => {
    const headless = readFileSync(
      new URL('../electron/remotion/render-video-headless.ts', import.meta.url),
      'utf8',
    );

    expect(headless).toContain('const report = evaluateProductionQuality');
    expect(headless).not.toContain("if (args.exportConfig.quality === 'quality' && qualityProjectDir) {");
  });
});
