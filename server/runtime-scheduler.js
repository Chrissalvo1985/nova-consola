/**
 * Lightweight task scheduler: JSON file + node-cron. No AI at runtime — tasks run on schedule
 * without any LLM calls, so zero token cost after creation.
 */
import path from 'path';
import fs from 'fs';
import { fork } from 'child_process';
import cron from 'node-cron';
import { randomUUID } from 'crypto';

const RUNTIME_ROOT = path.join(process.cwd(), 'runtime');
const TASKS_FILE = path.join(RUNTIME_ROOT, 'tasks.json');
const AUTOMATIONS_DIR = path.join(RUNTIME_ROOT, 'automations');
const LOGS_DIR = path.join(RUNTIME_ROOT, 'logs');
const MAX_TASKS = 10;
const MAX_SCRIPT_SIZE = 1024 * 1024; // 1MB
const jobMap = new Map(); // id -> cron.ScheduledTask

// Script content guard: no OS schedulers, no shell/subprocess, no paths outside runtime. Prevents privilege escalation and scheduler bypass via scriptContent.
const FORBIDDEN_SCRIPT_PATTERNS = [
  /\bcrontab\b/i, /\blaunchctl\b/i, /\blaunchd\b/i, /\bsystemctl\b/i, /\bschtasks\b/i,
  /child_process\.(exec|spawn)/i, /require\s*\(\s*['"]child_process['"]\s*\)/i, /import\s+.*child_process/i,
  /process\.exec\b/i, /\bbash\b/i, /sh\s+-c\b/i,
  /\.\.\//, /\/Users\//, /\/etc\//, /\/bin\//, /\/usr\//,
];
function validateScriptContent(content) {
  const s = String(content);
  for (const re of FORBIDDEN_SCRIPT_PATTERNS) {
    if (re.test(s)) throw new Error('System-level schedulers and shell execution are not allowed inside automation scripts.');
  }
}

function ensureDirs() {
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  fs.mkdirSync(AUTOMATIONS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '[]', 'utf8');
}

export function loadTasks() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(TASKS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveTasks(tasks) {
  ensureDirs();
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

/** Validate cron expression (node-cron 5-field). No extra deps. */
export function validateCron(expr) {
  if (typeof expr !== 'string' || !expr.trim()) return false;
  return cron.validate(expr.trim());
}

/** Safe script name: no ../ or absolute paths; only under automations. */
export function isSafeScriptName(scriptName) {
  if (typeof scriptName !== 'string') return false;
  const s = scriptName.trim();
  if (s.includes('..') || path.isAbsolute(s) || s.includes('/')) return false;
  return /^[a-zA-Z0-9_.-]+\.js$/.test(s);
}

/** Resolve script path; must stay inside AUTOMATIONS_DIR. */
function resolveScriptPath(scriptName) {
  const resolved = path.resolve(AUTOMATIONS_DIR, scriptName);
  const rel = path.relative(AUTOMATIONS_DIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

/** Run one task script via fork; log to runtime/logs/task-<id>.log; update lastRun. No AI. */
async function runTask(task) {
  const scriptPath = resolveScriptPath(task.script);
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    appendLog(task.id, `[ERROR] Script not found: ${task.script}\n`);
    return;
  }
  const logPath = path.join(LOGS_DIR, `task-${task.id}.log`);
  const start = new Date().toISOString();
  appendLog(task.id, `[${start}] Starting ${task.name} (${task.script})\n`);
  return new Promise((resolve) => {
    const child = fork(scriptPath, [], { cwd: AUTOMATIONS_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('exit', (code, signal) => {
      const end = new Date().toISOString();
      const result = `exitCode=${code ?? 'null'} signal=${signal ?? 'null'}\n`;
      appendLog(task.id, result + (out ? `stdout:\n${out}\n` : '') + (err ? `stderr:\n${err}\n` : '') + `[${end}] Done.\n`);
      const tasks = loadTasks();
      const t = tasks.find((x) => x.id === task.id);
      if (t) t.lastRun = end;
      saveTasks(tasks);
      resolve();
    });
    child.on('error', (e) => {
      appendLog(task.id, `[ERROR] ${e.message}\n`);
      resolve();
    });
  });
}

function appendLog(taskId, text) {
  try {
    fs.appendFileSync(path.join(LOGS_DIR, `task-${taskId}.log`), text, 'utf8');
  } catch (e) {
    console.error('[runtime-scheduler] appendLog:', e.message);
  }
}

/** Register cron job for task; stores ref for later stop. */
export function registerTask(task) {
  if (!task.enabled) return;
  const expr = typeof task.schedule === 'string' ? task.schedule.trim() : '';
  if (!validateCron(expr)) return;
  const existing = jobMap.get(task.id);
  if (existing) existing.stop();
  const job = cron.schedule(expr, () => runTask(task), { scheduled: true });
  jobMap.set(task.id, job);
}

/** Remove task and stop its cron job. */
export function removeTask(id) {
  const job = jobMap.get(id);
  if (job) {
    job.stop();
    jobMap.delete(id);
  }
  const tasks = loadTasks().filter((t) => t.id !== id);
  saveTasks(tasks);
}

/** Toggle enabled; (un)register cron accordingly. */
export function toggleTask(id, enabled) {
  const tasks = loadTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t) return false;
  t.enabled = !!enabled;
  saveTasks(tasks);
  if (enabled) registerTask(t);
  else {
    const job = jobMap.get(id);
    if (job) {
      job.stop();
      jobMap.delete(id);
    }
  }
  return true;
}

/** Create task from create_task tool: validate, write script, add task, register. Scripts must be pure Node (no shell/subprocess, no paths outside runtime). */
export function createTask(name, schedule, scriptName, scriptContent) {
  if (loadTasks().length >= MAX_TASKS) throw new Error('MAX_TASKS (10) reached');
  if (!validateCron(schedule)) throw new Error('Invalid cron expression');
  if (!isSafeScriptName(scriptName)) throw new Error('Invalid scriptName (no ../ or absolute path)');
  if (typeof scriptContent !== 'string') throw new Error('scriptContent required');
  if (Buffer.byteLength(scriptContent, 'utf8') > MAX_SCRIPT_SIZE) throw new Error('Script exceeds 1MB');
  validateScriptContent(scriptContent); // Closes scheduler bypass: script cannot call crontab/shell/subprocess or target system paths.
  ensureDirs();
  const scriptPath = path.join(AUTOMATIONS_DIR, scriptName);
  fs.writeFileSync(scriptPath, scriptContent, 'utf8');
  const task = {
    id: randomUUID(),
    name: String(name).trim() || scriptName,
    schedule: schedule.trim(),
    script: scriptName,
    enabled: true,
    lastRun: null,
  };
  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
  registerTask(task);
  return task;
}

/** On server startup: ensure dirs, load tasks, register enabled. No AI. */
export function initRuntime() {
  ensureDirs();
  const tasks = loadTasks();
  jobMap.clear();
  for (const task of tasks) {
    if (task.enabled) registerTask(task);
  }
  console.log('[runtime] Scheduler loaded', tasks.length, 'tasks');
}
