// cli/src/manifest.ts
// 命令清单单一真源：help 文本由此生成，测试据此校验 CLI ↔ 控制服务不漂移。

export interface CommandSpec {
  group: string;
  usage: string;
  summary: string;
  /** 该命令会调用的控制服务操作 */
  ops: string[];
}

export const COMMANDS: CommandSpec[] = [
  { group: 'project', usage: 'project current', summary: '显示应用当前活动项目', ops: ['lingji_get_active_project'] },
  { group: 'project', usage: 'project list', summary: '列出最近项目', ops: ['lingji_list_recent_projects'] },
  { group: 'project', usage: 'project open <path>', summary: '校验并切换到项目', ops: ['lingji_open_project'] },
  { group: 'project', usage: 'project create <path> [--name <n>]', summary: '创建空项目骨架', ops: ['lingji_create_project'] },
  { group: 'state', usage: 'state [--project <p>]', summary: '项目素材产物状态', ops: ['lingji_get_project_state'] },
  { group: 'state', usage: 'state --editor', summary: '编辑器打开文件状态', ops: ['lingji_get_editor_state'] },
  { group: 'state', usage: 'state --context', summary: '项目上下文/口播模板/角色', ops: ['lingji_get_project_context'] },
  { group: 'state', usage: 'state --files [--dir <d>]', summary: '列出项目文件', ops: ['lingji_list_project_files'] },
  { group: 'import', usage: 'import <url|file> [--type douyin|video|audio] [--wait]', summary: '导入媒体为原稿（转录进 original.md）', ops: ['lingji_start_video_import', 'lingji_get_video_import_status'] },
  { group: 'script', usage: 'script read [file]', summary: '读取 original.md / script.md', ops: ['lingji_read_script'] },
  { group: 'script', usage: 'script review <annotations.json>', summary: '提交审稿批注到编辑器', ops: ['lingji_review_script'] },
  { group: 'task', usage: 'task status|cancel|wait <id>', summary: '查询/取消/等待任务', ops: ['lingji_get_task_status', 'lingji_cancel_task'] },
  { group: 'task', usage: 'task list [--project <p>]', summary: '列出任务', ops: ['lingji_list_tasks'] },
  { group: 'audio', usage: 'audio gen [--wait]', summary: '生成口播音频(TTS)+字幕', ops: ['lingji_generate_audio'] },
  { group: 'subtitle', usage: 'subtitle analyze [--wait]', summary: '自动批准导演方案并兼容生成卡片', ops: ['lingji_analyze_subtitles'] },
  { group: 'director', usage: 'director plan [--prompt <text>] [--wait]', summary: '生成导演方案草案', ops: ['lingji_director_plan'] },
  { group: 'director', usage: 'director status', summary: '查看导演方案、版本与制作状态', ops: ['lingji_director_status'] },
  { group: 'director', usage: 'director approve [--revision <n>] [--wait]', summary: '批准草案并开始制作', ops: ['lingji_director_approve'] },
  { group: 'cover', usage: 'cover gen [--step prompts|images] [--wait]', summary: '封面生成（--step 可分步）', ops: ['lingji_generate_covers', 'lingji_generate_cover_prompts', 'lingji_generate_cover_images'] },
  { group: 'cards', usage: 'cards context [--card <id>|--segment <id>] [--visual-type motion|image]', summary: '取卡片生成/修复上下文', ops: ['lingji_get_card_context'] },
  { group: 'cards', usage: 'cards list|show|update|validate|delete [<cardId>] [字段]', summary: '卡片查改删/校验', ops: ['lingji_list_cards', 'lingji_get_card', 'lingji_update_card', 'lingji_validate_card', 'lingji_delete_card'] },
  { group: 'cards', usage: 'cards regenerate|sculpt|regen-media|convert <cardId> [--notes <t>] [--to image|video|motion] [--wait]', summary: '卡片重生成/雕刻/换媒体/转类型', ops: ['lingji_regenerate_card', 'lingji_sculpt_card', 'lingji_regenerate_card_media', 'lingji_convert_card'] },
  { group: 'edit', usage: 'edit lock --scope video|script [--reason <t>] [--ttl <ms>]', summary: '锁定编辑界面（file-first 编辑前）', ops: ['lingji_edit_lock'] },
  { group: 'edit', usage: 'edit unlock|heartbeat|status', summary: '解锁/心跳/查锁', ops: ['lingji_edit_unlock', 'lingji_edit_heartbeat', 'lingji_edit_lock_status'] },
  { group: 'publish', usage: 'publish accounts', summary: '列出已登录发布账号', ops: ['lingji_list_publish_accounts'] },
  { group: 'publish', usage: 'publish check <accountId>', summary: '校验账号登录态', ops: ['lingji_check_publish_account'] },
  { group: 'publish', usage: 'publish run --file <mp4> --title <t> --to <acc1,acc2> [--desc|--tags|--thumbnail|--schedule|--tid] [--wait]', summary: '发布视频到平台账号', ops: ['lingji_publish_video'] },
  { group: 'publish', usage: 'publish meta [--force] [--wait]', summary: '生成作品标题与发布文案（已有标题默认跳过）', ops: ['lingji_generate_publish_metadata'] },
  { group: 'settings', usage: 'settings show', summary: '查看应用默认设置（无密钥）', ops: ['lingji_get_settings'] },
  { group: 'settings', usage: 'settings set <key> <value>', summary: '写入白名单设置字段', ops: ['lingji_update_settings'] },
  { group: 'run', usage: 'run [--from audio|analyze|cover] [--export]', summary: '一键流水线：音频→分析→封面（可加导出）', ops: ['lingji_generate_audio', 'lingji_analyze_subtitles', 'lingji_generate_covers', 'lingji_export_video'] },
  { group: 'export', usage: 'export [--out <file>] [--wait]', summary: '导出 H.264 MP4', ops: ['lingji_export_video'] },
];

/** manifest 中出现的全部操作（去重） */
export function manifestOps(): Set<string> {
  return new Set(COMMANDS.flatMap((c) => c.ops));
}

export function buildHelp(): string {
  const lines = COMMANDS.map((c) => `  lingji ${c.usage.padEnd(76)} ${c.summary}`);
  return `灵机 CLI (lingji) —— 驱动运行中的灵机剪影应用

用法:
${lines.join('\n')}

全局开关:
  --json                JSON 输出
  --project <path>      指定项目（默认取应用当前活动项目）
  --wait                启动任务后轮询至完成
  --server <url>        覆盖控制服务地址
  --token <t>           覆盖控制服务 token（默认从 ~/.lingji/control-endpoint.json 发现）
`;
}
