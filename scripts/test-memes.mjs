// meme-lib 单元测试：纯函数 + 真实图库只读自检。
// 运行：node scripts/test-memes.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MEME_MOODS,
  DEFAULT_MEME_CFG,
  mergeMemeConfig,
  defaultPackDirs,
  scanMemePacks,
  buildMemeCatalog,
  moodOfTag,
  resolveMood,
  sampleMemes,
  findMeme,
  emptyMemeStats,
  loadMemeStats,
  saveMemeStats,
  markMemeUsed,
  recentMemeIds,
  buildMemeContext,
  buildMemeStrategyHint,
  formatMemeCandidate
} from '../src/meme-lib.js';

let count = 0;
const ok = (label, fn) => { fn(); count++; console.log('  ok -', label); };

console.log('mergeMemeConfig');
ok('默认值', () => {
  const c = mergeMemeConfig(undefined);
  assert.equal(c.enabled, true);
  assert.equal(c.promptMaxMemes, DEFAULT_MEME_CFG.promptMaxMemes);
  assert.deepEqual(c.packDirs, []);
});
ok('过滤空目录并夹取数字', () => {
  const c = mergeMemeConfig({ packDirs: ['  ', 'D:\\x', ''], packs: ['a', ' '], maxPerHour: -3, promptMaxMemes: '4' });
  assert.deepEqual(c.packDirs, ['D:\\x']);
  assert.deepEqual(c.packs, ['a']);
  assert.equal(c.maxPerHour, DEFAULT_MEME_CFG.maxPerHour, '负数回落到默认');
  assert.equal(c.promptMaxMemes, 4, '数字字符串可用');
});

console.log('情绪映射');
ok('细 tag → 情绪桶', () => {
  assert.equal(moodOfTag('meow'), 'happy');
  assert.equal(moodOfTag('baka'), 'angry');
  assert.equal(moodOfTag('sigh'), 'sad');
  assert.equal(moodOfTag('daily'), 'daily');
  assert.equal(moodOfTag('unknown-tag'), '');
  assert.equal(moodOfTag(''), '');
});
ok('resolveMood：显式 tag 优先', () => {
  assert.equal(resolveMood('happy'), 'happy');
  assert.equal(resolveMood('meow'), 'happy');
  assert.equal(resolveMood('happy', '生气'), 'happy', 'tag 与 query 冲突时以 tag 为准');
  assert.equal(resolveMood('不存在的tag'), '', '未知 tag 不瞎猜');
});
ok('resolveMood：从口语推断', () => {
  assert.equal(resolveMood('', '这也太让人害羞了'), 'shy');
  assert.equal(resolveMood('', '？'), '');
  assert.equal(resolveMood('', '早上好'), 'daily');
});

console.log('抽样');
const fakeCatalog = [
  { id: 'p:a.jpg', packId: 'p', packName: 'P', rel: 'a.jpg', abs: 'D:\\p\\a.jpg', tag: 'happy', mood: 'happy', caption: 'A', keywords: '' },
  { id: 'p:b.jpg', packId: 'p', packName: 'P', rel: 'b.jpg', abs: 'D:\\p\\b.jpg', tag: 'happy', mood: 'happy', caption: 'B', keywords: '' },
  { id: 'p:c.jpg', packId: 'p', packName: 'P', rel: 'c.jpg', abs: 'D:\\p\\c.jpg', tag: 'angry', mood: 'angry', caption: 'C', keywords: '' }
];
ok('未知情绪返回空且不报错', () => {
  const r = sampleMemes(fakeCatalog, { tag: 'nope' });
  assert.equal(r.mood, '');
  assert.deepEqual(r.memes, []);
});
ok('按情绪过滤且 limit 生效', () => {
  const r = sampleMemes(fakeCatalog, { tag: 'happy', limit: 1, random: () => 0.5 });
  assert.equal(r.mood, 'happy');
  assert.equal(r.memes.length, 1);
  assert.equal(r.memes[0].mood, 'happy');
  assert.equal(r.total, 2);
});
ok('优先抽没发过的', () => {
  const stats = { entries: { 'p:a.jpg': { useCount: 3, lastUsedAt: 1 } } };
  const r = sampleMemes(fakeCatalog, { tag: 'happy', limit: 2, stats, random: () => 0.1, recentAvoid: 0 });
  assert.deepEqual(r.memes.map((m) => m.id), ['p:b.jpg', 'p:a.jpg'], '没用过的排前面');
});
ok('避开最近发过的（除非池子不够）', () => {
  const stats = { entries: { 'p:a.jpg': { useCount: 0, lastUsedAt: Date.now() } } };
  const r = sampleMemes(fakeCatalog, { tag: 'happy', limit: 5, stats, random: () => 0.1, recentAvoid: 5 });
  assert.equal(r.memes[0].id, 'p:b.jpg', '最近发过的排到后面');
  assert.equal(r.memes.length, 2, '仍然把剩下的补齐');
});

