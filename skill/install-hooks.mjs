#!/usr/bin/env node
// Git 提交前钩子安装器（B 层进程级硬拦截）：把小模型容易忘跑的检查直接焊进 .githooks/pre-commit
//
// 为什么必须落成 Git 钩子：
//   提示词（A 层）只能劝小模型「提交前记得跑自检」，小模型长对话一旦上下文拥挤就会忘跑或偷懒跳过。
//   挂入 .githooks/pre-commit 并设置 git config core.hooksPath .githooks 后，
//   每次执行 git commit 都会由 git 进程自动调起：
//     1. check-commit-hygiene.mjs --staged（秒级检查单轮代码量级、禁 .skip/删断言、禁 TODO/空 catch）
//     2. 项目冒烟命令与 check-escapes.mjs 核查（DoneGate 本仓直接跑 --self-check）
//   任一不过，git commit 直接非零中止，错误不会累积到下一轮。
//
// 用法：
//   node skill/install-hooks.mjs [--root <项目根>]     为目标项目生成 .githooks/pre-commit 并激活 core.hooksPath
//   node skill/install-hooks.mjs --red-self-test       在临时 git 仓实测：脏/作弊 commit 被 git 真拦截，干净 commit 放行
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join, resolve, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DG_ROOT = resolve(HERE, '..');

export function resolveSkillPrefix(projectRoot, dgRoot = DG_ROOT, pathApi = path) {
  const normProject = pathApi.resolve(projectRoot);
  const normDg = pathApi.resolve(dgRoot);
  const dgSkill = pathApi.join(normDg, 'skill');
  const isWin = pathApi.sep === '\\';
  const sameRoot = isWin
    ? normProject.toLowerCase() === normDg.toLowerCase()
    : normProject === normDg;
  if (sameRoot) return 'skill';
  // 任何外部项目（含 Windows 跨盘符如 C: 临时目录指向 D: DoneGate 仓，以及 DoneGate 的父目录）
  // 一律写入绝对正斜杠路径，杜绝跨盘符误退化或大小写差异导致本仓误写本机绝对路径。
  return dgSkill.replace(/\\/g, '/');
}

export function buildPreCommitScript(projectRoot, dgRoot = DG_ROOT, pathApi = path) {
  const skillPrefix = resolveSkillPrefix(projectRoot, dgRoot, pathApi);

  return [
    '#!/bin/sh',
    '# DoneGate 自动提交前守门钩子（防小模型超量提交、改测试凑绿、留空壳代码或漏跑自检）',
    'set -e',
    `DG_SKILL="${skillPrefix}"`,
    'node "$DG_SKILL/check-commit-hygiene.mjs" --staged --root .',
    'if [ -f "skill/check-escapes.mjs" ] && [ -f "escapes.jsonl" ]; then',
    '  node "skill/check-escapes.mjs" --self-check --project .',
    'elif [ -f "INTENT.md" ]; then',
    '  node "$DG_SKILL/check-escapes.mjs" --project .',
    'fi',
    ''
  ].join('\n');
}

export function installGitHooks(projectRoot) {
  const hooksDir = join(projectRoot, '.githooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-commit');
  writeFileSync(hookPath, buildPreCommitScript(projectRoot), 'utf8');
  try { chmodSync(hookPath, 0o755); } catch { /* win32 noop */ }

  let activated = false;
  const inside = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (inside.status === 0 && (inside.stdout || '').trim() === 'true') {
    const cfg = spawnSync('git', ['-C', projectRoot, 'config', 'core.hooksPath', '.githooks'], { encoding: 'utf8' });
    activated = cfg.status === 0;
  }
  return { hookPath, activated };
}

function runRedSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'dg-hook-test-'));
  let bad = 0;
  const check = (label, cond, detail = '') => {
    console.log('  ' + (cond ? '✓' : '✗') + ' ' + label + (!cond && detail ? ' → ' + detail : ''));
    if (!cond) bad++;
  };
  try {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, '.gitignore'), '.donegate/\n');
    writeFileSync(join(tmp, 'src/a.mjs'), 'export const a = 1;\n');
    spawnSync('git', ['-C', tmp, 'init', '-q']);
    spawnSync('git', ['-C', tmp, 'config', 'user.email', 'h@local']);
    spawnSync('git', ['-C', tmp, 'config', 'user.name', 'H']);
    spawnSync('git', ['-C', tmp, 'add', '.']);
    spawnSync('git', ['-C', tmp, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);

    const mockWinDg = win32.join('D:', 'skills', 'DoneGate');
    const expectedWinSkill = win32.join(mockWinDg, 'skill').replace(/\\/g, '/');
    const crossDriveHook = buildPreCommitScript(win32.join('C:', 'Temp', 'dg-hook-x'), mockWinDg, win32);
    const parentDrivePrefix = resolveSkillPrefix(win32.join('D:'), mockWinDg, win32);
    const winCaseDiffSelf = resolveSkillPrefix(win32.join('d:', 'skills', 'donegate'), mockWinDg, win32);
    check(
      'Windows 跨盘符/父目录写绝对正斜杠路径且本仓盘符大小写差异仍用相对 skill',
      crossDriveHook.includes(`DG_SKILL="${expectedWinSkill}"`) &&
        parentDrivePrefix === expectedWinSkill &&
        winCaseDiffSelf === 'skill' &&
        crossDriveHook.includes('[ -f "escapes.jsonl" ]')
    );
    const inst = installGitHooks(tmp);
    check('安装 .githooks/pre-commit 并激活 git core.hooksPath', inst.activated && existsSync(inst.hookPath));

    // 负样本：小模型塞 TODO 空壳后直接 git commit → 必须被 pre-commit 钩子真拦截（status !== 0）
    writeFileSync(join(tmp, 'src/a.mjs'), 'export function a() { // TODO: 以后再写\n  return 1;\n}\n');
    spawnSync('git', ['-C', tmp, 'add', 'src/a.mjs']);
    const rBlocked = spawnSync('git', ['-C', tmp, '-c', 'commit.gpgsign=false', 'commit', '-m', 'bad slop commit'], { encoding: 'utf8' });
    check('必红样本：含 TODO 空壳代码的 git commit 被 pre-commit 钩子当场拦截', rBlocked.status !== 0 && /未完成占位符/.test((rBlocked.stderr || '') + (rBlocked.stdout || '')));

    // 修复为真实代码后重新 git commit → 必须放行（status === 0）
    writeFileSync(join(tmp, 'src/a.mjs'), 'export function a() {\n  return 2;\n}\n');
    spawnSync('git', ['-C', tmp, 'add', 'src/a.mjs']);
    const rPass = spawnSync('git', ['-C', tmp, '-c', 'commit.gpgsign=false', 'commit', '-m', 'clean small commit'], { encoding: 'utf8' });
    check('正样本：修掉空壳后的小步干净 git commit 顺畅放行', rPass.status === 0, rPass.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(bad === 0 ? '\nRESULT: PASS Git pre-commit 钩子真拦截与放行自检全过' : `\nRESULT: FAIL ${bad} 项未过`);
  return bad === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--red-self-test')) process.exit(runRedSelfTest());
  const rIdx = argv.indexOf('--root');
  const root = resolve(rIdx >= 0 && argv[rIdx + 1] ? argv[rIdx + 1] : process.cwd());
  if (!existsSync(root)) { console.error('目录不存在：' + root); process.exit(3); }
  const res = installGitHooks(root);
  console.log(`已写入钩子：${res.hookPath}（git core.hooksPath=${res.activated ? '已激活 .githooks' : '待 git init 后执行 git config core.hooksPath .githooks'}）`);
  process.exit(0);
}
