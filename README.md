# DuoFin v2.2.0 — Gestão Financeira a Dois (Multiplataforma & Tempo Real)

Aplicação web progressiva (PWA) construída com **arquitetura modular ES Modules**, **base de dados relacional normalizada no Supabase**, **sincronização em tempo real (WebSockets)** para 2 telemóveis e 2 computadores, e **fila offline (Outbox)**.

---

## Estrutura do Pacote

```text
duofin2/
├── index.html                  # Interface principal com CSP estrita e calculadora inline
├── manifest.webmanifest        # Configuração PWA para instalação no ecrã principal
├── sw.js                       # Service Worker (Network-First local + fallback offline)
├── README.md                   # Guia de instalação e configuração
├── css/
│   └── styles.css              # Estilos responsivos (Temas Claro / Escuro / Automático)
├── js/
│   ├── app.js                  # Controlador principal da interface, alertas e eventos
│   ├── charts.js               # Gráficos em Canvas de alta resolução
│   ├── config.js               # Utilitários, formatação EUR, sanitização XSS e calculadora
│   ├── db.js                   # Persistência local, fila Outbox e migrador DuoFin v6.x
│   ├── finance-engine.js       # Ciclos por vencimento, Burn Rate, projeção e cartões
│   ├── importers.js            # Extrator de extratos bancários PDF/CSV com aprendizagem
│   ├── security.js             # Bloqueio por PIN (SHA-256), Biometria WebAuthn e Privacidade
│   └── supabase-sync.js        # Sincronização Realtime, sanitização de colunas e soft-delete
└── supabase/
    └── schema.sql              # Script SQL completo (tabelas, índices, RLS, RPCs e Realtime)
```

---

## Guia de Instalação Passo a Passo

### Passo 1 — Configurar a Base de Dados no Supabase
1. Acede a [supabase.com](https://supabase.com), entra no teu projeto (ou cria um novo projeto gratuito).
2. No menu lateral esquerdo, abre **SQL Editor** → **New query**.
3. Copia todo o conteúdo do ficheiro `supabase/schema.sql`, cola no editor e clica em **Run**.
   * *Nota:* Se já tinhas executado a versão anterior do `schema.sql`, podes executar este ficheiro novamente sem problemas — ele é idempotente e aplica automaticamente as atualizações de `REPLICA IDENTITY FULL` e políticas RLS.
4. No menu **Project Settings** (ícone de engrenagem) → **API**, copia e guarda:
   * **Project URL** (ex.: `https://xxxxxxxxxxxx.supabase.co`)
   * **Project API Key** (`anon` / `public`)

---

### Passo 2 — Publicar no GitHub Pages
1. Cria ou abre o repositório `duofin2` no teu GitHub.
2. Faz upload de todos os ficheiros e pastas deste ZIP para a raiz do repositório (`index.html`, `sw.js`, `manifest.webmanifest`, `css/`, `js/`, `supabase/`).
3. Copia a pasta `icons/` (`icon-180.png`, `icon-192.png`, `icon-512.png`) do teu repositório anterior para a raiz de `duofin2`.
4. No GitHub, vai a **Settings** → **Pages**:
   * Em **Source**, seleciona **Deploy from a branch**.
   * Escolhe a branch `main` e a pasta `/ (root)` e clica em **Save**.
   * Aguarda cerca de 1 minuto até ficar disponível o endereço `https://<teu-utilizador>.github.io/duofin2/`.

---

### Passo 3 — Ligar os 4 Dispositivos (2 Telemóveis + 2 Computadores)

#### No 1.º Telemóvel (Administrador):
1. Abre o link HTTPS do GitHub Pages no Safari (iPhone) ou Chrome (Android).
2. Adiciona ao ecrã principal (*Partilhar → Ecrã principal* no iPhone; *Menu ⋮ → Instalar aplicação* no Android).
3. Abre o separador **Dados** (ou **Mais → Dados & Sync**):
   * Cola o **URL do projeto Supabase** e a **Chave pública** e clica em **Guardar configuração**.
   * Introduz o teu email e palavra-passe e clica em **Criar conta** (ou **Entrar**).
   * Escreve um nome para o orçamento (ex.: `Orçamento do Casal`) e clica em **Criar orçamento partilhado**.
   * *(Opcional)* Se quiseres migrar dados antigos, importa o ficheiro `duofin-backup.json` na secção **Migrar Histórico**.
   * Clica em **Gerar convite** para obter o código de 6 caracteres (válido por 7 dias).

#### No 2.º Telemóvel (Parceiro/a):
1. Instala a aplicação a partir do mesmo link HTTPS.
2. Vai a **Mais → Dados & Sync**, configura o mesmo URL e Chave pública Supabase e cria/entra com a segunda conta de email.
3. Introduz o **Código de convite** gerado no 1.º telemóvel e clica em **Associar**.

#### Nos 2 Computadores (Windows / Mac):
1. Abre o link no Chrome ou Edge (podes instalar como app na barra de endereço).
2. Vai a **Dados**, insere o URL e Chave pública Supabase e inicia sessão com qualquer uma das duas contas já associadas ao orçamento. Os dados sincronizam automaticamente.

---

## Principais Novidades da Versão v2.2.0
* **Sincronização blindada:** Sanitização automática de campos antes de enviar para o Supabase, preservação de eliminações (*soft-delete*) e sincronização das regras de categorização aprendidas (`household_meta`).
* **Extrator PDF/CSV corrigido:** Expressões regulares revistas para reconhecer datas numéricas (`DD/MM/AAAA`, `AAAA-MM-DD`) e por extenso em português (`20 nov. 2026`).
* **Atualizações instantâneas (`sw.js`):** Estratégia *Network-First* nos ficheiros locais para que novas versões no GitHub Pages sejam aplicadas imediatamente ao abrir a app.
* **Melhorias de usabilidade:** Botão **Desfazer** ao eliminar movimentos, edição direta de objetivos e despesas recorrentes, alertas automáticos de orçamento e plafond de cartão no Resumo, submissão de PIN com a tecla `Enter`, ativação de Biometria WebAuthn e operadores matemáticos rápidos no modal de edição.
