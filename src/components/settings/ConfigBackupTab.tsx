// src/components/settings/ConfigBackupTab.tsx
import { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  SettingsPageHeader,
  useToast,
} from '../../ui';
import {
  applyImport,
  exportConfig,
  formatExportedAt,
  formatPlatform,
  previewConfig,
  type BackupPreviewData,
} from '../../lib/config-backup-client';
import styles from './ConfigBackupTab.module.css';

export function ConfigBackupTab() {
  const { showToast } = useToast();
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [preview, setPreview] = useState<BackupPreviewData | null>(null);

  const handleExport = async () => {
    if (busy) return;
    setBusy('export');
    try {
      const filePath = await exportConfig();
      if (filePath) {
        showToast(`已导出至 ${filePath}`, {
          title: '导出成功',
          type: 'success',
          duration: 4000,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message, { title: '导出失败', type: 'error', duration: 5000 });
    } finally {
      setBusy(null);
    }
  };

  const handleSelectImport = async () => {
    if (busy) return;
    setBusy('import');
    try {
      const data = await previewConfig();
      if (data) {
        setPreview(data);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message, {
        title: '备份文件无效',
        type: 'error',
        duration: 5000,
      });
    } finally {
      setBusy(null);
    }
  };

  const handleConfirmImport = async () => {
    if (!preview) return;
    try {
      const result = await applyImport(preview.filePath);
      showToast(
        `当前配置已备份至 ${result.settingsBackupPath}。请重启应用以使所有变更生效。`,
        {
          title: '导入成功',
          type: 'success',
          duration: 6000,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message, { title: '导入失败', type: 'error', duration: 5000 });
    } finally {
      setPreview(null);
    }
  };

  return (
    <div>
      <SettingsPageHeader
        title="配置备份"
        description="导出当前应用配置到文件，或从备份文件一键恢复。适用于换机、重装或多机同步。"
      />

      <div className={styles.container}>
        <Card>
          <CardHeader>
            <CardTitle>导出配置</CardTitle>
            <CardDescription>
              将文本生成服务、口播配置、口播模板、审查规范、自定义角色、Claude Code Agent 配置等完整打包为一个 JSON 文件。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Alert
              variant="warning"
              description="导出的文件包含所有 API Key 明文，请妥善保管（建议放入加密的云盘或密码管理器）。"
            />
          </CardContent>
          <CardFooter>
            <Button
              variant="primary"
              onClick={handleExport}
              disabled={busy !== null}
            >
              <Download size={16} />
              导出到文件…
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>从备份文件恢复</CardTitle>
            <CardDescription>
              选择一个 <code>.lingji-backup.json</code> 文件，将<strong>覆盖</strong>当前所有配置。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Alert variant="info">
              导入前会自动备份当前配置到应用数据目录的 <code>backups/</code> 文件夹，可随时手动还原。
            </Alert>
          </CardContent>
          <CardFooter>
            <Button
              variant="secondary"
              onClick={handleSelectImport}
              disabled={busy !== null}
            >
              <Upload size={16} />
              选择文件导入…
            </Button>
          </CardFooter>
        </Card>
      </div>

      <ConfirmDialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        title="确认导入配置"
        description={
          preview ? (
            <div>
              <p className={styles.previewIntro}>
                导入后将 <strong>覆盖当前所有配置</strong>，此操作不可撤销（但会自动备份当前值）。
              </p>
              <div className={styles.previewItem}>
                <span className={styles.previewLabel}>导出时间</span>
                <span className={styles.previewValue}>
                  {formatExportedAt(preview.exportedAt)}
                </span>
              </div>
              <div className={styles.previewItem}>
                <span className={styles.previewLabel}>应用版本</span>
                <span className={styles.previewValue}>{preview.appVersion}</span>
              </div>
              <div className={styles.previewItem}>
                <span className={styles.previewLabel}>源平台</span>
                <span className={styles.previewValue}>
                  {formatPlatform(preview.platform)}
                </span>
              </div>
            </div>
          ) : null
        }
        confirmText="确认导入"
        cancelText="取消"
        confirmVariant="destructive"
        onConfirm={handleConfirmImport}
      />
    </div>
  );
}
