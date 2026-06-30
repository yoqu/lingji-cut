import type { MenuItemConstructorOptions } from 'electron';
import type { MenuContext, MenuEvent } from '../src/lib/electron-api';

interface ApplicationMenuContext extends MenuContext {
  isDevelopment: boolean;
  debugMode: boolean;
}

interface ApplicationMenuHandlers {
  onToggleDebugMode: () => void;
  onOpenLogDirectory: () => void;
  onExportLogs: () => void;
  onShowAbout: () => void;
}

function createRecentProjectsSubmenu(
  recentProjects: MenuContext['recentProjects'],
  sendMenuEvent: (event: MenuEvent) => void,
  interactionLocked: boolean,
): MenuItemConstructorOptions[] {
  if (recentProjects.length === 0) {
    return [
      {
        label: '暂无最近项目',
        enabled: false,
      },
    ];
  }

  return recentProjects.map((project) => ({
    label: project.name,
    toolTip: project.path,
    enabled: !interactionLocked,
    click: () =>
      sendMenuEvent({
        type: 'open-recent-project',
        projectDir: project.path,
      }),
  }));
}

export function createApplicationMenuTemplate(
  sendMenuEvent: (event: MenuEvent) => void,
  context: ApplicationMenuContext,
  handlers?: Partial<ApplicationMenuHandlers>,
): MenuItemConstructorOptions[] {
  const menuHandlers: ApplicationMenuHandlers = {
    onToggleDebugMode: handlers?.onToggleDebugMode ?? (() => sendMenuEvent({ type: 'command', action: 'open-settings' })),
    onOpenLogDirectory: handlers?.onOpenLogDirectory ?? (() => sendMenuEvent({ type: 'command', action: 'open-settings' })),
    onExportLogs: handlers?.onExportLogs ?? (() => sendMenuEvent({ type: 'command', action: 'open-settings' })),
    onShowAbout: handlers?.onShowAbout ?? (() => sendMenuEvent({ type: 'command', action: 'open-settings' })),
  };
  // 一键成稿运行中：禁用大部分会触发副作用 / 跳页 / 写文件的菜单项，
  // 仅保留帮助、开发者工具与退出等无破坏性的入口。
  const isAutoRunning = Boolean(context.isAutoRunning);
  const interactionLocked = isAutoRunning || Boolean(context.isAiEditing);
  const template: MenuItemConstructorOptions[] = [
    {
      label: '项目',
      submenu: [
        {
          label: '新建项目',
          accelerator: 'CmdOrCtrl+N',
          enabled: !interactionLocked,
          click: () =>
            sendMenuEvent({
              type: 'command',
              action: 'new-project',
            }),
        },
        {
          label: '打开项目',
          accelerator: 'CmdOrCtrl+O',
          enabled: !interactionLocked,
          click: () =>
            sendMenuEvent({
              type: 'command',
              action: 'open-project',
            }),
        },
        {
          label: '最近项目',
          enabled: !interactionLocked,
          submenu: createRecentProjectsSubmenu(
            context.recentProjects,
            sendMenuEvent,
            interactionLocked,
          ),
        },
        { type: 'separator' },
        {
          label: '全局设置',
          accelerator: 'CmdOrCtrl+,',
          enabled: !interactionLocked,
          click: () =>
            sendMenuEvent({
              type: 'command',
              action: 'open-settings',
            }),
        },
        { type: 'separator' },
        context.hasProject
          ? {
              label: '关闭项目',
              accelerator: 'CmdOrCtrl+W',
              enabled: !interactionLocked,
              click: () =>
                sendMenuEvent({
                  type: 'command',
                  action: 'close-project',
                }),
            }
          : {
              label: '关闭窗口',
              accelerator: 'CmdOrCtrl+W',
              enabled: !interactionLocked,
              role: 'close',
            },
        {
          label: '在 Finder 中显示',
          enabled: context.hasProject && !interactionLocked,
          click: () =>
            sendMenuEvent({
              type: 'command',
              action: 'show-project-in-folder',
            }),
        },
        { type: 'separator' },
        {
          label: '关于灵机剪影',
          click: () => menuHandlers.onShowAbout(),
        },
        {
          label: '退出应用',
          accelerator: 'CmdOrCtrl+Q',
          role: 'quit',
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo', enabled: !interactionLocked },
        { label: '重做', role: 'redo', enabled: !interactionLocked },
        { type: 'separator' },
        { label: '剪切', role: 'cut', enabled: !interactionLocked },
        { label: '复制', role: 'copy', enabled: !isAutoRunning },
        { label: '粘贴', role: 'paste', enabled: !interactionLocked },
        { label: '全选', role: 'selectAll', enabled: !isAutoRunning },
        ...(context.activePage === 'script-workbench'
          ? [
              { type: 'separator' as const },
              {
                label: '搜索',
                accelerator: 'CmdOrCtrl+F',
                enabled: !interactionLocked,
                click: () =>
                  sendMenuEvent({ type: 'command', action: 'find' }),
              },
              {
                label: '搜索与替换',
                accelerator: 'CmdOrCtrl+H',
                enabled: !interactionLocked,
                click: () =>
                  sendMenuEvent({ type: 'command', action: 'find-replace' }),
              },
            ]
          : []),
      ],
    },
    {
      label: '媒体',
      submenu: [
        {
          label: '替换音频',
          enabled: !interactionLocked,
          click: () =>
            sendMenuEvent({
              type: 'command',
              action: 'replace-audio',
            }),
        },
        {
          label: '替换字幕',
          enabled: !interactionLocked,
          click: () =>
            sendMenuEvent({
              type: 'command',
              action: 'replace-srt',
            }),
        },
        {
          label: '添加素材',
          enabled: !interactionLocked,
          click: () =>
            sendMenuEvent({
              type: 'command',
              action: 'add-asset',
            }),
        },
        {
          label: '导出 MP4',
          accelerator: 'CmdOrCtrl+E',
          enabled: !interactionLocked,
          click: () =>
            sendMenuEvent({
              type: 'command',
              action: 'export',
            }),
        },
      ],
    },
  ];

  if (context.activePage !== 'editor') {
    const mediaMenuIndex = template.findIndex((item) => item.label === '媒体');
    if (mediaMenuIndex >= 0) {
      template.splice(mediaMenuIndex, 1);
    }
  }

  // 写稿工作台：在项目菜单顶部插入保存和返回
  if (context.activePage === 'script-workbench') {
    const projectMenu = template.find((item) => item.label === '项目');
    if (projectMenu && Array.isArray(projectMenu.submenu)) {
      (projectMenu.submenu as MenuItemConstructorOptions[]).unshift(
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          enabled: !interactionLocked,
          click: () =>
            sendMenuEvent({
              type: 'command',
              action: 'save-script',
            }),
        },
        {
          label: '返回主页',
          enabled: !interactionLocked,
          click: () =>
            sendMenuEvent({
              type: 'command',
              action: 'go-back',
            }),
        },
        { type: 'separator' },
      );
    }
  }

  if (context.isDevelopment) {
    template.push({
      label: '开发',
      submenu: [
        { label: '切换开发者工具', role: 'toggleDevTools' },
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
      ],
    });
  }

  template.push({
    label: '帮助',
    submenu: [
      {
        label: '启用调试模式（重启生效）',
        type: 'checkbox',
        checked: context.debugMode,
        click: () => menuHandlers.onToggleDebugMode(),
      },
      {
        label: '打开日志目录',
        click: () => menuHandlers.onOpenLogDirectory(),
      },
      {
        label: '导出日志 ZIP',
        click: () => menuHandlers.onExportLogs(),
      },
    ],
  });

  return template;
}
