'use strict';
/* Sacada — servidor local. Sem dependências: Node 18 ou superior.
   Serve a página (public/), guarda textos e resultados (data/) e fala com a OpenRouter.
   A chave da API fica só aqui, lida do .env; o navegador nunca a recebe. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

/* ---------- .env ---------- */
(function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const MODEL = (process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash').trim();
const BASE_URL = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const N_PERGUNTAS = Math.min(15, Math.max(5, Number(process.env.QUIZ_PERGUNTAS) || 10));

/* ---------- armazenamento em JSON ---------- */
const DATA = path.join(ROOT, 'data');
const F_TEXTOS = path.join(DATA, 'textos.json');
const F_RESULT = path.join(DATA, 'resultados.json');
fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(F_TEXTOS)) fs.copyFileSync(path.join(ROOT, 'seed', 'textos.json'), F_TEXTOS);
if (!fs.existsSync(F_RESULT)) fs.writeFileSync(F_RESULT, '[]');

const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJSON(f, v) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
  fs.renameSync(tmp, f);
}

/* ---------- utilidades ---------- */
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
const countWords = s => s.trim().split(/\s+/).filter(Boolean).length;
const cleanBody = s => String(s || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function parseModelJSON(content) {
  let s = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(s); } catch (e) { /* tenta recortar */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* cai no erro abaixo */ } }
  throw httpErr(502, 'O modelo respondeu em um formato inesperado. Tente de novo ou troque o OPENROUTER_MODEL no .env.');
}

/* ---------- OpenRouter ---------- */
async function chat(messages, temperature) {
  if (!API_KEY) throw httpErr(400, 'A chave da OpenRouter não está configurada. Preencha OPENROUTER_API_KEY no arquivo .env e reinicie o servidor.');
  const call = async jsonMode => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    try {
      const body = { model: MODEL, messages, temperature };
      if (jsonMode) body.response_format = { type: 'json_object' };
      const res = await fetch(BASE_URL + '/chat/completions', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:' + PORT, 'X-Title': 'Sacada Leitura Rapida' },
        body: JSON.stringify(body)
      });
      const raw = await res.text();
      let data = null; try { data = JSON.parse(raw); } catch (e) { /* resposta não-JSON */ }
      return { res, data, raw };
    } catch (e) {
      throw httpErr(502, e.name === 'AbortError' ? 'A OpenRouter demorou demais para responder. Tente de novo.' : 'Não foi possível conectar à OpenRouter. Verifique a conexão com a internet.');
    } finally { clearTimeout(timer); }
  };
  let r = await call(true);
  if (r.res.status === 400) r = await call(false); // alguns modelos não aceitam response_format
  if (!r.res.ok) {
    const detail = (r.data && r.data.error && r.data.error.message) || r.raw.slice(0, 200);
    const map = { 401: 'A OpenRouter recusou a chave. Confira OPENROUTER_API_KEY no .env.', 402: 'Créditos insuficientes na conta da OpenRouter.', 404: 'Modelo "' + MODEL + '" não encontrado na OpenRouter. Confira OPENROUTER_MODEL no .env.', 429: 'Limite de requisições da OpenRouter atingido. Aguarde um pouco e tente de novo.' };
    throw httpErr(502, (map[r.res.status] || 'A OpenRouter retornou erro ' + r.res.status + '.') + (detail ? ' Detalhe: ' + detail : ''));
  }
  const content = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
  if (!content) throw httpErr(502, 'A OpenRouter respondeu sem conteúdo. Tente de novo.');
  return parseModelJSON(content);
}

const SYSTEM = 'Você é um especialista em avaliação de leitura e escreve em português do Brasil. Responda somente com JSON válido, sem texto fora do JSON.';

function validQuestions(obj) {
  const list = Array.isArray(obj && obj.perguntas) ? obj.perguntas : [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p.pergunta !== 'string' || !Array.isArray(p.opcoes) || p.opcoes.length !== 4) continue;
    const ops = p.opcoes.map(o => String(o).trim());
    const c = Number(p.correta);
    if (ops.some(o => !o) || new Set(ops.map(o => o.toLowerCase())).size !== 4 || !Number.isInteger(c) || c < 0 || c > 3) continue;
    // embaralha no servidor: modelos tendem a repetir a posição da resposta certa
    const order = shuffle([0, 1, 2, 3]);
    out.push({ q: p.pergunta.trim(), o: order.map(i => ops[i]), a: order.indexOf(c), tipo: p.tipo === 'inferencia' ? 'inferencia' : 'literal' });
  }
  return out;
}

