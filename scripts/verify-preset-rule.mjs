// 校验 preset YAML 可解析，检查 27 条是否生效，并同步回仓库源
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

const HOME = os.homedir();
const src = path.join(HOME, '.dsh', '.agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
const repo = 'D:/dsh/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml';

for (const f of [src, repo]) {
  if (!fs.existsSync(f)) { console.log('缺少文件:', f); continue; }
  try {
    const doc = yaml.load(fs.readFileSync(f, 'utf8'));
    const persona = (Array.isArray(doc) ? doc : []).find((e) => e?.id === 'persona');
    const prefix = persona?.config?.prefix ?? '';
    const has27 = /27\.\s*【@我/.test(prefix);
    const has267 = /27\.7/.test(prefix);
    const orderOk = prefix.indexOf('26. 【偷图收藏') < prefix.indexOf('27. 【@我');
    console.log(`[OK] ${f}`);
    console.log(`     YAML 可解析 ✅  条目数=${Array.isArray(doc) ? doc.length : '?'}`);
    console.log(`     prefix 长度=${prefix.length}`);
    console.log(`     含 27 条=${has27}  含 27.7=${has267}  26 在 27 前=${orderOk}`);
  } catch (e) {
    console.log(`[失败] ${f}\n     YAML 解析错误: ${e.message}`);
  }
}

// 同步到仓库源
fs.copyFileSync(src, repo);
console.log('\n已把安装版同步回仓库源:', repo);