console.log('查找与越界');
ok('id / rel / 绝对路径都能找到', () => {
  assert.equal(findMeme(fakeCatalog, 'p:a.jpg').rel, 'a.jpg');
  assert.equal(findMeme(fakeCatalog, 'a.jpg').id, 'p:a.jpg');
  assert.equal(findMeme(fakeCatalog, 'D:\\p\\a.jpg').id, 'p:a.jpg');
});
ok('未知引用与目录穿越都找不到', () => {
  assert.equal(findMeme(fakeCatalog, '../../windows/win.ini'), null);
  assert.equal(findMeme(fakeCatalog, 'D:\\p\\nope.jpg'), null);
  assert.equal(findMeme(fakeCatalog, ''), null);
  assert.equal(findMeme(fakeCatalog, null), null);
});

console.log('使用统计');
ok('markMemeUsed 累加且保留上下文', () => {
  let s = emptyMemeStats();
  s = markMemeUsed(s, 'x', '第一次', 1000);
  s = markMemeUsed(s, 'x', '第二次', 2000);
  assert.equal(s.entries.x.useCount, 2);
  assert.equal(s.entries.x.lastUsedAt, 2000);
  assert.equal(s.entries.x.lastContext, '第二次');
});
ok('recentMemeIds 按时间倒序并截断', () => {
  let s = emptyMemeStats();
  s = markMemeUsed(s, 'a', '', 100);
  s = markMemeUsed(s, 'b', '', 300);
  s = markMemeUsed(s, 'c', '', 200);
  assert.deepEqual(recentMemeIds(s, 2), ['b', 'c']);
  assert.deepEqual(recentMemeIds(s, 0), []);
});
ok('落盘 / 读回（含 BOM 容错）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-stats-'));
  const file = path.join(dir, 'memes.json');
  saveMemeStats(file, markMemeUsed(emptyMemeStats(), 'k', 'ctx', 1234));
  const back = loadMemeStats(file);
  assert.equal(back.entries.k.useCount, 1);
  assert.equal(back.entries.k.lastUsedAt, 1234);
  fs.writeFileSync(file, '\uFEFF' + fs.readFileSync(file, 'utf8'));
  assert.equal(loadMemeStats(file).entries.k.useCount, 1, 'BOM 也能读');
  fs.rmSync(dir, { recursive: true, force: true });
});
ok('坏文件回落到空统计', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-stats-bad-'));
  const file = path.join(dir, 'memes.json');
  fs.writeFileSync(file, '{ 这不是 json');
  assert.deepEqual(loadMemeStats(file).entries, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('提示词');
ok('策略提示含工具名与情绪桶', () => {
  const hint = buildMemeStrategyHint();
  assert.match(hint, /qq_send_meme/);
  assert.match(hint, /happy/);
  assert.match(hint, /qq_send_sticker/, '会和收藏表情分工说明');
});
ok('无收藏表情通道时不提收藏表情', () => {
  assert.doesNotMatch(buildMemeStrategyHint(false), /qq_send_sticker/);
});
ok('目录摘要含数量与示例', () => {
  const ctx = buildMemeContext(fakeCatalog, emptyMemeStats(), [{ id: 'p', name: 'P', rows: [1, 2, 3] }], 2);
  assert.match(ctx, /共 3 张/);
  assert.match(ctx, /P\(3\)/);
  assert.match(ctx, /happy 2/);
  const lines = ctx.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 2, 'max 生效');
});
ok('空目录返回空串（不注入无意义提示）', () => {
  assert.equal(buildMemeContext([], emptyMemeStats(), []), '');
  assert.equal(buildMemeContext(null, null, null), '');
});
ok('候选行格式含 path 与 caption', () => {
  const line = formatMemeCandidate(fakeCatalog[0]);
  assert.match(line, /path=p:a\.jpg/);
  assert.match(line, /\[happy\] A/);
});

console.log('真实图库自检（用户机器上的 dsh-meme）');
const dirs = defaultPackDirs();
console.log('  探测到图库根:', dirs.length ? dirs.join(' | ') : '（无）');
if (dirs.length) {
  const packs = scanMemePacks(dirs);
  console.log('  pack:', packs.map((p) => `${p.id}(${p.rows.length}, ${p.source})`).join(' ') || '（无）');
  if (packs.length) {
    const catalog = buildMemeCatalog(packs, mergeMemeConfig());
    ok('目录非空且 id 唯一', () => {
      assert.ok(catalog.length > 0);
      assert.equal(new Set(catalog.map((m) => m.id)).size, catalog.length);
    });
    ok('所有条目文件真实存在且落在 pack 目录内', () => {
      for (const m of catalog) {
        assert.ok(fs.existsSync(m.abs), `${m.id} 文件不存在`);
        const dir = packs.find((p) => p.id === m.packId).dir;
        assert.ok(m.abs.startsWith(path.resolve(dir) + path.sep), `${m.id} 越出 pack 目录`);
      }
    });
    ok('caption 与情绪桶可用', () => {
      const withCaption = catalog.filter((m) => m.caption).length;
      assert.ok(withCaption > catalog.length * 0.8, `有 caption 的比例过低：${withCaption}/${catalog.length}`);
      assert.ok(catalog.some((m) => m.mood === 'happy'));
    });
    ok('真实图库能抽到候选', () => {
      const r = sampleMemes(catalog, { tag: 'happy', limit: 5, random: () => 0.42 });
      assert.equal(r.mood, 'happy');
      assert.ok(r.memes.length > 0);
      assert.ok(r.memes.every((m) => m.mood === 'happy'));
    });
  }
} else {
  console.log('  （跳过：本机没有 dsh-meme 图库）');
}

console.log('接线存在性（静态检查，防止“改了模块忘了接线”）');
{
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  const bridge = read('src/bridge.js');
  for (const s of [
    '/api/socialV2/meme-list',
    '/api/socialV2/meme-image',
    '/api/socialV2/send-meme',
    '/api/socialV2/meme-probe',
    '/api/socialV2/meme-test-send',
    'sendMemeV2',
    'ensureMemeCatalog',
    'memeListForV2',
    'memeImageData',
    'buildMemeStrategyHint',
    'buildMemeContext'
  ]) {
    ok(`bridge 包含 ${s}`, () => assert.ok(bridge.includes(s), `缺少 ${s}`));
  }
  ok('bridge 把 memes 纳入 config 归一化', () => {
    assert.match(bridge, /body\.memes && typeof body\.memes === 'object'/);
    assert.match(bridge, /'sendMeme'/);
  });
  ok('bridge 控制台专用接口登记在 adminOnlyV2Paths', () => {
    const line = bridge.split('\n').find((l) => l.includes('adminOnlyV2Paths'));
    assert.ok(line.includes('/api/socialV2/meme-probe'), 'meme-probe 未登记');
    assert.ok(line.includes('/api/socialV2/meme-test-send'), 'meme-test-send 未登记');
  });
  ok('bridge 唤醒提示里注入了 memeLine', () => {
    assert.match(bridge, /const memeLine = \(\(\) => \{/);
    assert.match(bridge, /stickerLine \+ memeLine \+ adminLine \+ preSleepLine/);
  });

  const mcp = read('src/mcp-snowluma-safe.js');
  for (const s of ["'qq_send_meme'", '/api/socialV2/meme-list', '/api/socialV2/send-meme', '/api/socialV2/meme-image']) {
    ok(`MCP 含 ${s}`, () => assert.ok(mcp.includes(s), `缺少 ${s}`));
  }
  ok('MCP 的 qq_send_meme 不接受 message 参数（单气泡）', () => {
    const block = mcp.slice(mcp.indexOf("'qq_send_meme'"), mcp.indexOf("'qq_get_self_image'"));
    assert.ok(!/message:\s*z\.string\(\)/.test(block), '不该有 message 参数');
    assert.match(block, /不能带文字/);
  });

  const cfg = JSON.parse(read('config.json'));
  ok('config.json 打开了 memes 与 sendMeme 开关', () => {
    assert.equal(cfg.socialV2.memes.enabled, true);
    assert.equal(cfg.socialV2.tools.sendMeme, true);
  });

  const consoleHtml = read('public/console.html');
  ok('控制台有 memes 参数与工具勾选', () => {
    for (const s of ['data-v2-tool="sendMeme"', 'id="v2MemesEnabled"', '/api/socialV2/meme-probe', '/api/socialV2/meme-test-send']) {
      assert.ok(consoleHtml.includes(s), `控制台缺少 ${s}`);
    }
  });

  const preset = read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
  ok('预设含 26.1 本地表情包库规则与工具速查', () => {
    assert.match(preset, /26\.1 【本地表情包库/);
    assert.ok(preset.includes('qq_send_meme'), '预设未提到 qq_send_meme');
  });
  const live = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', '.agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
  if (fs.existsSync(live)) {
    ok('仓库 preset 与 ~/.dsh 下的实际 preset 一致', () => {
      assert.equal(fs.readFileSync(live, 'utf8'), preset, '两份 preset 不一致，记得同步');
    });
  }
}

console.log(`\n全部通过：${count} 项断言组`);