async function generateQuiz(title, body) {
  const prompt = `Crie ${N_PERGUNTAS} perguntas de múltipla escolha para medir a compreensão de quem acabou de ler o texto abaixo uma única vez, sem poder consultá-lo.

Regras:
- Cada pergunta tem exatamente 4 alternativas e uma única correta.
- A resposta precisa estar no texto ou decorrer diretamente dele. Não cobre conhecimento externo.
- Cerca de 60% das perguntas sobre informações explícitas ("literal") e 40% sobre ideia principal, relações de causa e conclusões ("inferencia").
- Distribua as perguntas pelo começo, meio e fim do texto. Não repita o mesmo ponto em duas perguntas.
- Alternativas erradas plausíveis, do mesmo tipo e tamanho parecido com a correta. Não use "todas as anteriores" nem "nenhuma das anteriores".
- Evite detalhes irrelevantes que ninguém guardaria numa leitura normal.
- Não copie na pergunta a frase do texto que contém a resposta.

Formato da resposta:
{"perguntas":[{"pergunta":"...","opcoes":["...","...","...","..."],"correta":0,"tipo":"literal"}]}
"correta" é o índice (0 a 3) da alternativa certa. "tipo" é "literal" ou "inferencia".

Título: ${title}

Texto:
"""
${body}
"""`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const qs = validQuestions(await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], 0.4));
    if (qs.length >= 5) return qs;
  }
  throw httpErr(502, 'O modelo não devolveu perguntas válidas suficientes. Tente de novo ou troque o OPENROUTER_MODEL no .env.');
}

const TIPOS = { informativo: 'texto informativo de divulgação, com fatos e explicações', narrativo: 'narrativa de ficção curta, com personagens, lugares e acontecimentos concretos', tecnico: 'texto técnico-expositivo, com conceitos definidos e relações entre eles', opinativo: 'artigo de opinião, com uma tese clara e argumentos' };
const NIVEIS = { facil: 'vocabulário comum e frases curtas', medio: 'vocabulário de jornal, frases de tamanho variado', denso: 'vocabulário formal, frases longas e alta densidade de informação, como em livros acadêmicos e provas de concurso' };

async function generateText({ tema, tipo, palavras, nivel }, existingTitles) {
  const prompt = `Escreva um texto original para um teste de velocidade e compreensão de leitura.

- Tema: ${tema}
- Gênero: ${TIPOS[tipo]}
- Tamanho: cerca de ${palavras} palavras (entre ${Math.round(palavras * 0.9)} e ${Math.round(palavras * 1.1)})
- Dificuldade: ${NIVEIS[nivel]}
- Texto corrido em parágrafos, separados por uma linha em branco. Sem subtítulos, listas, markdown ou notas.
- Inclua informações específicas e verificáveis dentro do próprio texto (nomes, quantidades, sequências, causas), para permitir perguntas de compreensão.
- Em textos não ficcionais, use apenas fatos bem estabelecidos. Não invente números, datas ou citações.
- Escolha um recorte diferente destes títulos já existentes: ${existingTitles.length ? existingTitles.map(t => '"' + t + '"').join(', ') : '(nenhum)'}.

Formato da resposta:
{"titulo":"título curto, sem ponto final","texto":"parágrafo 1\\n\\nparágrafo 2"}`;
  const r = await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], 0.9);
  const title = String(r.titulo || '').trim().slice(0, 120), body = cleanBody(r.texto);
  if (!title || countWords(body) < 80) throw httpErr(502, 'O modelo devolveu um texto curto demais ou sem título. Tente de novo.');
  return { title, body };
}

