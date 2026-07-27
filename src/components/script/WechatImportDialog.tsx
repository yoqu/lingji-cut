import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Link2, Loader2 } from 'lucide-react';
import {
  Alert,
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
  Textarea,
  Input,
} from '../../ui';
import type { ImportWechatArticleSource } from './ImportScriptDialog';
import styles from './ImportScriptDialog.module.css';

interface WechatImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 确认导入：传出编辑后的 Markdown 与公众号来源信息，由调用方落地图片并写 original.md */
  onConfirm: (markdown: string, source: ImportWechatArticleSource) => Promise<void>;
}

/** 脚本工作台内的公众号文章导入：抓取 → 预览编辑 → 导入为 original.md */
export function WechatImportDialog({ open, onOpenChange, onConfirm }: WechatImportDialogProps) {
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [source, setSource] = useState<ImportWechatArticleSource | null>(null);
  const [fetchedLabel, setFetchedLabel] = useState<string | null>(null);
  const prevOpenRef = useRef(false);

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setUrl('');
      setFetching(false);
      setImporting(false);
      setError(null);
      setMarkdown('');
      setSource(null);
      setFetchedLabel(null);
    }
    prevOpenRef.current = open;
  }, [open]);

  const handleFetch = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setFetching(true);
    setError(null);
    try {
      const result = await window.electronAPI.fetchWechatArticle(trimmed);
      setMarkdown(result.markdown);
      setSource({ articleId: result.articleId, meta: result.meta });
      setFetchedLabel(
        `${result.meta.title}${result.imageCount ? `（${result.imageCount} 张配图）` : ''}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '公众号文章抓取失败');
    } finally {
      setFetching(false);
    }
  }, [url]);

  const handleConfirm = useCallback(async () => {
    if (!source || !markdown.trim()) return;
    setImporting(true);
    setError(null);
    try {
      await onConfirm(markdown, source);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '公众号文章导入失败');
    } finally {
      setImporting(false);
    }
  }, [source, markdown, onConfirm, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogClose />
        <DialogHeader>
          <DialogTitle>导入公众号文章</DialogTitle>
          <DialogDescription>
            抓取 mp.weixin.qq.com 文章转为 Markdown 写入 original.md，正文图片会下载到项目内
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="公众号文章链接">
            <div className={styles.wechatRow}>
              <Input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mp.weixin.qq.com/s/..."
                leftIcon={<Link2 size={16} strokeWidth={1.5} />}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleFetch();
                }}
              />
              <Button
                variant="primary"
                onClick={() => void handleFetch()}
                disabled={!url.trim() || fetching || importing}
              >
                {fetching ? (
                  <>
                    <Loader2 size={14} className={styles.spinIcon} />
                    抓取中
                  </>
                ) : (
                  '抓取'
                )}
              </Button>
            </div>
            {fetchedLabel && (
              <div className={styles.sourceActions}>
                <span className={styles.sourceTag}>
                  <CheckCircle2 size={13} strokeWidth={2} className={styles.sourceTagIcon} />
                  <span className={styles.sourceTagName}>{fetchedLabel}</span>
                </span>
              </div>
            )}
          </Field>

          {source && (
            <div style={{ marginTop: 'var(--space-6)' }}>
              <Field label="文稿内容（可编辑）">
                <Textarea
                  value={markdown}
                  onChange={(e) => setMarkdown(e.target.value)}
                  rows={10}
                  resize="vertical"
                />
              </Field>
            </div>
          )}

          {error && (
            <div style={{ marginTop: 'var(--space-6)' }}>
              <Alert variant="error">{error}</Alert>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={importing}>取消</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={!source || !markdown.trim() || fetching || importing}
            onClick={() => void handleConfirm()}
          >
            {importing ? '导入中…' : '导入为原稿'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
