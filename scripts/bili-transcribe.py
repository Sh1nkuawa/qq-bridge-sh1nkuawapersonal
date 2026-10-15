#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bili-transcribe.py —— 把一条 B 站视频转成文字（给"这视频讲了什么"用的）。

来源与许可
----------
本脚本改编自 **dsh-bili-scroll / dsh-bili-duty** 项目的 `lib/asr.py`
（https://github.com/c1overzz/dsh-bili-scroll ，MIT License，Copyright (c) 2026 dsh-bili-duty contributors）。
它里面那些"沙箱里踩出来的"细节我们原样保留（见下面各处 ⭐ 注释），因为都是实测教训：
  - 临时目录必须在**家目录内**（沙箱只允许写工作区/cwd，写 %TEMP% 会被拒）
  - yt-dlp 要 `nopart: True`（沙箱里"新建 + 改名"会被拒）
  - 每个视频用**自己的**文件名（写死 audio.m4a 时，两轮同时跑会互相覆盖，转出来是别的视频的内容）
  - 模型走国内镜像 `HF_ENDPOINT=hf-mirror.com`，并关掉 HF 的 Xet 通道（国内镜像不代理它，会 401）

与上游的差别（qq-bridge 侧）
--------------------------
  - 家目录从 `lib/` 换成 `state/asr/`（我们这边 state/ 整个是 gitignored）
  - 默认 **不**清空模型缓存目录；临时音频仍然跑完即删
  - 支持 `--json`（给桥接解析）与 `--max-seconds`（超长视频直接拒绝，避免把一轮卡死）
  - 默认设备/精度可由环境变量覆盖：BILI_ASR_DEVICE / BILI_ASR_COMPUTE / BILI_ASR_MODEL

用法
----
    <venv>/Scripts/python.exe bili-transcribe.py BV1xxxxxxxxx
    <venv>/Scripts/python.exe bili-transcribe.py https://www.bilibili.com/video/BV1xx --json
    <venv>/Scripts/python.exe bili-transcribe.py D:\\clip.mp4 -o out.txt

