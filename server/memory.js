/**
 * Memoria persistente por sesión. Sin IA: solo I/O de JSON.
 * Permite que el agente recuerde hechos duraderos (preferencias, contexto del proyecto,
 * decisiones) entre turnos e incluso entre reinicios del servidor.
 */
import path from 'path';
import fs from 'fs';

const MEMORY_DIR = path.join(process.cwd(), 'runtime', 'memory');
const MAX_FACTS = 40;
const MAX_FACT_LEN = 500;

function ensureDir() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

/** Sanitiza el id de sesión para usarlo como nombre de archivo. */
function safeId(sessionId) {
  const s = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return s || 'default';
}

function memoryPath(sessionId) {
  return path.join(MEMORY_DIR, `${safeId(sessionId)}.json`);
}

export function loadMemory(sessionId) {
  ensureDir();
  try {
    const raw = fs.readFileSync(memoryPath(sessionId), 'utf8');
    const data = JSON.parse(raw);
    return {
      facts: Array.isArray(data.facts) ? data.facts : [],
      updatedAt: data.updatedAt || null,
    };
  } catch {
    return { facts: [], updatedAt: null };
  }
}

function saveMemory(sessionId, mem) {
  ensureDir();
  fs.writeFileSync(memoryPath(sessionId), JSON.stringify(mem, null, 2), 'utf8');
}

/** Añade un hecho duradero. Dedupe case-insensitive y FIFO con tope MAX_FACTS. */
export function addFact(sessionId, fact) {
  const text = String(fact || '').trim().slice(0, MAX_FACT_LEN);
  if (!text) throw new Error('fact vacío');
  const mem = loadMemory(sessionId);
  const exists = mem.facts.some((f) => f.toLowerCase() === text.toLowerCase());
  if (!exists) {
    mem.facts.push(text);
    if (mem.facts.length > MAX_FACTS) mem.facts = mem.facts.slice(-MAX_FACTS);
  }
  mem.updatedAt = new Date().toISOString();
  saveMemory(sessionId, mem);
  return mem;
}

/** Elimina un hecho por índice (0-based). Devuelve la memoria actualizada. */
export function removeFact(sessionId, index) {
  const mem = loadMemory(sessionId);
  if (Number.isInteger(index) && index >= 0 && index < mem.facts.length) {
    mem.facts.splice(index, 1);
    mem.updatedAt = new Date().toISOString();
    saveMemory(sessionId, mem);
  }
  return mem;
}

export function clearMemory(sessionId) {
  const mem = { facts: [], updatedAt: new Date().toISOString() };
  saveMemory(sessionId, mem);
  return mem;
}

/** Texto inyectable en el system prompt; vacío si no hay memoria. */
export function memoryPromptBlock(sessionId) {
  const { facts } = loadMemory(sessionId);
  if (!facts.length) return '';
  const lines = facts.map((f) => `- ${f}`).join('\n');
  return `\n\nMemoria persistente (hechos recordados de esta y anteriores conversaciones; tenlos en cuenta y no preguntes lo que ya sabes):\n${lines}`;
}
