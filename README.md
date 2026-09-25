# Nova — Consola Agéntica

Consola controlada por un agente de IA que **conversa, ejecuta tareas reales en la terminal, automatiza con cron interno y recuerda lo importante** entre turnos y sesiones. El usuario escribe en lenguaje natural; el agente interpreta, planifica y ejecuta paso a paso.

## Qué la hace un agente (no un chat)

- **Memoria persistente por sesión** (`runtime/memory/<sessionId>.json`): el agente guarda hechos duraderos (nombre, rutas, objetivos, preferencias) con la herramienta `remember` y los reinyecta en el system prompt. No vuelve a preguntar lo que ya sabe.
- **Continuidad real**: el historial se reconstruye como turnos `user`/`assistant` con los comandos y salidas que ejecutó embebidos, así recuerda sus propias acciones.
- **Bucle agéntico multi-paso**: planifica, ejecuta varios comandos encadenados, interpreta resultados y corrige errores, con guardas anti-bucle.
- **Automatizaciones internas**: crea/lista/activa/elimina tareas cron (`create_task`, `list_tasks`, `toggle_task`, `delete_task`) que corren scripts Node sin coste de tokens. Aislado del scheduler del SO.
- **Herramientas**: `execute_command`, `create_task`, `list_tasks`, `toggle_task`, `delete_task`, `remember`.

## Cómo arrancar

```bash
npm install && cd client && npm install && cd ..
npm run dev
```

- Backend: http://localhost:3002
- Frontend: http://localhost:5173

Abre **http://localhost:5173**.

## API key

`OPENAI_API_KEY` y `PORT` en `.env` (no se sube a git). Si la clave se filtra, rótala en platform.openai.com.

## Endpoints

- `POST /api/chat` — stream SSE del agente (acepta `sessionId`).
- `GET /api/models` — modelos OpenAI + Ollama disponibles.
- `GET /api/tasks` · `PATCH /api/tasks/:id` · `DELETE /api/tasks/:id` — gestión de automatizaciones.
- `GET/POST/DELETE /api/memory` — memoria persistente por sesión.

## Estructura

- `server/index.js` — Express + OpenAI/Ollama, herramientas, SSE, guardas de seguridad.
- `server/memory.js` — memoria persistente por sesión.
- `server/runtime-scheduler.js` — scheduler cron interno (scripts en `runtime/automations`).
- `client/` — Vite + React; UI premium con chat, terminal en vivo y panel de memoria/tareas.

## Seguridad

- Blocklist de comandos peligrosos (`rm -rf`, `sudo`, `mkfs`, `dd`, fork bomb, `shutdown`/`reboot`) con confirmación explícita.
- Aislamiento total de schedulers del SO (`crontab`, `launchctl`, etc.).
- Scripts de automatización sin shell/subprocess ni rutas fuera de `runtime/`.