退出码：0 成功；2 输入/文件问题；3 超长；4 依赖缺失；5 转写失败
"""
import argparse
import glob
import json
import os
import re
import sys
import tempfile
import time

# ── 家目录与临时目录（⭐ 必须在可写范围内，见文件头）────────────────────────
# qq-bridge 侧：模型缓存与临时音频都放 state/asr/（state/ 整体 gitignored，
# 免得 500MB 的 whisper 模型落进仓库目录被提交 ✗）
_HOME = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'state', 'asr'))
_TMP = os.path.join(_HOME, 'tmp')
try:
    os.makedirs(_TMP, exist_ok=True)
    tempfile.tempdir = _TMP
except Exception:
    pass

# ⭐ 必须在 import faster_whisper 之前设好
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HOME', os.path.join(_HOME, '.hf-cache'))
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')


def to_url(target: str) -> str:
    t = (target or '').strip()
    if t.upper().startswith('BV') and len(t) <= 20:
        return 'https://www.bilibili.com/video/' + t
    return t


def bili_cookie_file(tmp: str) -> str:
    """领一对匿名 buvid cookie 写成 cookiefile。

    为什么需要：不带 cookie 去拉 B 站播放链路会被风控 **HTTP 412 Precondition Failed**
    （2026-10-15 在本机实测：yt-dlp 取 BV1tvp96tEZN 直接 412；而 x/web-interface/view
    这类只读接口是好的）。`x/frontend/finger/spi` 会给匿名访客发 b_3 / b_4，
    写成 buvid3 / buvid4 之后 412 就没了 —— 全程**不需要登录**。
    """
    path_ = os.path.join(tmp, 'bili-cookies.txt')
    try:
        import urllib.request
        req = urllib.request.Request(
            'https://api.bilibili.com/x/frontend/finger/spi',
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': 'https://www.bilibili.com/',
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode('utf-8', 'replace'))
        b3 = (data.get('data') or {}).get('b_3')
        b4 = (data.get('data') or {}).get('b_4')
        if not b3:
            return ''
        exp = int(time.time()) + 86400 * 30
        lines = ['# Netscape HTTP Cookie File']
        for name, value in (('buvid3', b3), ('buvid4', b4)):
            if value:
                lines.append('\t'.join(['.bilibili.com', 'TRUE', '/', 'FALSE', str(exp), name, value]))
        with open(path_, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')
        print('[asr] 已领取匿名 buvid cookie（免登录，用于绕开 412）', file=sys.stderr)
        return path_
    except Exception as e:
        print('[asr] 领取 buvid cookie 失败：%s' % str(e)[:120], file=sys.stderr)
        return ''


def fetch_audio(url: str, tmp: str, tag: str) -> str:
    """yt-dlp 取 bestaudio（B 站是 DASH 音视频分离，不需要 ffmpeg 合并）"""
    from yt_dlp import YoutubeDL
    cookie_file = bili_cookie_file(tmp)
    opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(tmp, tag + '.%(ext)s'),   # ⭐ 用 BV 号当文件名
        'paths': {'home': tmp, 'temp': tmp},
        'cachedir': False,
        'nopart': True,                                    # ⭐ 见文件头
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'http_headers': {
            'Referer': 'https://www.bilibili.com',
            'Origin': 'https://www.bilibili.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
    }
    if cookie_file:
        opts['cookiefile'] = cookie_file
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        return ydl.prepare_filename(info)


def main() -> int:
    ap = argparse.ArgumentParser(description='把一条视频转成文字（默认中文）')
    ap.add_argument('target', help='BV 号 / B站链接 / 本地音视频文件')
    ap.add_argument('-o', '--out', help='写到这个文件（不给就打到标准输出）')
    ap.add_argument('--model', default=os.environ.get('BILI_ASR_MODEL', 'small'),
                    help='Whisper 模型：tiny / base / small / medium / large-v3（默认 small）')
    ap.add_argument('--device', default=os.environ.get('BILI_ASR_DEVICE', 'cpu'), help='cpu / cuda')
    ap.add_argument('--compute', default=os.environ.get('BILI_ASR_COMPUTE', 'int8'), help='int8 / float16 / int8_float16')
    ap.add_argument('--lang', default='zh', help='语言（auto = 自动判断）')
    ap.add_argument('--json', action='store_true', help='输出 JSON（给桥接解析）')
    ap.add_argument('--max-seconds', type=int, default=0, help='超过这个时长直接拒绝（0 = 不限制）')
    args = ap.parse_args()

    t0 = time.time()
    src = args.target
    tag = os.path.basename(src).rsplit('.', 1)[0] or 'clip'
    tag = re.sub(r'[^0-9A-Za-z_-]', '_', src if src.upper().startswith('BV') else tag)[:40] or 'clip'
    tmp = _TMP
    os.makedirs(tmp, exist_ok=True)
    info = {'target': args.target, 'model': args.model, 'device': args.device, 'compute': args.compute}

    try:
        if src.lower().startswith('http') or src.upper().startswith('BV'):
            print('[asr] 下载音频…', file=sys.stderr)
            try:
                src = fetch_audio(to_url(args.target), tmp, tag)
            except Exception as e:
                info['error'] = 'yt-dlp 失败：' + str(e)[:200]
                print(json.dumps(info, ensure_ascii=False) if args.json else info['error'])
                return 5
        if not os.path.exists(src):
            info['error'] = '找不到文件：' + src
            print(json.dumps(info, ensure_ascii=False) if args.json else info['error'])
            return 2
        info['audio_bytes'] = os.path.getsize(src)

        try:
            from faster_whisper import WhisperModel
        except Exception as e:
            info['error'] = '缺少 faster-whisper：' + str(e)[:150]
            print(json.dumps(info, ensure_ascii=False) if args.json else info['error'])
            return 4

        print('[asr] 加载模型 %s（%s/%s）…' % (args.model, args.device, args.compute), file=sys.stderr)
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute)
        print('[asr] 转写中…', file=sys.stderr)
        segments, meta = model.transcribe(
            src,
            language=None if args.lang == 'auto' else args.lang,
            vad_filter=True,          # ⭐ 掐掉静音段：省时间也少出错
        )
        if args.max_seconds and getattr(meta, 'duration', 0) > args.max_seconds:
            info['error'] = '视频太长（%d 秒 > %d 秒）' % (meta.duration, args.max_seconds)
            print(json.dumps(info, ensure_ascii=False) if args.json else info['error'])
            return 3
        parts = []
        for seg in segments:
            parts.append(seg.text)
        text = ''.join(parts).strip()
        info.update({
            'text': text,
            'chars': len(text),
            'duration': round(getattr(meta, 'duration', 0) or 0, 1),
            'language': getattr(meta, 'language', None),
            'elapsed': round(time.time() - t0, 1),
        })
    finally:
        # ⭐ 临时音频不留在磁盘上
        for f in glob.glob(os.path.join(tmp, tag + '.*')):
            try:
                os.remove(f)
            except Exception:
                pass

    if args.json:
        print(json.dumps(info, ensure_ascii=False))
    elif args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(text)
        print('[asr] 已写入：' + args.out, file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
