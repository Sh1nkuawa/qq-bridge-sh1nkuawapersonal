#!/usr/bin/env node
// 「明日方舟日活」命令行入口 —— 真正的实现都在 game-daily.mjs（多游戏档案引擎，见那里的注释）。
//
// 计划任务 qq-bridge-arknights-daily 跑的就是这个文件（档案由文件名决定：arknights）。
// 参数（--dry-run / --prepare-maa / --timeout / --trigger / --profile …）都会透传给引擎。
export * from './game-daily.mjs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProfileCli } from './game-daily.mjs';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProfileCli('arknights');
}
