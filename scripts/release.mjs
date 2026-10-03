#!/usr/bin/env node
// One command per release: bump the version everywhere, check, commit, build the desktop
// installers, deploy web/mobile, tag.
//
//   npm run release                  # patch: 0.1.0 -> 0.1.1
//   npm run release -- minor         # 0.1.1 -> 0.2.0
//   npm run release -- major         # 0.2.0 -> 1.0.0
//   npm run release -- --no-desktop  # skip the desktop build (also --no-deploy)
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const level = ['major', 'minor', 'patch'].find((l) => args.includes(l)) ?? 'patch';
const desktop = !args.includes('--no-desktop');
const deploy = !args.includes('--no-deploy');
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const out = (cmd) => execSync(cmd).toString().trim();

if (out('git status --porcelain')) {
  console.error('Commit or stash your changes first. A release is built from a clean commit.');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const [ma, mi, pa] = pkg.version.split('.').map(Number);
const next = level === 'major' ? `${ma + 1}.0.0` : level === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
console.log(`\n== Release ${pkg.version} -> ${next}\n`);

// The version lives in four files. Change only the exact fields, keep the formatting.
const replaceIn = (file, re, value) => {
  const s = fs.readFileSync(file, 'utf8');
  if (!re.test(s)) throw new Error(`version field not found in ${file}`);
  fs.writeFileSync(file, s.replace(re, value));
};
replaceIn('package.json', /("version":\s*")[^"]+(")/, `$1${next}$2`);
replaceIn('package-lock.json', /^(\{\s*"name":\s*"multiplayer-canvas",\s*"version":\s*")[^"]+(")/, `$1${next}$2`);
replaceIn('package-lock.json', /("packages":\s*\{\s*"":\s*\{\s*"name":\s*"multiplayer-canvas",\s*"version":\s*")[^"]+(")/, `$1${next}$2`);
replaceIn('src-tauri/tauri.conf.json', /("version":\s*")[^"]+(")/, `$1${next}$2`);
replaceIn('src-tauri/Cargo.toml', /^(version\s*=\s*")[^"]+(")/m, `$1${next}$2`);
replaceIn('src-tauri/Cargo.lock', /(name = "draw"\nversion = ")[^"]+(")/, `$1${next}$2`);

run('npm run check');
run(`git commit -qam "Release v${next}"`);

if (desktop) run('npx tauri build --bundles rpm,appimage');
if (deploy) run('npm run deploy');
run(`git tag v${next}`);

console.log(`\n== Released v${next}`);
if (deploy) console.log('Web and mobile: https://draw.bsums.xyz (check /api/health for the version)');
if (desktop) {
  console.log('Desktop (Linux) installers:');
  console.log(`  src-tauri/target/release/bundle/rpm/Draw-${next}-1.x86_64.rpm`);
  console.log(`  src-tauri/target/release/bundle/appimage/Draw_${next}_amd64.AppImage`);
  console.log(`Install or upgrade:\n  sudo dnf upgrade ./src-tauri/target/release/bundle/rpm/Draw-${next}-1.x86_64.rpm`);
}
