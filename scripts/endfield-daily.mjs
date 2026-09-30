#!/usr/bin/env node
// 「明日方舟：终末地日活」命令行入口 —— 实现同样在 game-daily.mjs（档案：endfield）。
//
// 与方舟那份的差别（都写在 game-daily.mjs 的 DEFAULT_ENDFIELD 注释里）：
//   · 工具是 MaaEnd.exe（MAAEND / MXU），「启动即跑」靠 config/mxu-MaaEnd.json 的 settings.autoRunOnLaunch
//   · MAAEND **不需要管理员** → 执行器提权起游戏后，用 explorer.exe 把它降权到普通权限启动
//   · 没有 ADB（Win32 controller）→ connectMode 'pc'，不等 ADB
//   · 完成判据：Tasker.Task.Succeeded 计数到「本实例启用任务数」，或日志出现"全部完成"文案；30 分钟兜底
export * from './game-daily.mjs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProfileCli } from './game-daily.mjs';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProfileCli('endfield');
}
