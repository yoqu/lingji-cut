import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  Textarea,
  useToast,
} from '../ui';
import type { SubtitleCardDraftInput } from '../lib/ai-analysis';
import { generateAndInsertSingleCardFromSubtitles } from '../lib/single-card-generation';
import { createManualMediaCard } from '../lib/manual-media-card';
import {
  MANUAL_CARD_CARRIER_OPTIONS,
  MANUAL_CARD_KIND_OPTIONS,
  type ManualCardKind,
} from '../lib/manual-card-types';
import type { StoryboardCarrier } from '../lib/motion-storyboard';

type ManualCardCarrier = StoryboardCarrier | 'auto';

interface SubtitleCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: {
    text: string;
    startMs: number;
    endMs: number;
    kind?: ManualCardKind;
    carrier?: ManualCardCarrier;
    promptHint?: string;
    title?: string;
    insertToTimeline?: boolean;
    allowedKinds?: ManualCardKind[];
    requireText?: boolean;
  } | null;
  /** 生成成功后的回调（弹窗已自动关闭） */
  onGenerated?: (cardId?: string) => void;
}

interface ValidationState {
  textError?: string;
  timeError?: string;
  durationError?: string;
  hintError?: string;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '0';
  return String(Math.max(0, Math.round(ms)));
}

function parseMs(value: string): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
}

/**
 * 外层仅做 open/initial 托管；真正的表单 + 副作用由 Body 组件承担，
 * 避免 open=false 时也触发 useToast() 等依赖 Provider 的 hook。
 */
export function SubtitleCardDialog({
  open,
  onOpenChange,
  initial,
  onGenerated,
}: SubtitleCardDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && initial ? (
        <SubtitleCardDialogBody
          initial={initial}
          onOpenChange={onOpenChange}
          onGenerated={onGenerated}
        />
      ) : null}
    </Dialog>
  );
}

