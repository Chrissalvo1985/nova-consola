import { useState, useRef, useEffect } from 'react'
import Markdown from './Markdown.jsx'
import './App.css'

const STORAGE_KEY = 'consola_sessions'
const MAX_HISTORY_ENTRIES = 200
const COLLAPSE_OUTPUT_CHARS = 280

const SUGGESTIONS = [
  { icon: '🛰', label: 'Diagnóstico del sistema', text: 'Dame un diagnóstico rápido: CPU, memoria y los 5 procesos que más consumen.' },
  { icon: '🌐', label: 'Red y puertos', text: 'Lista los puertos en escucha y a qué proceso pertenece cada uno.' },
  { icon: '🧹', label: 'Automatizar limpieza', text: 'Crea una tarea que cada día a las 9:00 resuma el espacio en disco.' },
  { icon: '📦', label: 'Estado del proyecto', text: 'Resume el estado de este proyecto: git status, ramas y últimos commits.' },
]

function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function saveSessions(sessions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
  } catch (e) {
    console.error('Failed to save sessions', e)
  }
}

function generateId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function relativeTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'ahora'
  if (m < 60) return `hace ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.floor(h / 24)
  return `hace ${d} d`
}

function Avatar({ kind }) {
  if (kind === 'user') return <div className="avatar avatar-user">Tú</div>
  return (
    <div className="avatar avatar-agent" aria-hidden>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
        <path d="M12 3 L19 7.2 V15.6 L12 19.8 L5 15.6 V7.2 Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx="12" cy="11.4" r="2.4" fill="currentColor" />
      </svg>
    </div>
  )
}

function App() {
  const [sessions, setSessions] = useState(loadSessions)
  const [activeId, setActiveId] = useState(() => {
    const ids = Object.keys(loadSessions())
    return ids.length ? ids[0] : null
  })
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [streamingCommand, setStreamingCommand] = useState(null)
  const [streamingOutput, setStreamingOutput] = useState('')
  const [models, setModels] = useState({ openai: [], ollama: [] })
  const [selectedModel, setSelectedModel] = useState('gpt-5.6-luna')
  const [expandedOutputs, setExpandedOutputs] = useState(() => new Set())
  const [tasks, setTasks] = useState([])
  const [memoryFacts, setMemoryFacts] = useState([])
  const [showPanel, setShowPanel] = useState(true)
  const [copied, setCopied] = useState(null)
  const [sudoPrompt, setSudoPrompt] = useState(null) // { command, install, sessionId }
  const [sudoPassword, setSudoPassword] = useState('')
  const [pendingDangerous, setPendingDangerous] = useState(null) // { command, sessionId }
  const endRef = useRef(null)
  const inputRef = useRef(null)
  const textareaRef = useRef(null)
  const streamingOutputRef = useRef('')
  const abortControllerRef = useRef(null)

  const activeSession = activeId ? sessions[activeId] : null
  const entries = activeSession?.entries ?? []

  useEffect(() => {
    saveSessions(sessions)
  }, [sessions])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries, streamingOutput, loading])

  useEffect(() => {
    fetch('/api/models')
      .then((r) => (r.ok ? r.json() : { openai: [], ollama: [] }))
      .then((data) => setModels(data))
      .catch(() => setModels({ openai: [], ollama: [] }))
  }, [])

  const refreshTasks = () => {
    fetch('/api/tasks')
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setTasks(Array.isArray(data) ? data : []))
      .catch(() => {})
  }

  const refreshMemory = (sid) => {
    if (!sid) return setMemoryFacts([])
    fetch(`/api/memory?sessionId=${encodeURIComponent(sid)}`)
      .then((r) => (r.ok ? r.json() : { facts: [] }))
      .then((data) => setMemoryFacts(Array.isArray(data.facts) ? data.facts : []))
      .catch(() => {})
  }

  useEffect(() => {
    refreshTasks()
  }, [])

  useEffect(() => {
    refreshMemory(activeId)
  }, [activeId])

  const toggleTask = (id, enabled) => {
    fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
      .then(() => refreshTasks())
      .catch(() => {})
  }

  const removeTask = (id) => {
    fetch(`/api/tasks/${id}`, { method: 'DELETE' })
      .then(() => refreshTasks())
      .catch(() => {})
  }

  const removeMemoryFact = (index) => {
    if (!activeId) return
    fetch(`/api/memory?sessionId=${encodeURIComponent(activeId)}&index=${index}`, { method: 'DELETE' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setMemoryFacts(Array.isArray(data.facts) ? data.facts : [])
      })
      .catch(() => {})
  }

  const ensureSession = () => {
    if (activeId && sessions[activeId]) return activeId
    const id = generateId()
    const newSession = {
      id,
      name: `Sesión ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`,
      createdAt: Date.now(),
      entries: [],
    }
    setSessions((s) => ({ ...s, [id]: newSession }))
    setActiveId(id)
    return id
  }

  const addEntry = (type, content, preferredSessionId = null) => {
    const id = preferredSessionId ?? activeId ?? ensureSession()
    setSessions((s) => {
      const session = s[id] || { id, name: 'Nueva', createdAt: Date.now(), entries: [] }
      const nextEntries = [...session.entries, { type, content, ts: Date.now() }].slice(-MAX_HISTORY_ENTRIES)
      return { ...s, [id]: { ...session, entries: nextEntries } }
    })
    if (!activeId) setActiveId(id)
  }

  const autoGrow = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  const runChat = async ({
    text,
    sessionId: forcedSessionId = null,
    addUserEntry = true,
    confirmedSudoCommand = null,
    sudoPassword: sudoPwd = null,
    confirmedCommand = null,
  }) => {
    const trimmed = (text || '').trim()
    if (!trimmed || loading) return
    setError(null)
    const sessionId = forcedSessionId || activeId || ensureSession()
    if (addUserEntry) addEntry('user', trimmed, sessionId)
    setLoading(true)
    const ac = new AbortController()
    abortControllerRef.current = ac
    const MAX_HISTORY_SENT = 40
    const MAX_CONTENT_LEN = 10000
    const truncate = (s) =>
      typeof s !== 'string' ? String(s) : s.length <= MAX_CONTENT_LEN ? s : s.slice(-MAX_CONTENT_LEN) + '\n[...]'
    const histSource = sessions[sessionId]?.entries ?? activeSession?.entries ?? []
    const historyForApi = histSource
      .slice(-MAX_HISTORY_SENT)
      .map((e) => ({ type: e.type, content: truncate(e.content) }))
    if (addUserEntry) historyForApi.push({ type: 'user', content: truncate(trimmed) })

    const body = { message: trimmed, history: historyForApi, model: selectedModel, sessionId }
    if (confirmedSudoCommand && sudoPwd) {
      body.confirmedSudoCommand = confirmedSudoCommand
      body.sudoPassword = sudoPwd
    }
    if (confirmedCommand) body.confirmedCommand = confirmedCommand

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        addEntry('output', `Error: ${data.error || res.statusText}`, sessionId)
        setError(data.error || res.statusText)
        return
      }
      if (!res.body) {
        addEntry('output', 'Error: no response body', sessionId)
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamDone = false
      const processEvent = (payload) => {
        try {
          const ev = JSON.parse(payload)
          if (ev.type === 'command_start') {
            streamingOutputRef.current = ''
            setStreamingCommand(ev.command)
            setStreamingOutput('')
            addEntry('command', ev.command, sessionId)
          } else if (ev.type === 'command_chunk') {
            const chunk = ev.chunk ?? ''
            streamingOutputRef.current += chunk
            setStreamingOutput(streamingOutputRef.current)
          } else if (ev.type === 'command_end') {
            const full = streamingOutputRef.current || '(sin salida)'
            addEntry('output', full, sessionId)
            streamingOutputRef.current = ''
            setStreamingCommand(null)
            setStreamingOutput('')
          } else if (ev.type === 'response') {
            const respText = ev.text != null ? String(ev.text) : ''
            if (respText) addEntry(ev.system ? 'system' : 'assistant', respText, sessionId)
          } else if (ev.type === 'tasks_updated') {
            refreshTasks()
          } else if (ev.type === 'memory_updated') {
            refreshMemory(sessionId)
          } else if (ev.type === 'sudo_required') {
            setSudoPrompt({ command: ev.command, install: !!ev.install, sessionId })
            setSudoPassword('')
          } else if (ev.type === 'dangerous_command') {
            setPendingDangerous({ command: ev.command, sessionId })
            addEntry('system', `Comando destructivo pendiente de confirmación: \`${ev.command}\``, sessionId)
          } else if (ev.type === 'error') {
            addEntry('output', `Error: ${ev.message ?? 'Error desconocido'}`, sessionId)
            setError(ev.message)
          } else if (ev.type === 'done') {
            streamDone = true
          }
        } catch (_) {}
      }
      while (!streamDone) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const dataMatch = part.match(/^data:\s*(.+)/s)
          if (dataMatch) processEvent(dataMatch[1].trim())
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        addEntry('system', 'Cancelado por el usuario.', sessionId)
      } else {
        addEntry('output', `Error de red: ${err.message}`, sessionId)
        setError(err.message)
      }
    } finally {
      abortControllerRef.current = null
      setLoading(false)
      setStreamingCommand(null)
      setStreamingOutput('')
      textareaRef.current?.focus()
    }
  }

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    requestAnimationFrame(autoGrow)
    await runChat({ text, addUserEntry: true })
  }

  const submitSudo = async () => {
    if (!sudoPrompt || !sudoPassword || loading) return
    const { command, sessionId } = sudoPrompt
    const pwd = sudoPassword
    setSudoPrompt(null)
    setSudoPassword('')
    addEntry('system', `Clave sudo recibida. Reintentando: \`${command}\``, sessionId)
    await runChat({
      text: `Continúa y ejecuta este comando con la clave sudo que ya aporté (no la pidas de nuevo): ${command}`,
      sessionId,
      addUserEntry: false,
      confirmedSudoCommand: command,
      sudoPassword: pwd,
    })
  }

  const cancelSudo = () => {
    if (sudoPrompt) addEntry('system', 'Solicitud de sudo cancelada.', sudoPrompt.sessionId)
    setSudoPrompt(null)
    setSudoPassword('')
  }

  const confirmDangerous = async () => {
    if (!pendingDangerous || loading) return
    const { command, sessionId } = pendingDangerous
    setPendingDangerous(null)
    await runChat({
      text: `Confirmado. Ejecuta exactamente: ${command}`,
      sessionId,
      addUserEntry: false,
      confirmedCommand: command,
    })
  }

  const cancelDangerous = () => {
    if (pendingDangerous) addEntry('system', 'Comando destructivo cancelado.', pendingDangerous.sessionId)
    setPendingDangerous(null)
  }

  const stopBot = () => {
    abortControllerRef.current?.abort()
  }

  const createSession = () => {
    const id = generateId()
    const newSession = {
      id,
      name: `Sesión ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`,
      createdAt: Date.now(),
      entries: [],
    }
    setSessions((s) => ({ ...s, [id]: newSession }))
    setActiveId(id)
  }

  const deleteSession = (id) => {
    setSessions((s) => {
      const next = { ...s }
      delete next[id]
      return next
    })
    if (activeId === id) {
      const remaining = Object.keys(sessions).filter((k) => k !== id)
      setActiveId(remaining[0] || null)
    }
  }

  const toggleOutput = (key) => {
    setExpandedOutputs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const copyText = (text, key) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400)
    })
  }

  const useSuggestion = (text) => {
    setInput(text)
    requestAnimationFrame(() => {
      autoGrow()
      textareaRef.current?.focus()
    })
  }

  const onInputKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const sessionList = Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt)
  const lastMessage = (s) => {
    const e = s.entries?.[s.entries.length - 1]
    if (!e) return 'Sin mensajes'
    const t = typeof e.content === 'string' ? e.content : ''
    return t.length > 38 ? `${t.slice(0, 38)}…` : t || '…'
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
              <path d="M12 3 L19 7.2 V15.6 L12 19.8 L5 15.6 V7.2 Z" stroke="url(#bg)" strokeWidth="1.7" strokeLinejoin="round" />
              <circle cx="12" cy="11.4" r="2.6" fill="url(#bg)" />
              <defs>
                <linearGradient id="bg" x1="4" y1="3" x2="20" y2="20" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#7c5cff" />
                  <stop offset="0.5" stopColor="#4f9dff" />
                  <stop offset="1" stopColor="#36e0c0" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <div className="brand-text">
            <span className="brand-name">Nova</span>
            <span className="brand-sub">consola agéntica</span>
          </div>
        </div>

        <button type="button" className="btn-primary" onClick={createSession}>
          <span className="plus">+</span> Nueva conversación
        </button>

        <div className="sidebar-label">Sesiones</div>
        <ul className="session-list">
          {sessionList.map((s) => (
            <li key={s.id} className={`session-card ${activeId === s.id ? 'active' : ''}`}>
              <button type="button" onClick={() => setActiveId(s.id)} className="session-card-btn">
                <span className="session-card-title">{s.name}</span>
                <span className="session-card-preview">{lastMessage(s)}</span>
                <span className="session-card-time">{relativeTime(s.createdAt)}</span>
              </button>
              <button
                type="button"
                className="btn-icon session-del"
                onClick={() => deleteSession(s.id)}
                title="Eliminar sesión"
                aria-label="Eliminar"
              >
                ×
              </button>
            </li>
          ))}
          {sessionList.length === 0 && <p className="sidebar-hint">Crea tu primera conversación para empezar.</p>}
        </ul>

        <div className="sidebar-footer">
          <span className="status-dot" /> Agente conectado
        </div>
      </aside>

      <main className="console-panel">
        <header className="console-header">
          <div className="header-left">
            <span className="session-name">{activeSession?.name ?? 'Nueva conversación'}</span>
            <span className="header-sub">{entries.length} mensajes</span>
          </div>
          <div className="header-right">
            <label className="model-select-wrap" title="Modelo del agente">
              <span className="model-dot" />
              <select
                className="model-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                aria-label="Modelo del agente"
              >
                <optgroup label="OpenAI (agente)">
                  <option value="gpt-5.6-luna">gpt-5.6-luna</option>
                </optgroup>
                {(() => {
                  const list = Array.isArray(models.ollama) ? models.ollama : []
                  const norm = list.map((m) => (typeof m === 'string' ? { name: m, supportsTools: true } : m))
                  const agentic = norm.filter((m) => m.supportsTools)
                  const chatOnly = norm.filter((m) => !m.supportsTools)
                  return (
                    <>
                      {agentic.length > 0 && (
                        <optgroup label="Ollama (agente · tools)">
                          {agentic.map((m) => (
                            <option key={m.name} value={m.name}>{m.name}</option>
                          ))}
                        </optgroup>
                      )}
                      {chatOnly.length > 0 && (
                        <optgroup label="Ollama (solo chat · sin tools)">
                          {chatOnly.map((m) => (
                            <option key={m.name} value={m.name}>{m.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </>
                  )
                })()}
              </select>
            </label>
            <button
              type="button"
              className={`btn-ghost ${showPanel ? 'active' : ''}`}
              onClick={() => setShowPanel((v) => !v)}
              title="Memoria y tareas del agente"
            >
              {showPanel ? 'Panel ✦' : 'Panel'}
            </button>
          </div>
        </header>

        <div className="console-output">
          {entries.length === 0 && !loading && (
            <div className="welcome">
              <div className="welcome-glow" aria-hidden />
              <h1 className="welcome-title">¿En qué trabajamos hoy?</h1>
              <p className="welcome-sub">
                Soy tu agente de consola. Converso contigo, ejecuto comandos reales, automatizo tareas y recuerdo lo importante.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s.label} type="button" className="suggestion" onClick={() => useSuggestion(s.text)}>
                    <span className="suggestion-icon" aria-hidden>{s.icon}</span>
                    <span className="suggestion-label">{s.label}</span>
                    <span className="suggestion-text">{s.text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {entries.map((e, i) => {
            const lineKey = `out-${e.ts}-${i}`
            const isLongOutput = e.type === 'output' && String(e.content).length > COLLAPSE_OUTPUT_CHARS
            const isExpanded = expandedOutputs.has(lineKey)

            if (e.type === 'user' || e.type === 'assistant') {
              return (
                <div key={`${e.ts}-${i}`} className={`msg msg-${e.type}`}>
                  <Avatar kind={e.type} />
                  <div className={`bubble ${e.type === 'assistant' ? 'bubble-md' : ''}`}>
                    {e.type === 'assistant' ? <Markdown text={e.content} /> : e.content}
                  </div>
                </div>
              )
            }

            if (e.type === 'system') {
              return (
                <div key={`${e.ts}-${i}`} className="callout">
                  <span className="callout-icon" aria-hidden>⚠</span>
                  <div className="callout-body"><Markdown text={e.content} /></div>
                </div>
              )
            }

            if (e.type === 'command') {
              return (
                <div key={`${e.ts}-${i}`} className="codecard codecard-cmd">
                  <div className="codecard-head">
                    <span className="codecard-dots" aria-hidden>
                      <i /><i /><i />
                    </span>
                    <span className="codecard-title">comando</span>
                    <button
                      type="button"
                      className="codecard-copy"
                      onClick={() => copyText(String(e.content), lineKey)}
                    >
                      {copied === lineKey ? 'copiado' : 'copiar'}
                    </button>
                  </div>
                  <pre className="codecard-body">
                    <span className="cmd-prompt">$</span> {e.content}
                  </pre>
                </div>
              )
            }

            // output
            return (
              <div key={`${e.ts}-${i}`} className="codecard codecard-out">
                <div className="codecard-head">
                  <span className="codecard-title">salida</span>
                  <button
                    type="button"
                    className="codecard-copy"
                    onClick={() => copyText(String(e.content), `cp-${lineKey}`)}
                  >
                    {copied === `cp-${lineKey}` ? 'copiado' : 'copiar'}
                  </button>
                </div>
                <pre className="codecard-body out-body">
                  {isLongOutput && !isExpanded ? `${String(e.content).slice(0, COLLAPSE_OUTPUT_CHARS)}…` : e.content}
                </pre>
                {isLongOutput && (
                  <button type="button" className="codecard-more" onClick={() => toggleOutput(lineKey)}>
                    {isExpanded ? '− Ocultar' : '+ Ver salida completa'}
                  </button>
                )}
              </div>
            )
          })}

          {(streamingCommand !== null || streamingOutput) && (
            <div className="codecard codecard-out streaming">
              <div className="codecard-head">
                <span className="codecard-title">ejecutando</span>
                <span className="run-indicator" aria-hidden>
                  <i /><i /><i />
                </span>
              </div>
              <pre className="codecard-body out-body">
                {streamingOutput}
                <span className="cursor blink" aria-hidden>▌</span>
              </pre>
            </div>
          )}

          {loading && !streamingOutput && streamingCommand === null && (
            <div className="msg msg-assistant">
              <Avatar kind="assistant" />
              <div className="bubble thinking">
                <span className="dot" /><span className="dot" /><span className="dot" />
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {error && <div className="error-banner">⚠ {error}</div>}

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            sendMessage()
          }}
        >
          <div className="composer-inner">
            <textarea
              ref={textareaRef}
              rows={1}
              className="composer-input"
              placeholder="Escribe una instrucción o conversa con el agente…  (Enter para enviar, Shift+Enter para salto de línea)"
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                autoGrow()
              }}
              onKeyDown={onInputKeyDown}
              disabled={loading}
              autoComplete="off"
            />
            {loading ? (
              <button type="button" className="btn-stop" onClick={stopBot} title="Detener">
                ◼ Detener
              </button>
            ) : (
              <button type="submit" className="btn-send" disabled={!input.trim()} title="Enviar">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                  <path d="M4 12 L20 4 L13 20 L11 13 Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </form>
      </main>

      {showPanel && (
        <aside className="agent-panel">
          <section className="panel-section">
            <h3 className="panel-title">
              <span className="panel-title-text">
                <span className="panel-glyph">🧠</span> Memoria
              </span>
              <span className="panel-count">{memoryFacts.length}</span>
            </h3>
            {memoryFacts.length === 0 ? (
              <p className="panel-empty">
                Sin recuerdos aún. El agente guarda aquí lo importante (preferencias, rutas, objetivos) de forma automática.
              </p>
            ) : (
              <ul className="panel-list">
                {memoryFacts.map((fact, i) => (
                  <li key={`${i}-${fact.slice(0, 12)}`} className="memory-item">
                    <span className="memory-text">{fact}</span>
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={() => removeMemoryFact(i)}
                      title="Olvidar"
                      aria-label="Olvidar"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel-section">
            <h3 className="panel-title">
              <span className="panel-title-text">
                <span className="panel-glyph">⏱</span> Automatizaciones
              </span>
              <span className="panel-count">{tasks.length}</span>
            </h3>
            {tasks.length === 0 ? (
              <p className="panel-empty">
                Aún sin tareas. Pide algo como «cada día a las 9 resume los procesos» y aparecerá aquí.
              </p>
            ) : (
              <ul className="panel-list">
                {tasks.map((t) => (
                  <li key={t.id} className={`task-item ${t.enabled ? '' : 'disabled'}`}>
                    <div className="task-main">
                      <span className="task-name">{t.name}</span>
                      <span className="task-meta">
                        <code className="task-cron">{t.schedule}</code>
                        <span className="task-script">{t.script}</span>
                      </span>
                      {t.lastRun && (
                        <span className="task-lastrun">último: {new Date(t.lastRun).toLocaleString('es')}</span>
                      )}
                    </div>
                    <div className="task-actions">
                      <button
                        type="button"
                        className={`btn-toggle ${t.enabled ? 'on' : ''}`}
                        onClick={() => toggleTask(t.id, !t.enabled)}
                        title={t.enabled ? 'Pausar' : 'Activar'}
                      >
                        <span className="toggle-knob" />
                      </button>
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => removeTask(t.id)}
                        title="Eliminar tarea"
                        aria-label="Eliminar tarea"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      )}

      {sudoPrompt && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sudo-title">
          <form
            className="modal sudo-modal"
            onSubmit={(e) => {
              e.preventDefault()
              submitSudo()
            }}
          >
            <div className="modal-icon" aria-hidden>🔐</div>
            <h2 id="sudo-title" className="modal-title">
              {sudoPrompt.install ? 'Instalación privilegiada' : 'Se requiere clave sudo'}
            </h2>
            <p className="modal-sub">
              El agente necesita privilegios de administrador para ejecutar este comando. La clave no se guarda ni se muestra en el historial.
            </p>
            <pre className="modal-cmd"><span className="cmd-prompt">$</span> {sudoPrompt.command}</pre>
            <label className="modal-label" htmlFor="sudo-pass">Contraseña de administrador</label>
            <input
              id="sudo-pass"
              type="password"
              className="modal-input"
              value={sudoPassword}
              onChange={(e) => setSudoPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
              placeholder="••••••••"
            />
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={cancelSudo}>Cancelar</button>
              <button type="submit" className="btn-primary-sm" disabled={!sudoPassword || loading}>
                Autorizar y ejecutar
              </button>
            </div>
          </form>
        </div>
      )}

      {pendingDangerous && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal danger-modal">
            <div className="modal-icon" aria-hidden>☢</div>
            <h2 className="modal-title">Comando destructivo</h2>
            <p className="modal-sub">Este comando puede borrar o dañar el sistema. Confirma solo si es intencional.</p>
            <pre className="modal-cmd"><span className="cmd-prompt">$</span> {pendingDangerous.command}</pre>
            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={cancelDangerous}>Cancelar</button>
              <button type="button" className="btn-danger" onClick={confirmDangerous} disabled={loading}>
                Confirmar ejecución
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
