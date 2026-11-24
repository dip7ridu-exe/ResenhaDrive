# ResenhaDrive 🎬

Um site para ver os **filmes, séries, vídeos e fotos do seu Google Drive** de um jeito organizado, tipo streaming.
Você entra, clica em **Conectar Google Drive** e pronto: o site monta a biblioteca sozinho e toca tudo
**na qualidade original do arquivo**, com avanço/retrocesso rápido, legendas e "Continuar assistindo".

- 100% estático: funciona no **GitHub Pages**, sem servidor.
- Acesso **somente leitura** ao Drive. Os arquivos vão direto do Google para o seu navegador.
- Funciona no PC e no celular (dá para "Adicionar à tela inicial").

---

## 1. Subir no GitHub (5 min)

1. Crie um repositório novo no GitHub, por exemplo `ResenhaDrive`.
2. Envie **todos os arquivos desta pasta** para a raiz do repositório
   (`index.html`, `app.js`, `library.js`, `sw.js`, `styles.css`, `config.js`, `manifest.webmanifest`, `icon.svg`).
3. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   escolha a branch `main` e a pasta `/ (root)` e salve.
4. Em 1–2 minutos o site fica em `https://SEU-USUARIO.github.io/ResenhaDrive/`.

> Se abrir o site agora, ele mostra "Quase lá!" — falta só o passo 2.
> Para ver como fica antes de configurar, abra `.../ResenhaDrive/?demo`.

## 2. Criar a chave de login do Google (10 min, uma vez só)

1. Acesse **https://console.cloud.google.com/** e crie um projeto (ex.: "ResenhaDrive").
2. Menu **APIs e serviços → Biblioteca** → procure **Google Drive API** → **Ativar**.
3. Menu **Google Auth Platform** (ou "Tela de permissão OAuth"):
   - **Branding / Informações do app**: nome do app (ex.: ResenhaDrive) e seu e-mail.
   - **Público-alvo (Audience)**: tipo **Externo**. Deixe em **Teste** e, em **Usuários de teste**,
     adicione o seu e-mail do Google (e de quem mais for usar — até 100 pessoas).
   - **Acesso a dados (Data Access)**: adicione o escopo
     `https://www.googleapis.com/auth/drive.readonly`.
4. **Clientes (Clients) → Criar cliente**:
   - Tipo: **Aplicativo da Web**.
   - **Origens JavaScript autorizadas**: `https://SEU-USUARIO.github.io`
     (só isso: sem `/ResenhaDrive`, sem barra no final).
   - Não precisa de "URIs de redirecionamento".
5. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`).
6. Abra o `config.js` no GitHub (ícone de lápis), cole no lugar de `COLE_AQUI_SEU_CLIENT_ID...` e salve (Commit).

Pronto! Abra o site e clique em **Conectar Google Drive**.

> **"O Google não verificou este app"**: é normal, porque o app é seu e está em modo Teste.
> Clique em **Avançado → Acessar ResenhaDrive (não seguro)** e permita a leitura do Drive.
> Só aparece na primeira vez.

## 3. Como organizar o Drive (recomendado)

O site entende vários jeitos de organizar, mas este é o que dá o melhor resultado:

```
📁 Mídia                      ← escolha esta pasta no primeiro acesso
 ├ 📁 Filmes
 │   ├ 📁 Interestelar (2014)
 │   │   ├ Interstellar.2014.1080p.mp4
 │   │   ├ Interstellar.2014.1080p.srt     ← legenda (mesmo nome do vídeo)
 │   │   └ poster.jpg                      ← capa (opcional)
 │   └ Matrix.1999.1080p.mp4               ← também funciona solto
 ├ 📁 Séries
 │   └ 📁 Breaking Bad
 │       ├ poster.jpg  /  fanart.jpg       ← capa e fundo (opcionais)
 │       ├ 📁 Temporada 1
 │       │   ├ Breaking.Bad.S01E01.mp4
 │       │   └ Episódio 2.mp4
 │       └ 📁 Temporada 2 …
 ├ 📁 Vídeos                               ← vídeos pessoais, por pasta
 └ 📁 Fotos
     ├ 📁 Praia 2024                       ← cada pasta vira um álbum
     └ 📁 Aniversário
