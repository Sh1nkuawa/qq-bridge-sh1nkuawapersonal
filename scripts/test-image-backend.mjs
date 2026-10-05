// Agent Plan 生图后端：纯函数 + 请求构造 + 错误路径的离线回归（不联网）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ARK_MODEL,
  DEFAULT_ARK_SIZE,
  buildArkBody,
  detectImageMime,
  extensionForMime,
  generateWithArk,
  normalizeArkEndpoint,
  pickImageBackend
} from '../src/ark-image.mjs';

let count = 0;
function ok(name, fn) { fn(); count += 1; console.log(`  ✅ ${name}`); }
async function okAsync(name, fn) { await fn(); count += 1; console.log(`  ✅ ${name}`); }

const worker = fs.readFileSync(fileURLToPath(new URL('./gen-image-worker.mjs', import.meta.url)), 'utf8');
// 造两个真图头，验证按字节认格式
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 0x20)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 0)]);

console.log('Agent Plan 生图后端：');

ok('端点规整：整条 URL 原样保留', () => {
  assert.equal(
    normalizeArkEndpoint('https://ark.cn-beijing.volces.com/api/plan/v3/images/generations'),
    'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations'
  );
});

ok('端点规整：带 /api 前缀的 base 自动补 /images/generations', () => {
  assert.equal(normalizeArkEndpoint('https://ark.cn-beijing.volces.com/api/plan/v3'),
    'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations');
  assert.equal(normalizeArkEndpoint('https://ark.cn-beijing.volces.com/api/plan/v3/'),
    'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations');
});

ok('端点规整：只给主机时补完整的 Agent Plan 路径（避免误用会产生额外费用的 /api/v3）', () => {
  assert.equal(normalizeArkEndpoint('https://ark.cn-beijing.volces.com'),
    'https://ark.cn-beijing.volces.com/api/plan/v3/images/generations');
  assert.equal(normalizeArkEndpoint(''), '');
});

ok('请求体：默认模型/尺寸、关水印、要 b64', () => {
  const body = buildArkBody({ prompt: '一只鲸鱼' });
  assert.equal(body.model, DEFAULT_ARK_MODEL);
  assert.equal(body.size, DEFAULT_ARK_SIZE);
  assert.equal(body.prompt, '一只鲸鱼');
  assert.equal(body.watermark, false);
  assert.equal(body.response_format, 'b64_json');
  assert.ok(!('image' in body), '没有参考图时不该带 image 字段');
});

ok('请求体：单张参考图传字符串、多张传数组', () => {
  assert.equal(buildArkBody({ prompt: 'x', images: ['a'] }).image, 'a');
  assert.deepEqual(buildArkBody({ prompt: 'x', images: ['a', 'b'] }).image, ['a', 'b']);
  assert.equal(buildArkBody({ prompt: 'x', images: [] }).image, undefined);
});

ok('按字节认图片格式（Ark 常返回 JPEG，不能被 .png 扩展名骗）', () => {
  assert.equal(detectImageMime(jpeg), 'image/jpeg');
  assert.equal(detectImageMime(png), 'image/png');
  assert.equal(detectImageMime(Buffer.from('not an image at all')), null);
  assert.equal(extensionForMime('image/jpeg'), '.jpg');
  assert.equal(extensionForMime('image/png'), '.png');
});

ok('后端选择：默认 auto（配好 Agent Plan 就用它，否则 codex）', () => {
  assert.equal(pickImageBackend({}, { hasArk: true }), 'ark');
  assert.equal(pickImageBackend({}, { hasArk: false }), 'codex');
  assert.equal(pickImageBackend({ backend: 'auto' }, { hasArk: true }), 'ark');
});

ok('后端选择：backend=codex 强制 codex；backend=ark 但没配好也会退回 codex', () => {
  assert.equal(pickImageBackend({ backend: 'codex' }, { hasArk: true }), 'codex');
  assert.equal(pickImageBackend({ backend: 'codex' }, { hasArk: false }), 'codex');
  assert.equal(pickImageBackend({ backend: 'ark' }, { hasArk: false }), 'codex');
  assert.equal(pickImageBackend({ backend: 'ARK' }, { hasArk: true }), 'ark');
});

await okAsync('调用成功：解析 b64_json 并按字节给出正确 mime', async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ data: [{ b64_json: jpeg.toString('base64') }], usage: { generated_images: 1 } })
  });
  const res = await generateWithArk({ endpoint: 'https://h/api/plan/v3', apiKey: 'ark-x', prompt: 'p', fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  assert.equal(res.mimeType, 'image/jpeg');
  assert.equal(res.buffer.length, jpeg.length);
});

await okAsync('调用成功：只给 url 时会把图下下来', async () => {
  let calls = 0;
  const fakeFetch = async (url) => {
    calls += 1;
    if (calls === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: 'https://cdn/x.jpg' }] }) };
    return { ok: true, status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length) };
  };
  const res = await generateWithArk({ endpoint: 'https://h/api/plan/v3', apiKey: 'ark-x', prompt: 'p', fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  assert.equal(res.mimeType, 'image/png');
});

await okAsync('调用失败：401 带出服务端原文，交给上层回落 codex', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'The API key doesn\'t exist' } }) });
  const res = await generateWithArk({ endpoint: 'https://h/api/plan/v3', apiKey: 'bad', prompt: 'p', fetchImpl: fakeFetch });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.match(res.message, /doesn't exist/);
});

await okAsync('调用失败：缺 key / 缺端点时直接拒绝（不发请求）', async () => {
  let called = false;
  const fakeFetch = async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; };
  const a = await generateWithArk({ endpoint: 'https://h/api/plan/v3', apiKey: '', prompt: 'p', fetchImpl: fakeFetch });
  const b = await generateWithArk({ endpoint: '', apiKey: 'ark-x', prompt: 'p', fetchImpl: fakeFetch });
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(called, false, '参数不全时不该真的发请求');
});

ok('worker 接线：默认 Agent Plan、失败回落 codex、扩展名按真实字节修正', () => {
  assert.match(worker, /import \{[\s\S]{0,400}?pickImageBackend[\s\S]{0,200}?\} from '\.\.\/src\/ark-image\.mjs';/);
  assert.match(worker, /const backend = pickImageBackend\(imageCfg, \{ hasArk: arkConfig\(\)\.hasArk \}\);/);
  assert.match(worker, /回落 codex（原因：/);
  assert.match(worker, /const r = await runCodexImage\(prompt, out, images\);/);
  assert.match(worker, /outPath\.replace\(\/\\\.\[A-Za-z0-9\]\+\$\/, ext\)/, '写盘前要按真实格式改扩展名');
  assert.match(worker, /state\/ark-key\.txt/);
  assert.match(worker, /state\/ark-base\.txt/);
});

console.log(`\n全部通过：${count} 项断言组`);
