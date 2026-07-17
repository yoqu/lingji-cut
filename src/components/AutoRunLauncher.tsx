import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppIcon } from './AppIcon';
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Select,
} from '../ui';
import { AutoModeSection, type AutoModeModelBinding } from './script/AutoModeSection';
import {
  getResumableStepLabel,
  listStartableSteps,
  type ResumableAutoRunInfo,
  type ResumableAutoRunStep,
} from '../lib/auto-run-resume';
import type { AutoWorkflowParams } from '../store/ai';
import { loadAISettings, useAIStore } from '../store/ai';
import { useScriptStore } from '../store/script';
import { getAllRoles } from '../lib/script-templates';
import { normalizeTTSSettings } from '../lib/tts-settings';
import { userPromptBindingKey } from '../lib/prompts';
import type { AISettings } from '../types/ai';
import type { AppPage } from '../lib/electron-api';
import {
  detectLauncherAutoRun,
  dismissLauncherForSession,
  launcherSessionDismissed,
} from '../lib/auto-run-launcher-detect';
import {
  flattenModelOptions,
  resolveInitialModelBinding,
  ResumeProductionModePicker,
} from './auto-run-launcher-helpers';
import styles from './AutoRunLauncher.module.css';

export interface AutoRunLauncherProps {
  projectDir: string;
  setPage: (next: AppPage) => void;
  /** 测试注入 */
  detect?: typeof detectLauncherAutoRun;
}

