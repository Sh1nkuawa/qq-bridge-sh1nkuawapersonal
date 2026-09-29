#!/usr/bin/env node
// 把仓库里 dsh/skills/<name>/ 的技能安装到 Codex/DSH 的技能目录（默认 ~/.agents/skills/）。
//
// 为什么要有这一步：技能脚本原先只活在 ~/.agents/skills/codex-image/ 里 —— 那是最容易被
// 遗忘的地方：不进版本控制、换机器就没了、改了也没人 review。现在仓库里 dsh/skills/ 是
// **源**，本目录只是安装点。
//
// 默认建 **junction**（Windows 目录联接），所以仓库里改了立刻生效、不存在两份漂移；
// junction 失败（权限/OneDrive 同步目录等）时回退为复制，并明确提示"改了要重跑"。
//
// 用法：
//   node scripts/install-skills.mjs            # 安装/刷新全部技能
//   node scripts/install-skills.mjs --copy     # 强制用复制而不是 junction
//   node scripts/install-skills.mjs --list     # 只看状态，不动文件
//   node scripts/install-skills.mjs --dest <dir>   # 自定义安装目录（默认 ~/.agents/skills）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'dsh', 'skills');
const argv = process.argv.slice(2);
const FORCE_COPY = argv.includes('--copy');
const LIST_ONLY = argv.includes('--list');
const destArg = argv.indexOf('--dest');
const DEST = destArg >= 0 && argv[destArg + 1]
  ? path.resolve(argv[destArg + 1])
  : path.join(os.homedir(), '.agents', 'skills');

function skills() {
  if (!fs.existsSync(SRC)) return [];
  return fs.readdirSync(SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(SRC, d.name, 'SKILL.md')))
    .map((d) => d.name);
}

function state(target) {
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return { kind: 'link', real: fs.realpathSync(target) };
    return { kind: 'dir', real: target };
  } catch { return null; }
}

const names = skills();
console.log(`技能源: ${SRC}`);
console.log(`安装到: ${DEST}`);
console.log(`发现技能: ${names.join(', ') || '(无)'}\n`);

if (!names.length) {
  console.error('❌ dsh/skills/ 下没有带 SKILL.md 的技能目录');
  process.exit(1);
}

let failed = 0;
for (const name of names) {
  const from = path.join(SRC, name);
  const to = path.join(DEST, name);
  const cur = state(to);
  const label = `${name}`;

  if (cur?.kind === 'link' && path.resolve(cur.real) === path.resolve(from)) {
    console.log(`✅ ${label}: 已是指向仓库的链接（${cur.real}）`);
    continue;
  }
  if (LIST_ONLY) {
    console.log(`ℹ ${label}: 当前 ${cur ? cur.kind + (cur.real ? ' → ' + cur.real : '') : '未安装'}`);
    continue;
  }

  fs.mkdirSync(DEST, { recursive: true });
  // 先清掉旧安装（只删技能自己的目录，不动别的技能）
  if (cur) {
    try { fs.rmSync(to, { recursive: true, force: true }); }
    catch (error) {
      console.error(`❌ ${label}: 无法移除旧安装 ${to} — ${error?.message ?? error}`);
      failed++;
      continue;
    }
  }

  if (FORCE_COPY) {
    fs.cpSync(from, to, { recursive: true });
    console.log(`✅ ${label}: 已复制（--copy）`);
    continue;
  }
  try {
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(from, to, type);
    console.log(`✅ ${label}: 已建链接 → ${from}`);
  } catch (error) {
    fs.cpSync(from, to, { recursive: true });
    console.log(`⚠ ${label}: 建链接失败（${error?.message ?? error}），已改为复制 —— 以后改仓库里的技能要重跑本脚本`);
  }
}

console.log(failed ? `\n❌ ${failed} 个技能失败` : '\n完成（技能源在仓库 dsh/skills/ 下，已纳入版本控制）');
process.exit(failed ? 1 : 0);
