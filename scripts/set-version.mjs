#!/usr/bin/env node
// Writes one version into every file that holds it. CI calls this before each build:
//   node scripts/set-version.mjs 0.2.17
// Only the exact version fields change; formatting stays as it is.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIELDS = [
  ['package.json', /("version":\s*")[^"]+(")/],
  ['package-lock.json', /^(\{\s*"name":\s*"multiplayer-canvas",\s*"version":\s*")[^"]+(")/],
  ['package-lock.json', /("packages":\s*\{\s*"":\s*\{\s*"name":\s*"multiplayer-canvas",\s*"version":\s*")[^"]+(")/],
  ['src-tauri/tauri.conf.json', /("version":\s*")[^"]+(")/],
  ['src-tauri/Cargo.toml', /^(version\s*=\s*")[^"]+(")/m],
  ['src-tauri/Cargo.lock', /(name = "draw"\r?\nversion = ")[^"]+(")/],
];

export function setVersion(version, root = '.') {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
  for (const [file, re] of FIELDS) {
    const path = `${root}/${file}`;
    const s = fs.readFileSync(path, 'utf8');
    if (!re.test(s)) throw new Error(`version field not found in ${file}`);
    fs.writeFileSync(path, s.replace(re, `$1${version}$2`));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setVersion(process.argv[2]);
  console.log(`version set to ${process.argv[2]}`);
}
