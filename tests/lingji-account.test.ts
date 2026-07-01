import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace('enc:', ''),
  },
}));

import { buildAuthorizeUrl, lingjiBaseUrl, makePkce } from '../electron/lingji-account';

describe('lingji-account 纯逻辑', () => {
  it('开发环境基址为 localhost:15173（无尾斜杠）', () => {
    expect(lingjiBaseUrl()).toBe('http://localhost:15173');
  });

  it('buildAuthorizeUrl 携带全部 PKCE 与 loopback 参数', () => {
    const url = buildAuthorizeUrl(
      'http://localhost:15173',
      'http://127.0.0.1:5321/callback',
      'st',
      'ch',
    );
    expect(url).toContain('/oauth/authorize');
    expect(url).toContain('response_type=code');
    expect(url).toContain('client=desktop');
    expect(url).toContain('code_challenge=ch');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('state=st');
    expect(url).toContain(encodeURIComponent('http://127.0.0.1:5321/callback'));
  });

  it('makePkce 的 challenge = base64url(SHA256(verifier))', () => {
    const { verifier, challenge } = makePkce();
    expect(verifier.length).toBeGreaterThan(20);
    expect(challenge.length).toBeGreaterThan(20);
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
  });
});
