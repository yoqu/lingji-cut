# 平台发布参考

把导出的 MP4 发布到抖音 / 视频号 / 小红书 / 快手 / B 站账号前读取本文件。

## 前置条件

- 账号登录只能在应用「设置 → 发布账号」页扫码完成，CLI 无法代登录。
- 发布前先确认账号存在且有效：

```bash
node "$LINGJI_CLI" publish accounts --json          # 列出账号（id 形如 douyin_昵称）
node "$LINGJI_CLI" publish check <accountId> --json # 校验登录态
```

登录态 `expired` 时，请用户在应用发布页重新扫码，再继续。

## 发布

```bash
node "$LINGJI_CLI" publish run \
  --file <绝对路径.mp4> --title "<标题>" --to <acc1,acc2> \
  [--desc "<简介>"] [--tags a,b,c] [--thumbnail <封面图>] \
  [--schedule <毫秒时间戳>] [--tid <B站分区id>] [--wait]
```

- 返回 `taskId`，走标准任务轮询（`--wait` 或 `task wait <id>`）。
- 多账号串行上传；单账号失败不影响其余，任务结果里逐账号给出 `state`（success / failed / login-expired / skipped）。
- 全部账号失败时任务判失败；`login-expired` 让用户重登后重试该账号。
- 调试平台页面问题可加 `--headful`（打开可见浏览器），默认无头。

## 边界

- 标题/简介/标签由你或用户提供；不要虚构发布成功——以任务结果为准。
- 定时发布用 `--schedule`；B 站必须给 `--tid` 分区。
- 封面：`--thumbnail` 是单图兜底；多比例封面在应用发布页配置更完整。
