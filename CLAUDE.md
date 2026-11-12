# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Sacada" is a local speed-reading trainer (UI, prompts, error messages and docs are in Brazilian Portuguese — keep new user-facing text in pt-BR). A zero-dependency Node server serves a single-page app, stores data in JSON files, and calls OpenRouter to generate texts and comprehension quizzes.

## Commands

- `npm start` — run the server (`node server.js`), default http://localhost:3000 (binds to 127.0.0.1 only)
- `npm run dev` — same with `node --watch` auto-restart
- Requires Node >= 18 (uses global `fetch`). There is no `npm install` step, no build, no linter and no test suite.
- `docker build -t sacada . && docker run -p 3000:3000 -v sacada-data:/app/data -e MASTER_PASSWORD=... sacada` — the image sets `HOST=0.0.0.0`, runs as `node`, and declares `/app/data` as a volume. The Dockerfile copies only `package.json`, `server.js`, `public/` and `seed/`, so new top-level files need a `COPY` line.
- `data/resultados.json`, `data/.auth-secret` and `.env` are gitignored. `data/textos.json` is still tracked.

Config comes from `.env` (see `.env.example`): `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default `google/gemini-2.5-flash`), `QUIZ_PERGUNTAS` (clamped 5–15), `PORT`, `HOST` (default `127.0.0.1`; `0.0.0.0` in containers), `MASTER_PASSWORD`, plus undocumented `OPENROUTER_BASE_URL`. `server.js` has its own tiny `.env` parser; real environment variables take precedence. Without an API key the app still works with existing texts; only AI generation is disabled. Restart after editing `.env` (`--watch` does not watch it).

## Architecture

Two source files:

- `server.js` — plain `http` server. `/api/*` goes to the `api()` router (manual `if` matching on pathname/method); everything else is static from `public/` with a path-traversal guard. Errors are thrown via `httpErr(status, msg)` and the message is returned to the browser as `{error}`, so messages must be user-readable; errors without a status become a generic 500 and are logged.
- `public/index.html` — the whole frontend (HTML, CSS, JS inline, no framework). Hash routing: each `<section class="view" id="v-<name>">` is a view (`#inicio`, shown as "Dashboard" and reached from the top-right button; `#fundamentos` is its own page, linked only from the card at the bottom of the Dashboard and absent from `#nav`; `#teste`, `#guia`, `#rsvp`, `#schulte`, `#flash`, `#periferia`, `#busca`, `#biblioteca`, `#historico`), switched by `route()`. Helpers `$`/`$$` are querySelector shortcuts; each exercise keeps state in a one-letter global object (`G` guia, `R` rsvp, `S` schulte, `F` flash, `P` periferia, `B` busca, `TS` teste, `LB` biblioteca) with prefix-named functions (`gdTick`, `rsLoad`, `scStart`…). `localStorage` (`sacada_*` keys) is only used for UI prefs like the theme. Styling follows a shadcn/ui-like token system defined on `:root`, with dark overrides under `:root[data-theme="dark"]`: `--bg/--surface/--soft/--ink/--muted/--line/--input`, `--primary` for buttons, `--accent` for data and highlights, `--mark` for the reading highlighter, plus radius and shadow tokens. Use these tokens instead of hard-coded colors. The interface uses Geist and Geist Mono, and reading text stays in Literata (`--read`).

### Treinos tab

`#treino` has 4 modules, and each one builds a 20-row table client-side: `TR_ROWS`, `trSpec(mod, lvl)` returns `{cols, row()}`. Module 1 levels come from `TR_WORDS`, bucketed automatically by character count (`TR_M1` ranges). Module 2 mixes small, medium and large words (`TR_SM/MD/LG`) with random numbers. Module 4 sorts the 2-word `TR_PAIRS` by length and splits them into 10 equal slices. To add words, append them to the lists; the code assigns the level. `trFit()` sizes the font so all 20 rows fit the viewport height and the widest item fits its column, measured with a canvas. It runs on open, level change and resize. The metronome (`MT`) schedules Web Audio clicks ahead of time. Starting the stopwatch also starts the metronome, but the metronome can run alone. `trFinish()` stops both and logs `{ex:'treino', mod, lvl, time, bpm}`. It runs on "Encerrar", on level or module change and when leaving the tab, and only saves sessions of at least 1 s. The "Como treinar" modal is a native `<dialog id="tr-help">`, opened by any `[data-tr-help]` button and automatically the first time a module is opened (flag `sacada_tr_help` in localStorage).

### Data

- `data/textos.json` — text library, copied from `seed/textos.json` on first run if missing. Text shape: `{id, title, body, qs, source: 'manual'|'ia'|seed, meta?, model?, createdAt}`. `body` uses blank lines between paragraphs.
- Quiz questions are stored in compact form `{q, o: [4 options], a: correctIndex, tipo: 'literal'|'inferencia'}`. The model returns `{pergunta, opcoes, correta, tipo}`; `validQuestions()` validates, converts, and shuffles option order server-side (models tend to repeat the correct position). Each text holds ~`QUIZ_PERGUNTAS` questions; the client samples 5 per test and reshuffles.
- `data/resultados.json` — append-only array of results posted by the client via `logResult(ex, data)`; `ex` is the exercise name (e.g. `teste` with `{ppm, comp, text}`, `schulte` with `{n, time}`). The dashboard baseline and the "inédito/já testado" marking derive from `ex === 'teste'` entries. The Histórico "Evolução" cards are driven by the `EVO` table in `index.html`, which sets each exercise's metric, whether lower is better, and the `group` setting that has to match for sessions to be compared. Adding fields to a `logResult` call needs a matching update there and in `summary()`.
- Writes go through `writeJSON()` (write `.tmp` then rename). Files are re-read on every request; there is no in-memory cache.

### OpenRouter integration

`chat()` requests `response_format: json_object`, retrying without it on HTTP 400 (some models reject it), maps common status codes to pt-BR messages, and parses via `parseModelJSON()` (strips code fences, falls back to slicing `{…}`). `generateQuiz()` retries once if fewer than 5 valid questions come back. `generateText()` passes existing titles to avoid repeats; the genre/difficulty options are the `TIPOS`/`NIVEIS` maps. The API key never leaves the server — `/api/status` only exposes `configured`, model and question count.

### Auth

Enabled only when `MASTER_PASSWORD` is set. `POST /api/login {senha}` returns a stateless token `exp36.hmac` signed with a key derived from `data/.auth-secret` (random, created on first run, gitignored) plus the password, so changing either invalidates all tokens. Every `/api/*` route except `GET /api/auth` and `POST /api/login` sits behind the gate in `api()`; failures return 401 with `auth: true`. Client side, the token lives in `localStorage` (`sacada_auth`), `api()` sends it as `Authorization: Bearer` and calls `logout()` on an `auth` 401. `body.locked` hides the app and shows `#login`, and the token is re-checked on every hash change. Login failures are rate-limited in memory per IP, using `X-Forwarded-For` behind Traefik.

### API

`GET /api/auth` · `POST /api/login` · `GET /api/status` · `GET|POST /api/textos` · `DELETE /api/textos/:id` · `POST /api/textos/gerar` `{tema, tipo, palavras, nivel}` · `POST /api/textos/:id/questionario` (regenerate quiz) · `GET|POST|DELETE /api/resultados`. Text limits: 80–6000 words, request body 1 MB.
