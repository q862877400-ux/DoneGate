// L0 判定核 · pendingRecheck 传播与影响面引擎（D01 · 零第三方依赖）。
// 用法：
//   node runner/engine.mjs --root <项目根> --changed <file1,file2> [--observation <observation.json>] [--json]
//   node runner/engine.mjs                   （无参数时提示用法并退 3，夹具见 runner/engine-fixtures.mjs）
// 退出码（§八 四值）：0 成功算出影响面；2 契约/观测 JSON 损坏或结构非法；3 根目录/观测文件读不出或参数缺失。
//
// 诚实边界（按 adr/007 降一档采信）：
//   1. 只依据静态声明的 contract.scope、contract.dependsOn、functions/*.contracts 与可选 codegraph observation.json 计算；
//      不执行代码，不捕获动态 require/反射或跨进程隐式耦合。
//   2. 严禁修改契约既有的「通过」主状态，也不得覆盖或删除历史运行证据（§11.1 + adapter-codegraph §1.4）；
//      只计算并输出 pendingRecheck / expired / 受影响业务场景，由展示层与总账现算消费。
//   3. 不负责清除 pendingRecheck（清标记只认 §11.2 证明下游输入/产物一致）。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonStrict } from '../skill/io.mjs';
import { materialFingerprintOf } from '../skill/hash.mjs';

const ENGINE_HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_REPO = resolve(ENGINE_HERE, '..');

function normRelPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function scopeMatchesFile(scopes, file) {
  const f = normRelPath(file);
  if (!f || !Array.isArray(scopes)) return false;
  return scopes.some((raw) => {
    const s = normRelPath(raw);
    if (!s) return false;
    if (s.endsWith('/')) return f.startsWith(s);
    return f === s || f.startsWith(s + '/');
  });
}

const DEFAULT_CLASSIFICATION_ROWS = [
  { order: 1, subclass: 'A4', label: '待重验', counts: false, when: { run: 'pass', pendingRecheck: true } },
  { order: 2, subclass: 'A1', label: '算数', counts: true, when: { run: 'pass', pendingRecheck: false, teeth: ['killed'] } },
  {
    order: 3,
    subclass: 'A2',
    label: '无牙',
    counts: false,
    when: {
      run: 'pass',
      pendingRecheck: false,
      teeth: ['survived', 'no-coverage', 'compile-error', 'runtime-error', 'timeout', 'red-wrong-assertion', 'hollow-assertion']
    }
  },
  { order: 4, subclass: 'A3', label: '未做实验', counts: false, when: { run: 'pass', pendingRecheck: false, teeth: null } }
];

export function classifyBySpecTable(obsState, tablePath) {
  const defaultPath = join(ENGINE_REPO, 'tools', 'classification.json');
  const targetPath = tablePath !== undefined ? tablePath : defaultPath;
  let rows = DEFAULT_CLASSIFICATION_ROWS;
  if (tablePath !== undefined || existsSync(targetPath)) {
    const res = readJsonStrict(targetPath);
    if (!res.ok || !res.value || !Array.isArray(res.value.rows)) {
      return { error: 'classification.json 不可读或损坏' };
    }
    rows = res.value.rows;
  }
  if (obsState.teeth === 'ignored') return { subclass: null, label: '已忽略', counts: false };
  if (obsState.run !== 'pass') return { subclass: null, label: obsState.run === 'fail' ? '未通过' : '无法判断', counts: false };
  for (const row of rows) {
    const w = row.when || {};
    if (w.run !== obsState.run) continue;
    if (w.pendingRecheck !== !!obsState.pendingRecheck) continue;
    if (w.teeth === undefined) return { subclass: row.subclass, label: row.label, counts: row.counts };
    if (w.teeth === null && (obsState.teeth === null || obsState.teeth === undefined)) {
      return { subclass: row.subclass, label: row.label, counts: row.counts };
    }
    if (Array.isArray(w.teeth) && w.teeth.includes(obsState.teeth)) {
      return { subclass: row.subclass, label: row.label, counts: row.counts };
    }
  }
  return { error: '出现规格 §3.4.1 未定义的状态组合：' + JSON.stringify(obsState) };
}