/* ---------- HTTP ---------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(httpErr(413, 'Conteúdo grande demais (limite de 1 MB).')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(httpErr(400, 'JSON inválido.')); } });
    req.on('error', reject);
  });
}
const newId = () => 't' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
function checkText(title, body) {
  if (!title) throw httpErr(400, 'Informe um título.');
  const n = countWords(body);
  if (n < 80) throw httpErr(400, 'O texto precisa de pelo menos 80 palavras (tem ' + n + ').');
  if (n > 6000) throw httpErr(400, 'O texto passa de 6.000 palavras. Divida-o em partes.');
}

async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/status' && m === 'GET') return send(res, 200, { configured: !!API_KEY, model: MODEL, perguntas: N_PERGUNTAS });

  if (p === '/api/resultados') {
    if (m === 'GET') return send(res, 200, readJSON(F_RESULT));
    if (m === 'POST') { const r = await readBody(req); if (!r || typeof r.ex !== 'string') throw httpErr(400, 'Resultado inválido.'); const all = readJSON(F_RESULT); all.push(r); writeJSON(F_RESULT, all); return send(res, 201, { ok: true }); }
    if (m === 'DELETE') { writeJSON(F_RESULT, []); return send(res, 200, { ok: true }); }
  }

  if (p === '/api/textos' && m === 'GET') return send(res, 200, readJSON(F_TEXTOS));

  if (p === '/api/textos' && m === 'POST') { // cadastro manual
    const b = await readBody(req);
    const title = String(b.title || '').trim().slice(0, 120), body = cleanBody(b.body);
    checkText(title, body);
    const t = { id: newId(), title, body, qs: null, source: 'manual', createdAt: Date.now() };
    let warning = null;
    if (b.quiz) { try { t.qs = await generateQuiz(title, body); t.model = MODEL; } catch (e) { warning = 'Texto salvo, mas o questionário falhou: ' + e.message; } }
    const all = readJSON(F_TEXTOS); all.push(t); writeJSON(F_TEXTOS, all);
    return send(res, 201, { text: t, warning });
  }

  if (p === '/api/textos/gerar' && m === 'POST') { // texto inédito + questionário
    const b = await readBody(req);
    const tema = String(b.tema || '').trim().slice(0, 200);
    if (!tema) throw httpErr(400, 'Informe um tema.');
    const tipo = TIPOS[b.tipo] ? b.tipo : 'informativo', nivel = NIVEIS[b.nivel] ? b.nivel : 'medio';
    const palavras = Math.min(1500, Math.max(200, Number(b.palavras) || 400));
    const g = await generateText({ tema, tipo, palavras, nivel }, readJSON(F_TEXTOS).map(t => t.title));
    const qs = await generateQuiz(g.title, g.body);
    const t = { id: newId(), title: g.title, body: g.body, qs, source: 'ia', meta: { tema, tipo, nivel }, model: MODEL, createdAt: Date.now() };
    const all = readJSON(F_TEXTOS); all.push(t); writeJSON(F_TEXTOS, all);
    return send(res, 201, { text: t });
  }

  const mt = p.match(/^\/api\/textos\/([\w-]+)(\/questionario)?$/);
  if (mt) {
    const all = readJSON(F_TEXTOS), i = all.findIndex(t => t.id === mt[1]);
    if (i < 0) throw httpErr(404, 'Texto não encontrado.');
    if (mt[2] && m === 'POST') { all[i].qs = await generateQuiz(all[i].title, all[i].body); all[i].model = MODEL; const fresh = readJSON(F_TEXTOS), j = fresh.findIndex(t => t.id === mt[1]); if (j < 0) throw httpErr(404, 'Texto não encontrado.'); fresh[j] = all[i]; writeJSON(F_TEXTOS, fresh); return send(res, 200, { text: all[i] }); }
    if (!mt[2] && m === 'DELETE') { all.splice(i, 1); writeJSON(F_TEXTOS, all); return send(res, 200, { ok: true }); }
  }
  throw httpErr(404, 'Rota não encontrada.');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PUBLIC = path.join(ROOT, 'public');
function serveStatic(req, res, url) {
  let rel; try { rel = decodeURIComponent(url.pathname); } catch (e) { rel = '/'; }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(e => { if (!e.status) console.error(e); send(res, e.status || 500, { error: e.status ? e.message : 'Erro interno no servidor. Veja o terminal.' }); });
  } else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
  else { res.writeHead(405); res.end(); }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error('A porta ' + PORT + ' já está em uso. Mude PORT no .env ou feche o outro programa.');
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('Sacada rodando em http://localhost:' + PORT);
  console.log(API_KEY ? 'OpenRouter configurada. Modelo: ' + MODEL : 'OPENROUTER_API_KEY vazia no .env: geração de textos e questionários desativada.');
});
