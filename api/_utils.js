const crypto = require('crypto');

function getAdminPassword() {
  return (process.env.ADMIN_PASSWORD || 'datadelas2026').trim();
}

function getSubscriberPassword() {
  return (process.env.SUBSCRIBER_PASSWORD || 'assinantedatadelas').trim();
}

function getSessionSecret() {
  return (
    process.env.SESSION_SECRET ||
    `dd-hmac-${getAdminPassword()}-${(process.env.GEMINI_API_KEY || 'fallback-salt').slice(-8)}`
  );
}

function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(b64) {
  let normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function createSessionToken(payloadObj) {
  const payload = {
    ...payloadObj,
    iat: Date.now(),
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 dias
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', getSessionSecret())
    .update(encodedPayload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(encodedPayload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function verifyRequestAuth(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return verifySessionToken(token);
}

/**
 * Chamada segura server-side para a API do Google Gemini.
 * A GEMINI_API_KEY nunca sai do servidor da Vercel.
 */
async function callGemini({
  systemInstruction,
  contents,
  useSearch = false,
  temperature = 0.65,
  responseMimeType = null
}) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error(
      'GEMINI_API_KEY não configurada no ambiente da Vercel. Acesse Settings > Environment Variables na Vercel e adicione GEMINI_API_KEY.'
    );
    err.code = 'MISSING_GEMINI_KEY';
    throw err;
  }

  const isVertexKey = apiKey.startsWith('AQ.');
  const endpointsToTry = isVertexKey
    ? [
        { base: 'https://aiplatform.googleapis.com/v1/publishers/google/models', vertex: true },
        { base: 'https://generativelanguage.googleapis.com/v1beta/models', vertex: false }
      ]
    : [
        { base: 'https://generativelanguage.googleapis.com/v1beta/models', vertex: false },
        { base: 'https://aiplatform.googleapis.com/v1/publishers/google/models', vertex: true }
      ];

  const defaultModels = (process.env.GEMINI_MODEL || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const modelsToTry =
    defaultModels.length > 0
      ? defaultModels
      : ['gemini-3.8-flash', 'gemini-flash-latest'];
  const triedModels = new Set();
  let lastError = null;

  const normalizedContents = (contents || []).map((c) => ({
    role: c.role === 'model' ? 'model' : 'user',
    parts: c.parts || []
  }));

  for (const ep of endpointsToTry) {
    for (let mIdx = 0; mIdx < modelsToTry.length; mIdx++) {
      const model = modelsToTry[mIdx];
      const epModelKey = `${ep.base}::${model}`;
      if (triedModels.has(epModelKey)) continue;
      triedModels.add(epModelKey);

      const attemptConfigs = useSearch && !responseMimeType ? [true, false] : [false];

      for (const withSearch of attemptConfigs) {
        try {
          const generationConfig = {};
          if (!model.startsWith('gemini-3.')) {
            generationConfig.temperature = temperature;
          }
          if (responseMimeType && !withSearch) {
            generationConfig.responseMimeType = responseMimeType;
          }

          const body = {
            contents: normalizedContents
          };

          if (Object.keys(generationConfig).length > 0) {
            body.generationConfig = generationConfig;
          }

          if (systemInstruction) {
            body.systemInstruction = ep.vertex
              ? { role: 'system', parts: [{ text: systemInstruction }] }
              : { parts: [{ text: systemInstruction }] };
          }

          if (withSearch) {
            body.tools = ep.vertex ? [{ googleSearch: {} }] : [{ google_search: {} }];
          }

          const resp = await fetch(`${ep.base}/${model}:generateContent`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey
            },
            body: JSON.stringify(body)
          });

          const data = await resp.json();

          if (!resp.ok) {
            const msg = data?.error?.message || `Erro HTTP ${resp.status} no modelo ${model}`;
            const suggested = msg.match(/models\/(gemini-[a-z0-9.-]+)/i);
            if (suggested && suggested[1] && !modelsToTry.includes(suggested[1])) {
              modelsToTry.push(suggested[1]);
            }
            lastError = new Error(msg);
            continue;
          }

          const candidate = data?.candidates?.[0];
          const parts = candidate?.content?.parts || [];
          const visibleParts = parts.filter((p) => !p.thought);
          const text = (visibleParts.length > 0 ? visibleParts : parts)
            .map((p) => p.text || '')
            .join('')
            .trim();

          if (!text) {
            lastError = new Error('Resposta vazia retornada pelo modelo Gemini.');
            continue;
          }

          const rawChunks = candidate?.groundingMetadata?.groundingChunks || [];
          const sources = [];
          const seenUris = new Set();
          for (const chunk of rawChunks) {
            const uri = chunk?.web?.uri;
            const title = chunk?.web?.title;
            if (uri && !seenUris.has(uri)) {
              seenUris.add(uri);
              sources.push({ uri, title: title || uri });
            }
          }

          return {
            text,
            sources,
            modelUsed: model,
            groundedWithSearch: withSearch && sources.length > 0
          };
        } catch (fetchErr) {
          lastError = fetchErr;
        }
      }
    }
  }

  throw lastError || new Error('Não foi possível obter resposta da API do Google Gemini.');
}

/**
 * Suporte opcional para Upstash Redis / Vercel KV (para persistência em nuvem multi-usuárias)
 */
function hasCloudKV() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return Boolean(url && token);
}

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.result == null) return null;
    return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
  } catch (e) {
    return null;
  }
}