export function AutoRunLauncher({
  projectDir,
  setPage,
  detect = detectLauncherAutoRun,
}: AutoRunLauncherProps) {
  const workflowStep = useAIStore((s) => s.workflow.step);
  const setPendingAutoParams = useAIStore((s) => s.setPendingAutoParams);
  const setPendingAutoResumeStep = useAIStore((s) => s.setPendingAutoResumeStep);
  const projectBindings = useAIStore((s) => s.projectBindings);
  const setProjectBinding = useAIStore((s) => s.setProjectBinding);
  const selectedTemplate = useScriptStore((s) => s.selectedTemplate);
  const selectedRole = useScriptStore((s) => s.selectedRole);

  const [resumable, setResumable] = useState<ResumableAutoRunInfo | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => launcherSessionDismissed(projectDir));
  const [configOpen, setConfigOpen] = useState(false);
  const [voiceIdDefault, setVoiceIdDefault] = useState('male-qn-qingse');
  const [aiSettings, setAiSettings] = useState<AISettings | null>(null);
  const [configParams, setConfigParams] = useState<AutoWorkflowParams | null>(null);
  const [modelBinding, setModelBinding] = useState<AutoModeModelBinding | null>(null);
  const [resumeProductionMode, setResumeProductionMode] = useState<'auto' | 'director'>('auto');
  const [startStep, setStartStep] = useState<ResumableAutoRunStep | null>(null);

  useEffect(() => {
    setDismissed(launcherSessionDismissed(projectDir));
  }, [projectDir]);

  useEffect(() => {
    void (async () => {
      const settings = await loadAISettings().catch(() => null);
      if (!settings) return;
      const normalized = normalizeTTSSettings(settings);
      setAiSettings(normalized);
      const defaultVoice = normalized.ttsVoices.find(
        (voice) => voice.id === normalized.defaultTtsVoiceId,
      );
      if (defaultVoice) {
        setVoiceIdDefault(
          defaultVoice.providerType === 'minimax' && defaultVoice.voiceId
            ? defaultVoice.voiceId
            : defaultVoice.id,
        );
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!projectDir) {
      setResumable(null);
      return () => {
        cancelled = true;
      };
    }
    if (workflowStep !== 'idle' && workflowStep !== 'error') {
      return () => {
        cancelled = true;
      };
    }

    void detect(projectDir).then((result) => {
      if (cancelled) return;
      if (result.kind === 'resumable') {
        setResumable(result);
        setResumeProductionMode(result.persistedAutoParams?.productionMode ?? 'auto');
      } else {
        setResumable(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [detect, projectDir, workflowStep]);

  const autoModeOptions = useMemo(
    () => ({
      roles: getAllRoles().map((r) => ({ value: r.id, label: r.name })),
      voices: (aiSettings?.ttsVoices ?? []).map((voice) => ({
        value: voice.providerType === 'minimax' && voice.voiceId ? voice.voiceId : voice.id,
        label: `${voice.name}${voice.source === 'cloned' ? '（克隆）' : ''}`,
      })),
      models: flattenModelOptions(aiSettings),
    }),
    [aiSettings],
  );

  const launch = useCallback(
    (params: AutoWorkflowParams, step: ResumableAutoRunStep) => {
      setPendingAutoParams(params);
      setPendingAutoResumeStep(step);
      setPage('auto-run');
    },
    [setPage, setPendingAutoParams, setPendingAutoResumeStep],
  );

  /** 点击启动前实时重检磁盘产物，避免使用挂载时的过期检测结果（如手动写完稿后仍从写稿起跑）。 */
  const refreshDetection = useCallback(async (): Promise<ResumableAutoRunInfo | null> => {
    const result = await detect(projectDir).catch(() => null);
    if (!result || result.kind !== 'resumable') {
      setResumable(null);
      return null;
    }
    setResumable(result);
    return result;
  }, [detect, projectDir]);

  const handleResume = useCallback(async () => {
    const fresh = await refreshDetection();
    if (!fresh?.persistedAutoParams) return;
    launch(
      { ...fresh.persistedAutoParams, productionMode: resumeProductionMode },
      fresh.nextStep,
    );
  }, [launch, refreshDetection, resumeProductionMode]);

  const handleOpenConfig = useCallback(async () => {
    const fresh = await refreshDetection();
    if (!fresh) return;
    const persisted = fresh.persistedAutoParams;
    const templateId = persisted?.templateId || selectedTemplate || 'news-broadcast';
    setConfigParams({
      templateId,
      roleId: persisted?.roleId || selectedRole || 'none',
      voiceId: persisted?.voiceId || voiceIdDefault,
      productionMode: resumeProductionMode,
    });
    const projectBinding = projectBindings?.[userPromptBindingKey('script-template', templateId)] ?? null;
    setModelBinding(resolveInitialModelBinding(aiSettings, projectBinding));
    setStartStep(fresh.nextStep);
    setConfigOpen(true);
  }, [aiSettings, projectBindings, refreshDetection, resumeProductionMode, selectedRole, selectedTemplate, voiceIdDefault]);

  const handleOpenOverview = useCallback(() => {
    setPage('director-workbench');
  }, [setPage]);

  const handleOpenCheckpoint = useCallback(() => {
    setPage(resumable?.checkpoint === 'animatic-review' ? 'editor' : 'director-workbench');
  }, [resumable?.checkpoint, setPage]);

  const handleConfirmConfig = useCallback(async () => {
    if (!configParams || !startStep) return;
    // 把写稿模型选择写入项目级绑定（下次一键 / 脚本工作台手动写稿都会用它）
    if (modelBinding) {
      await setProjectBinding(userPromptBindingKey('script-template', configParams.templateId), {
        providerId: modelBinding.providerId,
        model: modelBinding.model,
        imageProviderId: null,
        imageModel: null,
      });
    }
    setConfigOpen(false);
    launch(configParams, startStep);
  }, [configParams, launch, modelBinding, setProjectBinding, startStep]);

  const handleDismiss = useCallback(() => {
    dismissLauncherForSession(projectDir);
    setDismissed(true);
  }, [projectDir]);

  if (dismissed || !resumable) return null;

  const isRestart = resumable.restart === true;
  const hasCheckpoint = Boolean(resumable.checkpoint);
  const canResume = resumable.persistedAutoParams !== null && !isRestart && !hasCheckpoint;
  const startableSteps = listStartableSteps(resumable.nextStep, { restart: isRestart });
  const titleText = resumable.checkpoint === 'director-review'
    ? '导演方案等待批准'
    : resumable.checkpoint === 'animatic-review'
      ? 'Animatic 等待确认'
      : isRestart
    ? '重新制作当前项目'
    : canResume
      ? '检测到未完成的自动剪辑'
      : '自动剪辑';
  const stageText = resumable.checkpoint === 'director-review'
    ? '批准前不会生成画面、封面或声音'
    : resumable.checkpoint === 'animatic-review'
      ? '进入编辑器审查镜头与时间线'
      : isRestart
    ? '可选择一键成片或导演确认'
    : canResume
      ? `从「${getResumableStepLabel(resumable.nextStep)}」继续`
      : `将从「${getResumableStepLabel(resumable.nextStep)}」开始`;

  const modelHint =
    autoModeOptions.models.length === 0
      ? '未发现可用模型，请先到系统设置添加生成服务。'
      : '作为本项目当前模板的默认写稿模型，下次也会用它。';

  return (
    <>
      <div className={styles.banner} role="status" data-testid="auto-run-launcher">
        <div className={styles.iconWrap}>
          <AppIcon name="sparkles" size={14} />
        </div>
        <div className={styles.message}>
          <span className={styles.title}>{titleText}</span>
          <span className={styles.stageTag}>{stageText}</span>
        </div>
        <div className={styles.actions}>
          {canResume ? (
            <ResumeProductionModePicker
              value={resumeProductionMode}
              onChange={setResumeProductionMode}
            />
          ) : null}
          {resumable.hasProductionPlan && !hasCheckpoint ? (
            <Button variant="secondary" size="sm" onClick={handleOpenOverview}>
              制作总览
            </Button>
          ) : null}
          {hasCheckpoint ? (
            <Button variant="primary" size="sm" onClick={handleOpenCheckpoint}>
              {resumable.checkpoint === 'animatic-review' ? '进入编辑器审查' : '进入导演台批准'}
            </Button>
          ) : canResume ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => void handleOpenConfig()}>
                调整
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void handleResume()}
                leftIcon={<AppIcon name="refresh-cw" size={12} />}
              >
                继续运行
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleOpenConfig()}
              leftIcon={<AppIcon name="sparkles" size={12} />}
            >
              {isRestart ? '配置重新制作' : '配置并开始'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            onClick={handleDismiss}
            aria-label="忽略"
          >
            <AppIcon name="x" size={14} />
          </Button>
        </div>
      </div>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent size="md">
          <DialogClose />
          <DialogHeader>
            <DialogTitle>配置自动剪辑</DialogTitle>
            <DialogDescription>
              选择写稿模型、角色与口播音色，确认后将从所选起始阶段起自动完成：
              生成口播稿 → 合成口播 → 生成画面 → 生成封面 → 排布时间线。
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {startableSteps.length > 1 ? (
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <Field
                  label="起始阶段"
                  hint="按磁盘产物检测的默认起点；选择更早阶段会重新生成对应内容。"
                >
                  <Select
                    aria-label="起始阶段"
                    value={startStep ?? ''}
                    options={startableSteps.map((step) => ({
                      value: step,
                      label: getResumableStepLabel(step),
                    }))}
                    onChange={(e) => setStartStep(e.target.value as ResumableAutoRunStep)}
                  />
                </Field>
              </div>
            ) : null}
            {configParams ? (
              <AutoModeSection
                mode="always"
                params={configParams}
                onChangeParams={setConfigParams}
                roleOptions={autoModeOptions.roles}
                voiceOptions={autoModeOptions.voices}
                modelOptions={autoModeOptions.models}
                modelBinding={modelBinding}
                onChangeModelBinding={setModelBinding}
                modelHint={modelHint}
              />
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfigOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleConfirmConfig()}
              disabled={!configParams?.voiceId || !modelBinding || !startStep}
            >
              开始
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
