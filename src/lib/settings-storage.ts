import {
  DEFAULT_SELECTED_ROLE,
  normalizeGlobalSettingsFile,
  type CustomRole,
} from '../types/global-settings';
import {
  getInitialGlobalSettings,
  loadGlobalSettingsFile,
  updateGlobalSettingsFile,
} from './global-settings-client';

export type { CustomRole, CustomScriptTemplate } from '../types/global-settings';

interface SettingsCache {
  customRoles: CustomRole[];
  selectedRole: string;
}

function buildCacheFromSettings(): SettingsCache {
  const normalized = normalizeGlobalSettingsFile(getInitialGlobalSettings());
  return {
    customRoles: normalized.customRoles ?? [],
    selectedRole: normalized.selectedRole ?? DEFAULT_SELECTED_ROLE,
  };
}

let cache: SettingsCache | null = null;
let hydrationPromise: Promise<void> | null = null;

function ensureCache(): SettingsCache {
  if (!cache) {
    cache = buildCacheFromSettings();
  }
  return cache;
}

export async function hydrateSettingsStorage(): Promise<void> {
  if (hydrationPromise) {
    return hydrationPromise;
  }

  hydrationPromise = (async () => {
    const globalSettings = normalizeGlobalSettingsFile(await loadGlobalSettingsFile());
    const currentCache = ensureCache();

    cache = {
      customRoles:
        globalSettings.customRoles && globalSettings.customRoles.length > 0
          ? globalSettings.customRoles
          : currentCache.customRoles,
      selectedRole:
        globalSettings.selectedRole && globalSettings.selectedRole !== DEFAULT_SELECTED_ROLE
          ? globalSettings.selectedRole
          : currentCache.selectedRole,
    };
  })().finally(() => {
    hydrationPromise = null;
  });

  return hydrationPromise;
}

export interface ScriptRole {
  id: string;
  name: string;
  description: string;
  rolePrompt: string;
  isBuiltin: boolean;
}

export const NONE_ROLE: ScriptRole = {
  id: 'none',
  name: '不指定角色',
  description: '不附加角色设定，完全由模板决定风格',
  rolePrompt: '',
  isBuiltin: true,
};

export function loadCustomRoles(): CustomRole[] {
  return ensureCache().customRoles;
}

export function loadSelectedRole(): string {
  return ensureCache().selectedRole;
}

export function saveSelectedRole(roleId: string): void {
  cache = { ...ensureCache(), selectedRole: roleId };
  void updateGlobalSettingsFile((current) => ({ ...current, selectedRole: roleId }));
}