async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;

  try {
    const serialized = JSON.stringify(value);
    const res = await fetch(`${url.replace(/\/$/, '')}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(serialized)
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildDigestEmailHtml({
  userName = 'Talento Data Delas',
  frequencyLabel = '3x por Semana',
  triggerType = 'digest',
  summary = '',
  jobs = [],
  companies = [],
  portalUrl = 'https://data-delas.vercel.app/portal'
}) {
  const badgeTitle =
    triggerType === 'instant_alert'
      ? '🔔 ALERTA IMEDIATO: NOVAS VAGAS DETECTADAS'
      : `📡 RADAR DATA DELAS • ${frequencyLabel.toUpperCase()}`;

  const jobsHtml =
    jobs.length > 0
      ? jobs
          .slice(0, 8)
          .map(
            (job) => `
        <div style="background:#0f1422;border:1px solid #1f293d;border-left:4px solid #00f2fe;border-radius:12px;padding:18px;margin-bottom:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="font-size:11px;color:#00f2fe;font-weight:700;text-transform:uppercase;letter-spacing:1px;">
              ${escapeHtml(job.model || 'Remoto / Híbrido')} • ${escapeHtml(job.seniority || 'Compatível')}
            </span>
            ${
              job.matchScore
                ? `<span style="background:rgba(57,255,20,0.12);color:#39ff14;border:1px solid rgba(57,255,20,0.4);padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700;">${escapeHtml(job.matchScore)}% Match</span>`
                : ''
            }
          </div>
          <h3 style="margin:4px 0;color:#ffffff;font-size:17px;">${escapeHtml(job.title)}</h3>
          <p style="margin:0 0 8px 0;color:#ff007f;font-size:13px;font-weight:600;">${escapeHtml(job.company)}</p>
          <p style="margin:0 0 12px 0;color:#cbd5e1;font-size:13px;line-height:1.5;">
            ${escapeHtml(job.matchReason || job.description || 'Alinhada aos seus pilares de carreira mapeados pelo Agente Data Delas.')}
          </p>
          <a href="${escapeHtml(job.url || job.link || portalUrl)}" target="_blank" style="display:inline-block;background:linear-gradient(90deg,#00f2fe,#7000ff);color:#080b11;font-weight:800;font-size:12px;text-decoration:none;padding:9px 16px;border-radius:8px;text-transform:uppercase;letter-spacing:0.5px;">
            Ver Vaga / Candidatar-se &rarr;
          </a>
        </div>`
          )
          .join('')
      : `<p style="color:#94a3b8;font-size:13px;">Suas empresas prioritárias estão sendo monitoradas e novas oportunidades aparecerão aqui assim que publicadas.</p>`;

  const companiesHtml =
    companies.length > 0
      ? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #1f293d;">
          <h4 style="color:#00f2fe;font-size:13px;text-transform:uppercase;letter-spacing:1px;margin:0 0 10px 0;">Top Empresas Monitoradas para Você</h4>
          <p style="color:#cbd5e1;font-size:12px;line-height:1.6;margin:0;">
            ${companies
              .slice(0, 12)
              .map((c) => escapeHtml(typeof c === 'string' ? c : c.name))
              .join(' • ')}
          </p>
        </div>`
      : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:24px;background-color:#080b11;font-family:'Inter',Arial,sans-serif;color:#f1f5f9;">
  <div style="max-width:620px;margin:0 auto;background:#0b101b;border:1px solid #1f293d;border-radius:20px;overflow:hidden;">
    <div style="background:linear-gradient(90deg,#00f2fe,#7000ff,#ff007f);height:4px;"></div>
    <div style="padding:28px;">
      <div style="margin-bottom:16px;">
        <span style="display:inline-block;background:rgba(112,0,255,0.2);border:1px solid rgba(0,242,254,0.4);color:#00f2fe;font-size:11px;font-weight:700;padding:4px 10px;border-radius:99px;letter-spacing:1px;">
          ${escapeHtml(badgeTitle)}
        </span>
      </div>
      <h1 style="margin:0 0 10px 0;font-size:22px;color:#ffffff;">Olá, ${escapeHtml(userName)}! 💙</h1>
      <p style="margin:0 0 20px 0;color:#cbd5e1;font-size:14px;line-height:1.6;">
        Nosso Agente Especialista de Carreira realizou uma varredura alinhada aos seus <strong>5 pilares de valores, atuação, ferramentas, cultura e impacto</strong>. Confira as vagas indexadas no seu Radar Data Delas:
      </p>
      ${
        summary
          ? `<div style="background:rgba(15,20,34,0.9);border:1px solid #1f293d;border-radius:12px;padding:14px;margin-bottom:20px;">
              <strong style="color:#ff007f;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Seu Perfil Mapeado</strong>
              <p style="margin:6px 0 0 0;color:#94a3b8;font-size:12px;line-height:1.5;">${escapeHtml(summary)}</p>
            </div>`
          : ''
      }
      <h2 style="font-size:15px;color:#ffffff;text-transform:uppercase;letter-spacing:1px;margin:0 0 14px 0;">
        Vagas Compatíveis Encontradas (${jobs.length})
      </h2>
      ${jobsHtml}
      ${companiesHtml}
      <div style="margin-top:26px;text-align:center;">
        <a href="${escapeHtml(portalUrl)}" target="_blank" style="display:inline-block;background:#7000ff;color:#ffffff;font-weight:700;font-size:13px;text-decoration:none;padding:12px 24px;border-radius:10px;">
          Acessar Minha Área Logada no Portal Data Delas
        </a>
      </div>
      <p style="margin:24px 0 0 0;text-align:center;color:#64748b;font-size:11px;">
        Data Delas • Comunidade de Tecnologia e Dados para Mulheres<br>
        Frequência ativa: ${escapeHtml(frequencyLabel)}
      </p>
    </div>
  </div>
</body>
</html>`;
}

async function sendEmailViaResend({ to, subject, html }) {
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  const fromEmail = (process.env.RESEND_FROM_EMAIL || 'Data Delas Radar <onboarding@resend.dev>').trim();

  if (!resendKey) {
    return {
      sent: false,
      simulated: true,
      provider: 'simulation',
      message:
        'Modo de demonstração ativo (RESEND_API_KEY opcional ainda não configurada). O e-mail completo foi gerado e pode ser visualizado no painel!'
    };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromEmail,
      to: Array.isArray(to) ? to : [to],
      subject,
      html
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || `Falha ao enviar e-mail via Resend (HTTP ${res.status}).`);
  }

  return {
    sent: true,
    simulated: false,
    provider: 'resend',
    id: data.id,
    message: `E-mail enviado com sucesso para ${to}!`
  };
}

module.exports = {
  getAdminPassword,
  getSubscriberPassword,
  createSessionToken,
  verifyRequestAuth,
  callGemini,
  hasCloudKV,
  kvGet,
  kvSet,
  buildDigestEmailHtml,
  sendEmailViaResend
};
