import { useState } from 'react';
import type { LLMProvider } from '../../types/ai';
import { connectLingjiGateway } from '../../lib/llm/lingji-gateway';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from '../../ui';

const DEFAULT_GATEWAY = 'http://localhost:18080';

/**
 * 一键登录灵机剪影账户：登录后自动生成网关密钥并配置好 Provider，开箱即用调 AI。
 * 自包含组件，不侵入既有 Provider 编辑流程；成功后通过 onConnected 回填一个 Provider。
 */
export function LingjiGatewayConnect({
  onConnected,
}: {
  onConnected: (provider: LLMProvider) => void;
}) {
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_GATEWAY);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (loading) return;
    setOpen(false);
    setError(null);
    setPassword('');
  };

  const submit = async () => {
    setLoading(true);
    setError(null);
    try {
      const provider = await connectLingjiGateway({ baseUrl, email, password });
      onConnected(provider);
      setOpen(false);
      setPassword('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        一键登录灵机剪影
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => (!o ? close() : undefined)}>
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>登录灵机剪影账户（开箱即用）</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <Field label="网关地址" hint="你的灵机剪影服务地址，例如 http://localhost:8080">
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} size="sm" />
              </Field>
              <Field label="邮箱" required>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  size="sm"
                />
              </Field>
              <Field label="密码" required error={error ?? undefined}>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  size="sm"
                />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close} disabled={loading}>
                取消
              </Button>
              <Button
                type="button"
                onClick={submit}
                disabled={loading || !email.trim() || !password || !baseUrl.trim()}
              >
                {loading ? '连接中…' : '登录并配置'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
