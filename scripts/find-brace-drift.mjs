// 用「锚点前缀扫描」定位合并后括号失衡（多一个 { 或少一个 }）出现的区间。
// 用法: node scripts/find-brace-drift.mjs <参照版本(git show 语法可用命令留给外部)> ...
// 这里直接：参照 = git stage2 (HEAD/ours)，目标 = 工作区文件。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { scanBraces } from './check-braces.mjs';

const target = process.argv[2] || 'src/bridge.js';
const refSpec = process.argv[3] || ':2:src/bridge.js';

const merged = fs.readFileSync(target, 'utf8').split('\n');
const ref = execFileSync('git', ['show', refSpec], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).split('\n');

const mapUnique = (lines) => {
  const m = new Map();
  lines.forEach((t, i) => {
    const k = t.trim();
    if (k.length < 12) return;
    if (!/[A-Za-z_$]/.test(k)) return;
    const rec = m.get(k);
    if (rec) rec.count++;
    else m.set(k, { count: 1, idx: [i] });
    if (rec) rec.idx.push(i);
  });
  return m;
};

const refMap = mapUnique(ref);
const tgtMap = mapUnique(merged);

// 收集共同唯一行作为锚点，按参照文件行号排序，并按间距抽稀
const anchors = [];
{
  const seen = [];
  for (const [k, v] of refMap) {
    if (v.count !== 1) continue;
    const tv = tgtMap.get(k);
    if (!tv || tv.count !== 1) continue;
    seen.push({ key: k, refLine: v.idx[0], tgtLine: tv.idx[0] });
  }
  seen.sort((a, b) => a.refLine - b.refLine);
  let last = -1e9;
  for (const a of seen) {
    if (a.refLine - last >= 120) { anchors.push(a); last = a.refLine; }
  }
}

const depthOfPrefix = (lines, endLine) => {
  const r = scanBraces(lines.slice(0, endLine + 1).join('\n'));
  return r.ok ? 0 : r.stack.length;
};

let lastSame = null;
let firstDrift = null;
for (const a of anchors) {
  const dm = depthOfPrefix(merged, a.tgtLine);
  const dr = depthOfPrefix(ref, a.refLine);
  const label = `ref:${a.refLine + 1} tgt:${a.tgtLine + 1}  ${a.key.slice(0, 78)}`;
  if (dm !== dr) {
    console.log(`DRIFT  ref深度=${dr} 合并深度=${dm}  ${label}`);
    if (!firstDrift) firstDrift = a;
  } else {
    lastSame = a;
  }
}

console.log('---');
if (!firstDrift) {
  console.log('没有发现深度漂移（锚点范围内一致）');
} else {
  console.log('最后一个一致锚点：' + (lastSame ? `ref:${lastSame.refLine + 1} tgt:${lastSame.tgtLine + 1}  ${lastSame.key.slice(0, 78)}` : '(无)'));
  console.log('第一个漂移锚点：' + `ref:${firstDrift.refLine + 1} tgt:${firstDrift.tgtLine + 1}  ${firstDrift.key.slice(0, 78)}`);
  console.log(`=> 失衡点位于 ref 第 ${lastSame ? lastSame.refLine + 2 : 1} ~ ${firstDrift.refLine + 1} 行之间（对应合并文件第 ${lastSame ? lastSame.tgtLine + 2 : 1} ~ ${firstDrift.tgtLine + 1} 行）`);
}