export function loadProjectGraph(projectRoot) {
  const contracts = [];
  const cDir = join(projectRoot, 'contracts');
  if (existsSync(cDir)) {
    for (const e of readdirSync(cDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(cDir, e.name, 'contract.json');
      if (!existsSync(p)) continue;
      const r = readJsonStrict(p);
      if (!r.ok) return { error: (r.error === 'parse' ? 'parse' : 'unreadable'), path: p };
      contracts.push(r.value);
    }
  }
  const functions = [];
  const fDir = join(projectRoot, 'functions');
  if (existsSync(fDir)) {
    for (const e of readdirSync(fDir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const p = join(fDir, e.name);
      const r = readJsonStrict(p);
      if (!r.ok) return { error: (r.error === 'parse' ? 'parse' : 'unreadable'), path: p };
      functions.push(r.value);
    }
  }
  return { contracts, functions };
}

export function propagateImpact({ contracts = [], functions = [], changedFiles = [], impactedFiles = [], existingStates = {}, materialRecords = null }) {
  const changed = changedFiles.map(normRelPath).filter(Boolean);
  const impacted = impactedFiles.map(normRelPath).filter(Boolean);
  const activeContracts = contracts.filter((c) => c && c.id && !c.retired);
  const byId = new Map(activeContracts.map((c) => [c.id, c]));

  // 反向依赖图：上游 id -> 依赖它的下游 id 列表
  const revDeps = new Map();
  for (const c of activeContracts) {
    for (const dep of (Array.isArray(c.dependsOn) ? c.dependsOn : [])) {
      if (!byId.has(dep)) continue;
      if (!revDeps.has(dep)) revDeps.set(dep, []);
      revDeps.get(dep).push(c.id);
    }
  }

  const effects = new Map(); // id -> { contractId, effect: 'expired'|'pending-recheck', reason, pendingRecheck, preservedStatus, subclass, countsInPassCount, historicalEvidencePreserved }

  // 1. 自身代码改动 → 过期（§11.1）
  const ownIds = [];
  for (const c of activeContracts) {
    if (changed.some((f) => scopeMatchesFile(c.scope, f))) {
      ownIds.push(c.id);
      const prev = existingStates[c.id] || {};
      effects.set(c.id, {
        contractId: c.id,
        effect: 'expired',
        reason: 'own-code',
        pendingRecheck: false,
        status: '过期',
        preservedStatus: prev.status || null,
        countsInPassCount: false,
        historicalEvidencePreserved: true
      });
    }
  }

  // 2. 直接依赖（1-hop）→ 过期（§11.1）
  const directDependIds = [];
  for (const id of ownIds) {
    for (const childId of (revDeps.get(id) || [])) {
      if (effects.has(childId)) continue;
      directDependIds.push(childId);
      const prev = existingStates[childId] || {};
      effects.set(childId, {
        contractId: childId,
        effect: 'expired',
        reason: 'direct-depend',
        pendingRecheck: false,
        status: '过期',
        preservedStatus: prev.status || null,
        countsInPassCount: false,
        historicalEvidencePreserved: true
      });
    }
  }

  // 3. 传递依赖（≥2-hop）+ codegraph 影响面 → pending-recheck（不改既有「通过」主状态，不计入通过数，路由至 A4）
  const queue = [...directDependIds];
  const visited = new Set([...ownIds, ...directDependIds]);
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const nextId of (revDeps.get(cur) || [])) {
      if (visited.has(nextId)) continue;
      visited.add(nextId);
      queue.push(nextId);
      if (effects.has(nextId)) continue;
      const prev = existingStates[nextId] || { status: '通过', run: 'pass', teeth: 'killed' };
      const cls = classifyBySpecTable({ run: prev.run || 'pass', pendingRecheck: true, teeth: prev.teeth ?? 'killed' });
      effects.set(nextId, {
        contractId: nextId,
        effect: 'pending-recheck',
        reason: 'transitive-depend',
        pendingRecheck: true,
        status: prev.status || '通过',
        subclass: cls.subclass || 'A4',
        countsInPassCount: Boolean(cls.counts),
        historicalEvidencePreserved: true
      });
    }
  }

  for (const c of activeContracts) {
    if (effects.has(c.id)) continue;
    if (impacted.some((f) => scopeMatchesFile(c.scope, f))) {
      const prev = existingStates[c.id] || { status: '通过', run: 'pass', teeth: 'killed' };
      const cls = classifyBySpecTable({ run: prev.run || 'pass', pendingRecheck: true, teeth: prev.teeth ?? 'killed' });
      effects.set(c.id, {
        contractId: c.id,
        effect: 'pending-recheck',
        reason: 'codegraph-impact',
        pendingRecheck: true,
        status: prev.status || '通过',
        subclass: cls.subclass || 'A4',
        countsInPassCount: Boolean(cls.counts),
        historicalEvidencePreserved: true
      });
    }
  }

  const affectedContracts = [...effects.values()];
  const affectedSet = new Set(affectedContracts.map((x) => x.contractId));
  const pendingRecheckIds = affectedContracts.filter((x) => x.pendingRecheck).map((x) => x.contractId);
  const expiredIds = affectedContracts.filter((x) => x.effect === 'expired').map((x) => x.contractId);

  const affectedScenarios = functions
    .filter((fn) => fn && Array.isArray(fn.contracts) && fn.contracts.some((cid) => affectedSet.has(cid)))
    .map((fn) => ({ id: fn.id, title: fn.title || fn.id, contracts: fn.contracts.filter((cid) => affectedSet.has(cid)) }));

  const smokeRequired = affectedContracts.length >= 2;
  const materialFingerprint = materialRecords ? materialFingerprintOf(materialRecords) : null;

  return {
    changedFiles: changed,
    impactedFiles: impacted,
    expiredIds,
    pendingRecheckIds,
    affectedContracts,
    affectedScenarios,
    smokeRequired,
    materialFingerprint
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[argv[i]] = argv[++i];
  const rootArg = opts['--root'];
  if (!rootArg) {
    console.error('用法：node runner/engine.mjs --root <项目根> [--changed a.mjs,b.mjs] [--observation observation.json] [--json]');
    process.exit(3);
  }
  const projectRoot = resolve(rootArg);
  let dirOk = false;
  try { dirOk = statSync(projectRoot).isDirectory(); } catch { dirOk = false; }
  if (!dirOk) { console.error('RESULT: 无法判断 项目根目录不存在：' + projectRoot); process.exit(3); }

  const loaded = loadProjectGraph(projectRoot);
  if (loaded.error) {
    console.error('读契约/功能失败：' + loaded.path);
    process.exit(loaded.error === 'parse' ? 2 : 3);
  }

  let changedFiles = (opts['--changed'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  let impactedFiles = [];
  const obsPath = opts['--observation'];
  if (obsPath) {
    const obsRes = readJsonStrict(resolve(obsPath));
    if (!obsRes.ok) {
      console.error('observation.json 读不出或损坏：' + obsPath);
      process.exit(obsRes.error === 'parse' ? 2 : 3);
    }
    if (Array.isArray(obsRes.value.changedFiles) && changedFiles.length === 0) changedFiles = obsRes.value.changedFiles;
    if (Array.isArray(obsRes.value.impactedFiles)) impactedFiles = obsRes.value.impactedFiles;
  }

  const result = propagateImpact({ contracts: loaded.contracts, functions: loaded.functions, changedFiles, impactedFiles });
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`expired=${result.expiredIds.length} (${result.expiredIds.join(',') || '-'}) | pendingRecheck=${result.pendingRecheckIds.length} (${result.pendingRecheckIds.join(',') || '-'}) | scenarios=${result.affectedScenarios.length} | smokeRequired=${result.smokeRequired}`);
    console.log(`RESULT: PASS 影响面计算完成（待重验 ${result.pendingRecheckIds.length} 个契约）`);
  }
  process.exit(0);
}
