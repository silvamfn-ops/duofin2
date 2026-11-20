# DuoFin 2.0 — Gestão Financeira a Dois (Multiplataforma & Tempo Real)

Aplicação web progressiva (PWA) construída de raiz com **arquitetura modular ES Modules**, **base de dados relacional normalizada no Supabase**, **sincronização em tempo real (WebSockets)** para 2 telemóveis e 2 computadores, e **fila offline (Outbox)**.

## Estrutura do Repositório
- `index.html`: Interface limpa com Content Security Policy (CSP) estrita.
- `css/styles.css`: Design responsivo adaptado a iPhone, Android e Windows.
- `js/config.js`: Utilitários de formatação, sanitização XSS e calculadora inline.
- `js/db.js`: Persistência local, fila de sincronização offline (`Outbox`) e conversor de backups do DuoFin v6.9.0.
- `js/supabase-sync.js`: Ligação Supabase Realtime + resolução de conflitos por timestamp (`updated_at`) + soft-delete.
- `js/finance-engine.js`: Motor de ciclos por vencimento, *Burn Rate* diário, projeção de fecho e gestão de cartões de crédito sem dupla contagem.
- `js/importers.js`: Extrator de extratos bancários PDF e CSV com aprendizagem de regras.
- `js/charts.js`: Gráficos em Canvas de alta resolução.
- `js/security.js`: Bloqueio por PIN (SHA-256), Biometria WebAuthn e Modo Privacidade.
- `supabase/schema.sql`: Script SQL completo para criar tabelas, índices, RLS e funções RPC.

## Guia Rápido de Instalação
1. **Supabase**: Cria um novo projeto, abre o *SQL Editor* e executa `supabase/schema.sql`.
2. **GitHub Pages**: Faz upload desta pasta para um novo repositório `duofin2` e ativa o GitHub Pages na branch `main`.
3. **4 Dispositivos**: Abre o link HTTPS no teu telemóvel, cria conta, cria o orçamento e gera o código de convite para o segundo telemóvel. Nos 2 computadores basta iniciar sessão com as mesmas contas.
4. **Ícones**: Copia a pasta `icons/` do teu repositório anterior para a raiz de `duofin2`.
