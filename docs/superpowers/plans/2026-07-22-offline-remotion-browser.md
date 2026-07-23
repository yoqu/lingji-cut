# Offline Remotion Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Remotion-compatible Chrome Headless Shell inside every supported desktop installer and use it without a runtime download.

**Architecture:** A focused packaging helper prepares the target-platform browser and stages it under `vendor/remotion-browser`. A focused Electron runtime helper resolves the packaged executable, and `render.ts` passes it to both composition selection and media rendering.

**Tech Stack:** Node.js packaging scripts, Electron, Remotion 4, TypeScript, Vitest.

---

### Task 1: Define browser artifact mapping and runtime resolution

**Files:**
- Create: `electron/remotion/browser-runtime.ts`
- Create: `tests/remotion-browser-runtime.test.ts`

- [ ] Write failing tests for packaged Windows x64 and macOS x64/arm64 executable paths, development fallback, and missing packaged executable errors.
- [ ] Run `npx vitest run tests/remotion-browser-runtime.test.ts` and confirm failure because the module does not exist.
- [ ] Implement the smallest platform mapping and path resolver that satisfies the tests.
- [ ] Re-run the test and confirm it passes.

### Task 2: Stage the browser during packaging

**Files:**
- Create: `scripts/remotion-browser-runtime.cjs`
- Modify: `scripts/package-windows.cjs`
- Modify: `scripts/package-mac.cjs`
- Modify: `scripts/package-mac-helpers.cjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/remotion-browser-packaging.test.ts`

- [ ] Write failing tests for supported target mapping, cache reuse, stage destination, and `vendor/remotion-browser` inclusion in `asar.unpackDir`.
- [ ] Run `npx vitest run tests/remotion-browser-packaging.test.ts tests/package-windows-stage.test.ts tests/package-mac-stage.test.ts` and confirm the new assertions fail.
- [ ] Implement a build-time browser preparation helper using Remotion's pinned browser download, then copy the verified artifact into each package stage.
- [ ] Re-run the packaging tests and confirm they pass.

### Task 3: Force Remotion to use the packaged executable

**Files:**
- Modify: `electron/remotion/render.ts`
- Modify: `electron/remotion/render-video-headless.ts`
- Modify: `tests/render-video-headless.test.ts`

- [ ] Add failing source-contract tests that require the resolved `browserExecutable` to reach both `selectComposition` and `renderMedia`.
- [ ] Run `npx vitest run tests/render-video-headless.test.ts tests/remotion-browser-runtime.test.ts` and confirm the new assertions fail.
- [ ] Pass the packaged browser path through `RemotionRenderParams` to both Remotion calls and remove the packaged runtime's dependence on browser-download cwd setup.
- [ ] Re-run the tests and confirm they pass.

### Task 4: Verify build and staged Windows package

**Files:**
- No additional source files.

- [ ] Run all targeted Remotion and packaging tests.
- [ ] Run `npm run build` and confirm exit code 0.
- [ ] Run the Windows package-stage preparation path and verify the staged browser executable exists under `vendor/remotion-browser`.
- [ ] Review `git diff --check` and `git status --short`, preserving unrelated user files.
