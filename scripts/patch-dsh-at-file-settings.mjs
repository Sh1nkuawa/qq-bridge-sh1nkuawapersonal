// Reproducible compatibility patch for the pinned dsh-at-file 0.7.0 git build.
import fs from 'node:fs';
import path from 'node:path';
const arg=process.argv.indexOf('--profile');
const profile=arg<0?path.join(process.env.USERPROFILE,'.dsh','profiles','web'):process.argv[arg+1];
if(!profile) throw Error('--profile requires a directory');
const dir=path.join(profile,'node_modules','dsh-at-file','lib');
const settingsMarker='// qq-bridge: DSH 0.2 settings compatibility';
const codecMarker='// qq-bridge: DSH 0.2 lazy codec factories';
const old=`function registerAtFileSettings(ctx) {\n  return ctx.settings.register(AT_FILE_NAMESPACE, AtFileSettingsSchema, { applies: "live" });\n}`;
const next=`${settingsMarker}\nfunction registerAtFileSettings(ctx) {\n  if (typeof ctx.settings.register === "function") {\n    return ctx.settings.register(AT_FILE_NAMESPACE, AtFileSettingsSchema, { applies: "live" });\n  }\n  return {\n    get: () => AtFileSettingsSchema(ctx.settings.describe().find((row) => row.ns === "dsh-at-file")?.value ?? {}),\n    update: (patch) => ctx.settings.update("dsh-at-file", patch)\n  };\n}`;
const config='var Config = Schema.object({\n  maxIndexedFiles:';
const expanded='var Config = Schema.object({\n  ...Object.fromEntries(Object.entries(AtFileSettingsSchema.dict).map(([key, schema]) => [key, schema.extra("volatile", true)])),\n  maxIndexedFiles:';
for(const name of ['index.js','client.js']) {
 const file=path.join(dir,name);
 const source=fs.readFileSync(file,'utf8');
 let output=source.replaceAll('\r\n','\n');
 if(name==='index.js' && output.includes(settingsMarker)) output=output.replace('get: () => AtFileSettingsSchema(ctx.config)', 'get: () => AtFileSettingsSchema(ctx.settings.describe().find((row) => row.ns === "dsh-at-file")?.value ?? {})');
 if(name==='index.js'&&!output.includes(settingsMarker)) {
  if(!output.includes(old)||!output.includes(config)) throw Error('Unknown settings layout; refusing to patch');
  output=output.replace(old,next).replace(config,expanded);
 }
 if(!output.includes(codecMarker)) {
  const start=output.indexOf('var AT_FILE_INVOCATIONS = [');
  const end=output.indexOf('\n];',start)+4;
  if(start<0||end<4) throw Error('Unknown invocation layout; refusing to patch');
  const adapter=`\n${codecMarker}\nfor (const invocation of AT_FILE_INVOCATIONS) {\n  for (const codec of [invocation.result, ...invocation.parameters.map((p) => p.codec)]) {\n    if (codec?.mode === "strict" && codec.schema && !codec.create) codec.create = () => codec.schema;\n  }\n}\n`;
  output=output.slice(0,end)+adapter+output.slice(end);
 }
 if(process.argv.includes('--check')) {
  if(source!==output) throw Error('dsh-at-file compatibility patch missing: '+name);
 } else if(source!==output) {
  const backup=file+'.bak-qqbridge-020';
  if(!fs.existsSync(backup)) fs.copyFileSync(file,backup);
  fs.writeFileSync(file,output);
 }
 console.log('dsh-at-file '+name+': settings and lazy codecs compatible');
}
