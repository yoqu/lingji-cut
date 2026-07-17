import { useCallback, useEffect, useRef, useState } from 'react';

const SKIP_KEY = 'lingji.videoCardConfirm.skip';

export interface VideoGenConfirmController {
  open: boolean;
  rememberChoice: boolean;
  setRememberChoice: (remember: boolean) => void;
  requestConfirmation: () => Promise<boolean>;
  confirm: () => void;
  cancel: () => void;
  onOpenChange: (open: boolean) => void;
}

function hasSkipPreference(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(SKIP_KEY) === '1';
  } catch {
    return false;
  }
}

export function useVideoGenConfirm(): VideoGenConfirmController {
  const [open, setOpen] = useState(false);
  const [rememberChoice, setRememberChoice] = useState(false);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    resolverRef.current?.(confirmed);
    resolverRef.current = null;
  }, []);

  const requestConfirmation = useCallback(() => {
    if (hasSkipPreference()) return Promise.resolve(true);
    settle(false);
    setRememberChoice(false);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, [settle]);

  const confirm = useCallback(() => {
    if (rememberChoice && typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(SKIP_KEY, '1');
      } catch {
        // 存储不可用不应阻止本次生成。
      }
    }
    settle(true);
  }, [rememberChoice, settle]);

  const cancel = useCallback(() => settle(false), [settle]);
  const onOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) settle(false);
  }, [settle]);

  useEffect(() => () => settle(false), [settle]);

  return {
    open,
    rememberChoice,
    setRememberChoice,
    requestConfirmation,
    confirm,
    cancel,
    onOpenChange,
  };
}