```

Regras que o site usa:

| O que | Como ele reconhece |
|---|---|
| **Série** | nome com `S01E02`, `1x02` ou `T01E02`; ou dentro de pasta `Temporada 1` / `Season 1`; ou dentro de uma pasta `Séries`, `Animes`, `Novelas`, `Desenhos`, `Doramas` |
| **Filme** | dentro de uma pasta `Filmes`/`Movies`, ou qualquer vídeo com mais de 50 min (ajustável nas Configurações) |
| **Vídeo** | todo o resto |
| **Foto** | qualquer imagem; o álbum é a pasta onde ela está |
| **Capa** | `poster.jpg`, `capa.jpg`, `cover.jpg` ou `folder.jpg` na pasta do filme/série |
| **Fundo** | `fanart.jpg`, `backdrop.jpg` ou `fundo.jpg` |
| **Legenda** | `.srt` ou `.vtt` com o mesmo nome do vídeo (ex.: `Filme.pt-BR.srt`) |

Nomes "sujos" de download (`Filme.2014.1080p.BluRay.x264.mkv`) são limpos automaticamente.

### Capas automáticas (opcional)

Crie uma conta grátis em **themoviedb.org → Configurações → API**, copie a **API Key (v3)**
e cole em **Configurações (⚙️) → Chave do TMDB** no site. Ele busca capa, fundo, nota e sinopse em português.
Só os títulos são enviados ao TMDB.

## 4. Qualidade e formatos

- O player direto toca o **arquivo original** (sem recompressão). Se o vídeo é 4K, você vê 4K.
- **MP4 (H.264 + AAC)** toca em qualquer navegador e celular. **WebM** também.
- **MKV** toca no Chrome/Edge quando o vídeo é H.264. **H.265/HEVC, AVI, WMV** dependem do aparelho.
  Quando o navegador não consegue, o site troca sozinho para o **Player do Drive**
  (que converte o vídeo, até 1080p). Você também pode alternar no botão do topo do player.
- Dica: para converter um MKV/HEVC para MP4 compatível sem perder qualidade visível, use o HandBrake
  (preset "Fast 1080p30" ou "HQ 1080p30 Surround").

## 5. Bom saber

- **Sessão de 1 hora**: o Google dá um acesso que dura 1 hora e o site renova sozinho.
  Se o navegador bloquear a renovação, aparece **"Reconectar"** — um clique e o vídeo continua de onde parou.
- O "Player do Drive" precisa que você esteja logado no Google naquele navegador.
- Limite do Google: arquivos muito assistidos podem ter download limitado por algumas horas (erro 403).
- O progresso ("Continuar assistindo") fica salvo no navegador de cada aparelho.
- Atalhos no PC: **espaço** pausa, **← →** volta/avança 10s, **F** tela cheia, **N** próximo episódio, **Esc** sai.
- Depois de mudar arquivos no Drive, use **⚙️ → Atualizar biblioteca** (o site também atualiza sozinho ao abrir).

## 6. Testar no computador (opcional)

```bash
python -m http.server 8080
```

Abra `http://localhost:8080` e adicione `http://localhost:8080` às **Origens JavaScript autorizadas** no Google Cloud.

## Como funciona (técnico)

- Login: Google Identity Services (token OAuth no navegador, escopo `drive.readonly`).
- Listagem: Google Drive API v3 (`files.list`), classificação em `library.js`.
- Streaming: o `sw.js` (Service Worker) intercepta `./stream/<id>`, chama
  `files.get?alt=media` com o token e repassa o cabeçalho `Range` — por isso dá para avançar o vídeo
  sem baixar tudo, direto do Google, na qualidade original.
