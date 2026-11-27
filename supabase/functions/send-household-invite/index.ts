// supabase/functions/send-household-invite/index.ts
// Edge Function da DuoFin 2 (v2.9.1) para enviar convites automaticamente por email.
// Suporta:
//   1. Resend API (recomendado — basta definir o secret RESEND_API_KEY no Supabase; envia para contas novas e existentes)
//   2. Fallback nativo Supabase Auth Admin (`inviteUserByEmail`) caso RESEND_API_KEY não esteja definido

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const resendApiKey = (Deno.env.get('RESEND_API_KEY') ?? '').trim();
    const resendFrom = (Deno.env.get('RESEND_FROM_EMAIL') ?? 'DuoFin 2 <onboarding@resend.dev>').trim();

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: 'Variáveis SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY em falta na Edge Function.' }, 500);
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) {
      return jsonResponse({ error: 'Cabeçalho Authorization em falta.' }, 401);
    }

    // Validar o utilizador que fez o pedido
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return jsonResponse({ error: 'Sessão inválida ou expirada.' }, 401);
    }

    const payload = await req.json();
    const householdId = String(payload.householdId ?? '').trim();
    const targetEmail = String(payload.email ?? '').trim().toLowerCase();
    const targetRole = payload.role === 'admin' ? 'admin' : 'member';
    const appUrl = String(payload.appUrl ?? '').trim();

    if (!householdId || !targetEmail || !targetEmail.includes('@')) {
      return jsonResponse({ error: 'Indica um householdId e um email de destino válido.' }, 400);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Confirmar se o autor do pedido é Administrador do orçamento
    const { data: memberRow, error: memErr } = await adminClient
      .from('household_members')
      .select('role')
      .eq('household_id', householdId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (memErr || !memberRow || !['owner', 'admin'].includes(String(memberRow.role ?? 'owner'))) {
      return jsonResponse({ error: 'Apenas um Administrador pode enviar convites para este orçamento.' }, 403);
    }

    // Obter o nome do orçamento
    const { data: hhRow } = await adminClient
      .from('households')
      .select('name')
      .eq('id', householdId)
      .maybeSingle();
    const householdName = hhRow?.name || 'Orçamento do casal';

    // Gerar o código de convite de 6 caracteres e registar na tabela household_invites
    const code = crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error: invErr } = await adminClient
      .from('household_invites')
      .insert({
        code,
        household_id: householdId,
        created_by: user.id,
        invited_email: targetEmail,
        invited_role: targetRole,
        expires_at: expiresAt,
      });

    if (invErr) {
      return jsonResponse({ error: `Erro ao gravar convite: ${invErr.message}` }, 500);
    }

    const roleLabel = targetRole === 'admin' ? 'Administrador (gestão total)' : 'Utilizador (inserir e consultar movimentos)';
    const inviterEmail = user.email || 'O administrador';

    // MODO 1 (Recomendado): Envio via Resend API (funciona para contas novas e já registadas)
    if (resendApiKey) {
      const linkHtml = appUrl
        ? `<p style="margin:20px 0"><a href="${appUrl}" style="background:#0f172a;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Abrir DuoFin 2</a></p>`
        : '';

      const htmlBody = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a;border:1px solid #e2e8f0;border-radius:12px">
          <h2 style="margin:0 0 12px;font-size:20px">Convite para a DuoFin 2</h2>
          <p style="margin:0 0 12px;line-height:1.5"><b>${inviterEmail}</b> convidou-te para aceder ao orçamento partilhado <b>${householdName}</b>.</p>
          <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:10px;padding:14px;margin:16px 0">
            <div style="font-size:13px;color:#475569;margin-bottom:4px">Perfil atribuído:</div>
            <div style="font-weight:700;margin-bottom:10px">${roleLabel}</div>
            <div style="font-size:13px;color:#475569;margin-bottom:4px">Código alternativo (válido por 7 dias):</div>
            <div style="font-size:22px;font-weight:800;letter-spacing:3px;color:#0f172a">${code}</div>
          </div>
          <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5">
            Para entrar, abre a aplicação <b>DuoFin 2</b> e inicia sessão (ou cria conta) com este mesmo endereço de email (<b>${targetEmail}</b>). A associação ao orçamento será feita automaticamente.
          </p>
          ${linkHtml}
        </div>
      `;

      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: resendFrom,
          to: [targetEmail],
          subject: `Convite DuoFin 2 — ${householdName}`,
          html: htmlBody,
        }),
      });

      if (!resendRes.ok) {
        const errTxt = await resendRes.text();
        return jsonResponse({
          code,
          emailSent: false,
          provider: 'resend',
          warning: `Convite criado, mas o Resend devolveu erro: ${errTxt}`,
        });
      }

      return jsonResponse({
        code,
        emailSent: true,
        provider: 'resend',
        message: `Email enviado com sucesso para ${targetEmail} via Resend.`,
      });
    }

    // MODO 2 (Fallback): Supabase Auth Admin inviteUserByEmail
    const { error: authInvErr } = await adminClient.auth.admin.inviteUserByEmail(targetEmail, {
      redirectTo: appUrl || undefined,
      data: {
        household_id: householdId,
        invite_code: code,
        invited_role: targetRole,
      },
    });

    if (authInvErr) {
      return jsonResponse({
        code,
        emailSent: false,
        provider: 'supabase_auth',
        warning: `Convite criado na base de dados, mas o Supabase Auth não enviou email (${authInvErr.message}).`,
      });
    }

    return jsonResponse({
      code,
      emailSent: true,
      provider: 'supabase_auth',
      message: `Email de convite enviado pelo Supabase Auth para ${targetEmail}.`,
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
