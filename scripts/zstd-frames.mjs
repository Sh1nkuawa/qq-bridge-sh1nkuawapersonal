// 读 DSH 的会话记录文件（session.v4.jsonl.zstd）。这些文件是**多帧 zstd 拼接**的，
// 而 Node 的 zstdDecompressSync / createZstdDecompress 都只解第一帧 —— 直接读会得到
// 200 字节的会话头，看着像"这个会话什么都没有"，非常误导（排障时踩过）。
// 这里按 zstd magic number 切帧逐个解，返回完整文本。
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 找出所有帧起始偏移（含 0）。压缩数据里偶发出现同样 4 字节时靠"能否解压成功"过滤。 */
function frameOffsets(buf) {
  const offs = [0];
  let i = 1;
  while (i < buf.length - 3) {
    const at = buf.indexOf(MAGIC, i);
    if (at < 0) break;
    offs.push(at);
    i = at + 4;
  }
  return offs;
}

/** 解出全部帧的文本。单帧文件也能用。 */
export function readZstdFrames(file) {
  const raw = fs.readFileSync(file);
  const offs = frameOffsets(raw);
  const parts = [];
  for (let i = 0; i < offs.length; i++) {
    const start = offs[i];
    const end = i + 1 < offs.length ? offs[i + 1] : raw.length;
    try {
      parts.push(zlib.zstdDecompressSync(raw.subarray(start, end)));
    } catch {
      // 切错位置（magic 出现在了压缩数据内部）：把这一帧并到下一段一起试
      if (i + 2 < offs.length) {
        try {
          parts.push(zlib.zstdDecompressSync(raw.subarray(start, offs[i + 2])));
          i += 1;
        } catch { /* 真解不开就跳过这一帧 */ }
      }
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

/** 只要行。 */
export function readZstdFrameLines(file) {
  return readZstdFrames(file).split('\n').filter(Boolean);
}