function SubtitleCardDialogBody({
  initial,
  onOpenChange,
  onGenerated,
}: {
  initial: {
    text: string;
    startMs: number;
    endMs: number;
    kind?: ManualCardKind;
    carrier?: ManualCardCarrier;
    promptHint?: string;
    title?: string;
    insertToTimeline?: boolean;
    allowedKinds?: ManualCardKind[];
    requireText?: boolean;
  };
  onOpenChange: (open: boolean) => void;
  onGenerated?: (cardId?: string) => void;
}) {
  const { showToast } = useToast();
  const [text, setText] = useState(initial.text);
  const [startMsInput, setStartMsInput] = useState(formatMs(initial.startMs));
  const [endMsInput, setEndMsInput] = useState(formatMs(initial.endMs));
  const [durationInput, setDurationInput] = useState(
    formatMs(Math.max(1000, initial.endMs - initial.startMs)),
  );
  const [cardKind, setCardKind] = useState<ManualCardKind>(initial.kind ?? 'motion');
  const [carrier, setCarrier] = useState<ManualCardCarrier>(initial.carrier ?? 'auto');
  const [promptHint, setPromptHint] = useState(initial.promptHint ?? '');
  const [submitting, setSubmitting] = useState(false);
  const allowedKindSet = useMemo(
    () => new Set(initial.allowedKinds ?? MANUAL_CARD_KIND_OPTIONS.map((item) => item.kind)),
    [initial.allowedKinds],
  );
  const cardKindOptions = useMemo(
    () => MANUAL_CARD_KIND_OPTIONS.filter((item) => allowedKindSet.has(item.kind)),
    [allowedKindSet],
  );

  useEffect(() => {
    setText(initial.text);
    setStartMsInput(formatMs(initial.startMs));
    setEndMsInput(formatMs(initial.endMs));
    setDurationInput(formatMs(Math.max(1000, initial.endMs - initial.startMs)));
    setCardKind(initial.kind ?? cardKindOptions[0]?.kind ?? 'motion');
    setCarrier(initial.carrier ?? 'auto');
    setPromptHint(initial.promptHint ?? '');
  }, [
    cardKindOptions,
    initial.carrier,
    initial.endMs,
    initial.kind,
    initial.promptHint,
    initial.startMs,
    initial.text,
  ]);

  const startMs = useMemo(() => parseMs(startMsInput), [startMsInput]);
  const endMs = useMemo(() => parseMs(endMsInput), [endMsInput]);
  const durationMs = useMemo(() => parseMs(durationInput), [durationInput]);

  const validation: ValidationState = useMemo(() => {
    const v: ValidationState = {};
    if ((initial.requireText ?? true) && !text.trim()) {
      v.textError = '字幕内容不能为空';
    }
    if (!(startMs < endMs)) {
      v.timeError = '起始时间必须早于结束时间';
    }
    const maxDuration = Math.max(0, endMs - startMs) + 5000;
    if (durationMs < 1000) {
      v.durationError = '展示时长至少 1000ms';
    } else if (endMs > startMs && durationMs > maxDuration) {
      v.durationError = `展示时长不能超过 ${maxDuration}ms`;
    }
    if (promptHint.length > 200) {
      v.hintError = 'Prompt Hint 最多 200 字';
    }
    return v;
  }, [initial.requireText, text, startMs, endMs, durationMs, promptHint]);

  const canSubmit =
    !submitting &&
    !validation.textError &&
    !validation.timeError &&
    !validation.durationError &&
    !validation.hintError;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const draft: SubtitleCardDraftInput = {
      text: text.trim(),
      startMs,
      endMs,
      displayDurationMs: durationMs,
      type: 'motion',
      preferredCarrier: carrier === 'auto' ? undefined : carrier,
      promptHint: promptHint.trim() || undefined,
    };
    onOpenChange(false);
    try {
      const card =
        cardKind === 'image' || cardKind === 'video'
          ? await createManualMediaCard({
              mediaType: cardKind,
              segmentId: `manual:subtitle:${Date.now()}`,
              title: initial.title?.trim() || (cardKind === 'image' ? '手选图片卡' : '手选视频卡'),
              prompt: [promptHint.trim(), text.trim()].filter(Boolean).join('\n\n'),
              startMs,
              endMs,
              displayDurationMs: durationMs,
              displayMode: 'fullscreen',
              insertToTimeline: initial.insertToTimeline ?? true,
            })
          : await generateAndInsertSingleCardFromSubtitles({ draft });
      const toastLabel =
        cardKind === 'image' ? '图片卡已创建并插入时间轴' : cardKind === 'video' ? '视频卡已创建并插入时间轴' : 'Motion 卡已生成并插入时间轴';
      showToast(toastLabel, { type: 'success', duration: 3000 });
      onGenerated?.(card.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败';
      showToast(message, { title: '生成内容卡片失败', type: 'error', duration: 5000 });
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    text,
    startMs,
    endMs,
    durationMs,
    cardKind,
    carrier,
    initial.insertToTimeline,
    initial.title,
    promptHint,
    onOpenChange,
    onGenerated,
    showToast,
  ]);

  return (
    <DialogContent size="lg">
      <DialogHeader>
        <DialogTitle>创建内容卡片</DialogTitle>
        <p className="mt-1 text-sm text-mac-text-muted">
          基于选中字幕二次编辑后创建单张卡片；卡片类型决定形态，载体倾向决定表达方式。
        </p>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <div className="space-y-1">
          <label className="text-xs font-medium text-mac-text-muted">
            参考文本 / Prompt 种子
          </label>
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={5}
            resize="vertical"
            error={Boolean(validation.textError)}
            placeholder="可填写字幕、画面描述或生成提示词；后续也可在 Inspector 中继续编辑"
          />
          {validation.textError ? (
            <p className="text-xs text-mac-red">{validation.textError}</p>
          ) : null}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-mac-text-muted">
              起始时间（ms）
            </label>
            <input
              type="number"
              min={0}
              value={startMsInput}
              onChange={(event) => setStartMsInput(event.target.value)}
              className="flex h-9 w-full rounded-lg border border-mac-border bg-mac-elevated px-3 text-sm text-foreground outline-none focus:border-mac-blue focus:shadow-[0_0_0_3px_rgba(10,132,255,0.2)]"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-mac-text-muted">
              结束时间（ms）
            </label>
            <input
              type="number"
              min={0}
              value={endMsInput}
              onChange={(event) => setEndMsInput(event.target.value)}
              className="flex h-9 w-full rounded-lg border border-mac-border bg-mac-elevated px-3 text-sm text-foreground outline-none focus:border-mac-blue focus:shadow-[0_0_0_3px_rgba(10,132,255,0.2)]"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-mac-text-muted">
              展示时长（ms）
            </label>
            <input
              type="number"
              min={1000}
              value={durationInput}
              onChange={(event) => setDurationInput(event.target.value)}
              className="flex h-9 w-full rounded-lg border border-mac-border bg-mac-elevated px-3 text-sm text-foreground outline-none focus:border-mac-blue focus:shadow-[0_0_0_3px_rgba(10,132,255,0.2)]"
            />
          </div>
        </div>
        {validation.timeError ? (
          <p className="text-xs text-mac-red">{validation.timeError}</p>
        ) : null}
        {validation.durationError ? (
          <p className="text-xs text-mac-red">{validation.durationError}</p>
        ) : null}

        <div className="space-y-1">
          <label className="text-xs font-medium text-mac-text-muted">
            卡片类型
          </label>
          <Select
            value={cardKind}
            options={cardKindOptions.map((o) => ({ value: o.kind, label: o.label }))}
            onChange={(event) => setCardKind(event.target.value as ManualCardKind)}
          />
        </div>

        {cardKind === 'motion' ? (
          <div className="space-y-1">
            <label className="text-xs font-medium text-mac-text-muted">
              载体倾向
            </label>
            <Select
              value={carrier}
              options={MANUAL_CARD_CARRIER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(event) => setCarrier(event.target.value as ManualCardCarrier)}
            />
          </div>
        ) : null}

        <div className="space-y-1">
          <label className="text-xs font-medium text-mac-text-muted">
            Prompt Hint（可选，用于给 LLM 补充指令）
          </label>
          <input
            type="text"
            value={promptHint}
            onChange={(event) => setPromptHint(event.target.value)}
            maxLength={220}
            placeholder="例如：突出关键数字 / 做成引用样式 / 极简排版"
            className="flex h-9 w-full rounded-lg border border-mac-border bg-mac-elevated px-3 text-sm text-foreground outline-none focus:border-mac-blue focus:shadow-[0_0_0_3px_rgba(10,132,255,0.2)]"
          />
          {validation.hintError ? (
            <p className="text-xs text-mac-red">{validation.hintError}</p>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          取消
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
          创建卡片
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
