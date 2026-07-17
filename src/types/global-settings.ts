import type { AISettings } from './ai';
import type { AssetLibrarySettings } from './assets';

export interface CustomScriptTemplate {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomRole {
  id: string;
  name: string;
  description: string;
  rolePrompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface GlobalSettingsMigrations {
  /** 把 customTemplates[] 迁移到 userData/prompts/script-template/*.yaml 后标记 'done' */
  scriptTemplateToUserPrompts?: 'done';
}

export interface GlobalSettingsFile {
  aiSettings?: AISettings;
  assetLibrary?: Partial<AssetLibrarySettings>;
  customTemplates?: CustomScriptTemplate[];
  customRoles?: CustomRole[];
  selectedRole?: string;
  migrations?: GlobalSettingsMigrations;
}

export const DEFAULT_SELECTED_ROLE = 'none';

export function normalizeGlobalSettingsFile(
  input: GlobalSettingsFile | null | undefined,
): GlobalSettingsFile {
  return {
    aiSettings: input?.aiSettings,
    assetLibrary: input?.assetLibrary,
    customTemplates: Array.isArray(input?.customTemplates) ? input.customTemplates : [],
    customRoles: Array.isArray(input?.customRoles) ? input.customRoles : [],
    selectedRole:
      typeof input?.selectedRole === 'string' && input.selectedRole.trim()
        ? input.selectedRole
        : DEFAULT_SELECTED_ROLE,
    migrations: input?.migrations,
  };
}
