# Sacada — treinador de leitura rápida

Aplicação local para medir e treinar velocidade de leitura com compreensão.
Um servidor Node sem dependências serve a página, guarda os dados em JSON e
usa a OpenRouter para escrever textos inéditos e montar os questionários.

## Como rodar

1. Abra o arquivo `.env` e preencha `OPENROUTER_API_KEY` (crie a chave em https://openrouter.ai/keys).
2. No terminal, dentro desta pasta: `npm start` (ou `node server.js`). Requer Node 18 ou superior.
3. Acesse http://localhost:3000.

Sem a chave, tudo funciona com os textos já cadastrados; só a geração por IA fica desativada.

## Variáveis de ambiente (`.env`)

| Variável | Padrão | Uso |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | vazio | Chave da OpenRouter. Lida só pelo servidor, nunca enviada ao navegador. |
| `OPENROUTER_MODEL` | `google/gemini-2.5-flash` | Modelo que escreve textos e perguntas. |
| `QUIZ_PERGUNTAS` | `10` | Tamanho do banco de perguntas por texto (5 a 15). |
| `PORT` | `3000` | Porta local. |
| `MASTER_PASSWORD` | vazio | Senha da tela de login. Vazia = acesso livre (uso local). |
| `HOST` | `127.0.0.1` | Endereço de escuta. Em Docker/Coolify use `0.0.0.0`. |

Com `MASTER_PASSWORD` definida, o navegador recebe um token assinado (válido por 30 dias) ao acertar a senha, e toda chamada à API exige esse token. Trocar a senha, ou apagar `data/.auth-secret`, desconecta todos os navegadores. Cinco senhas erradas bloqueiam o IP por 15 minutos.

Depois de editar o `.env`, reinicie o servidor.

## Como os testes evitam a decoreba

- **Textos inéditos:** na Biblioteca, informe tema, gênero, tamanho e dificuldade; a IA escreve o texto e o questionário.
- **Seus textos:** cole ou carregue um `.txt`/`.md`; a IA cria as perguntas a partir dele.
- **Banco de perguntas:** cada texto guarda cerca de 10 perguntas. Cada teste sorteia 5 e embaralha as alternativas.
- O seletor do Teste marca cada texto como inédito ou já testado e escolhe um inédito por padrão.

Textos escritos por IA podem conter erros factuais. Para o teste isso não importa: as perguntas são respondidas só com o que está no texto.

## Estrutura

- `server.js` — servidor HTTP, API e integração com a OpenRouter
- `public/index.html` — a aplicação (HTML, CSS e JS em um arquivo)
- `seed/textos.json` — os quatro textos iniciais
- `data/textos.json` — biblioteca de textos (criado na primeira execução)
- `data/resultados.json` — histórico de resultados

## API

- `GET /api/status`
- `GET /api/textos` · `POST /api/textos` `{title, body, quiz}` · `DELETE /api/textos/:id`
- `POST /api/textos/gerar` `{tema, tipo, palavras, nivel}`
- `POST /api/textos/:id/questionario`
- `GET | POST | DELETE /api/resultados`
