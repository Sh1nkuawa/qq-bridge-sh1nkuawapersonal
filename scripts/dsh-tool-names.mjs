// Read-only inventory of tool registrations in the installed DSH packages.
// DSH_TOOL_PACKAGES can point at a staged release before the live upgrade.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export function collectDshToolNames() {
  const roots = new Set();
  const addRoot = (dir) => { if (dir && fs.existsSync(dir)) roots.add(path.resolve(dir)); };
  if (process.env.DSH_TOOL_PACKAGES) addRoot(process.env.DSH_TOOL_PACKAGES);
  else {
    try {
      const pkg = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json');
      addRoot(path.join(path.dirname(pkg), 'node_modules', '@deepseek-ai'));
      addRoot(path.dirname(path.dirname(pkg)));
    } catch {}
    for (const bin of (process.env.PATH ?? '').split(path.delimiter)) {
      const dir = path.join(bin, 'node_modules', '@deepseek-ai');
      if (fs.existsSync(path.join(dir, 'dsh', 'package.json'))) {
        addRoot(dir);
        addRoot(path.join(dir, 'dsh', 'node_modules', '@deepseek-ai'));
      }
    }
  }
  const home = process.env.DSH_HOME || (process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.dsh'));
  const plugins = home && path.join(home, 'plugins');
  const sources = new Map();
  const visited = new Set();
  let scanned = 0;
  const add = (name, file) => {
    if (!/^[a-z][a-z0-9_-]{1,60}$/.test(name)) return;
    if (!sources.has(name)) sources.set(name, new Set());
    sources.get(name).add(file);
  };
  function walk(dir) {
    const actual = fs.realpathSync(dir);
    if (visited.has(actual)) return;
    visited.add(actual);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'types'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.(?:m?js|cjs|ya?ml)$/.test(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      scanned++;
      if (/\.ya?ml$/.test(file)) {
        for (const m of src.matchAll(/^\s*(?:-\s*)?toolName:\s*['"]?([a-z][a-z0-9_-]*)/gm)) add(m[1], file);
      } else {
        for (const m of src.matchAll(/defineTool\(\{[\s\S]{0,500}?\bname:\s*['"]([^'"]+)['"]/g)) add(m[1], file);
        for (const m of src.matchAll(/\btoolName:\s*['"]([^'"]+)['"]/g)) add(m[1], file);
        for (const m of src.matchAll(/\btoolName:\s*[^\n]*?\.default\(\s*['"]([^'"]+)['"]/g)) add(m[1], file);
        for (const m of src.matchAll(/defineTool\(\{[\s\S]{0,500}?\bname:\s*([A-Z_][A-Z0-9_]*)\b/g)) {
          const value = new RegExp(`\\bconst\\s+${m[1]}\\s*=\\s*['"]([^'"]+)['"]`).exec(src);
          if (value) add(value[1], file);
        }
      }
    }
  }
  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('dsh-')) walk(path.join(root, entry.name));
    }
  }
  if (plugins && fs.existsSync(plugins)) {
    for (const entry of fs.readdirSync(plugins, { withFileTypes: true })) {
      const dir = path.join(plugins, entry.name);
      if (fs.statSync(dir).isDirectory() && !/bak|backup/.test(entry.name)) walk(dir);
    }
  }
  const manifest = home && path.join(home, 'profiles', 'web', 'package.json');
  if (manifest && fs.existsSync(manifest)) {
    const deps = JSON.parse(fs.readFileSync(manifest, 'utf8')).dependencies ?? {};
    for (const name of Object.keys(deps)) {
      const dir = path.join(path.dirname(manifest), 'node_modules', name);
      if (fs.existsSync(dir)) walk(dir);
    }
  }
  return { names: new Set(sources.keys()), sources, scanned };
}

// run_code is a reserved PTC presentation transport, not a restrictable registry
// name. The QQ execution allowlist still rejects it; restrict its capabilities.
export const isHostTool = (name) => !['ask_user_question', 'todo_write', 'search', 'fetch', 'run_code'].includes(name);
