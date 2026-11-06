const {
  verifyRequestAuth,
  buildDigestEmailHtml,
  sendEmailViaResend
} = require('./_utils');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const session = verifyRequestAuth(req);
  if (!session) {
    return res.status(401).json({ error: 'Não autorizado. Faça login novamente.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const toEmail = String(body.email || '').trim();
    const userName = String(body.userName || 'Talento Data Delas').trim();
    const frequencyLabel = String(body.frequencyLabel || '3x por Semana (Seg, Qua, Sex)').trim();
    const triggerType = body.triggerType === 'instant_alert' ? 'instant_alert' : 'digest';
    const summary = String(body.summary || '').trim();
    const jobs = Array.isArray(body.jobs) ? body.jobs : [];
    const companies = Array.isArray(body.companies) ? body.companies : [];
    const origin =
      req.headers.origin ||
      (req.headers.host ? `https://${req.headers.host}` : 'https://data-delas.vercel.app');

    const subject =
      triggerType === 'instant_alert'
        ? `🔔 ${jobs.length} nova(s) vaga(s) compatível(is) com seu perfil — Radar Data Delas`
        : `💙 Seu Radar de Vagas (${frequencyLabel}) — Data Delas`;

    const html = buildDigestEmailHtml({
      userName,
      frequencyLabel,
      triggerType,
      summary,
      jobs,
      companies,
      portalUrl: `${origin}/portal`
    });

    if (!toEmail) {
      return res.status(200).json({
        sent: false,
        simulated: true,
        subject,
        htmlPreview: html,
        message: 'Pré-visualização gerada! Preencha seu e-mail nas preferências para habilitar o disparo.'
      });
    }

    const sendResult = await sendEmailViaResend({
      to: toEmail,
      subject,
      html
    });

    return res.status(200).json({
      ...sendResult,
      subject,
      htmlPreview: html,
      dispatchedAt: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Erro ao preparar/enviar notificação por e-mail.'
    });
  }
};
