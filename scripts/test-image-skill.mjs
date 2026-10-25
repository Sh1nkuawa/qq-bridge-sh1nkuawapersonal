// 生图技能「入库」验收：
//  ① 技能文件在仓库里（dsh/skills/codex-image/），且**不含**任何本机敏感信息；
//  ② worker 优先用仓库副本、其次 ~/.agents 安装副本；
//  ③ 安装脚本可用（--list 能看到技能）；装了的话，安装点必须指向仓库（junction）而不是
//     一份会漂移的拷贝。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, 'dsh', 'skills', 'codex-image');
const SCRIPT = path.join(SKILL_DIR, 'scripts', 'codex-image.ps1');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');
const INSTALLED = path.join(os.homedir(), '.agents', 'skills', 'codex-image');

let pass = 0; let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + ' — ' + (e?.message ?? e)); }
};

console.log('## 技能已入库');
ok('SKILL.md 在仓库里', () => assert.ok(fs.existsSync(SKILL_MD)));
ok('codex-image.ps1 在仓库里', () => assert.ok(fs.existsSync(SCRIPT)));
ok('SKILL.md 里有技能元信息（name/description）', () => {
  const t = fs.readFileSync(SKILL_MD, 'utf8');
  assert.match(t, /^name:\s*codex-image/m);
  assert.match(t, /description:/);
});
ok('脚本有 -Prompt / -Out 参数（worker 就按这两个调）', () => {
  const t = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(t, /\$Prompt/);
  assert.match(t, /\$Out/);
});
ok('仓库里的技能目录被 git 跟踪（不是靠 .gitignore 放着）', () => {
  const r = spawnSync('git', ['ls-files', 'dsh/skills'], { cwd: ROOT, encoding: 'utf8' });
  const files = (r.stdout || '').trim().split('\n').filter(Boolean);
  assert.ok(files.length >= 2, 'git ls-files 里看不到 dsh/skills 下的文件：' + r.stdout);
});

console.log('\n## 不含本机敏感信息（入库前的红线）');
const blob = [fs.readFileSync(SKILL_MD, 'utf8'), fs.readFileSync(SCRIPT, 'utf8')].join('\n');
for (const [what, re] of [
  ['本机用户名', /User/],
  ['群号 123456789', /123456789/],
  ['owner QQ', /100000001/],
  ['机器人 QQ', /100000003/],
  ['OneBot 令牌前缀 !1407', /!1407/],
  ['控制台令牌前缀 83e9df', /83e9df/],
  ['Tavily key 前缀 tvly', /tvly/],
  ['afdian token 前缀 awHVe', /awHVe/],
  ['写死的 C:\\Users 路径', /C:\\Users\\/i],
  ['写死的 D:\\dsh 路径', /D:\\dsh/i],
]) {
  ok(`不含 ${what}`, () => assert.ok(!re.test(blob), `命中 ${re}`));
}

console.log('\n## worker 的解析顺序');
const worker = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-image-worker.mjs'), 'utf8');
ok('先找仓库副本，再找 ~/.agents', () => {
  const repoAt = worker.indexOf("path.join(ROOT, 'dsh', 'skills', 'codex-image'");
  const homeAt = worker.indexOf("'.agents', 'skills', 'codex-image'");
  assert.ok(repoAt > 0 && homeAt > repoAt, `仓库副本应排在前（repoAt=${repoAt}, homeAt=${homeAt}）`);
});
ok('--print-paths 能跑通并指向仓库副本', () => {
  const r = spawnSync(process.execPath, ['scripts/gen-image-worker.mjs', '--print-paths'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✅ 存在\s+.*dsh\\skills\\codex-image\\scripts\\codex-image\.ps1/);
  assert.match(r.stdout, /→ 实际使用: .*dsh\\skills\\codex-image/);
});
ok('脚本缺失时给出"找过哪些位置 + 怎么装"的报错', () => {
  assert.match(worker, /找不到生图脚本/);
  assert.match(worker, /install-skills\.mjs/);
});

console.log('\n## 安装脚本');
ok('install-skills.mjs 存在且 --list 能识别技能', () => {
  const r = spawnSync(process.execPath, ['scripts/install-skills.mjs', '--list'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /codex-image/);
});
if (fs.existsSync(INSTALLED)) {
  ok('安装点是链接且指向仓库（避免两份漂移）', () => {
    const st = fs.lstatSync(INSTALLED);
    assert.ok(st.isSymbolicLink(), '安装点不是链接（是复制）—— 会随时间漂移；请重跑 install-skills.mjs');
    assert.equal(path.resolve(fs.realpathSync(INSTALLED)), path.resolve(SKILL_DIR));
  });
} else {
  console.log('  ⏭  跳过：本机还没装（~/.agents/skills/codex-image 不存在）');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
