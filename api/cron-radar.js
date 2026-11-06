const {
  callGemini,
  hasCloudKV,
  kvGet,
  kvSet,
  buildDigestEmailHtml,
  sendEmailViaResend
} = require('./_utils');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Proteção opcional para execução exclusiva pela Vercel Cron
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  if (cronSecret) {
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Execução de cron não autorizada.' });
    }
  }

  if (!hasCloudKV()) {
    return res.status(200).json({
      ok: true,
      mode: 'mvp-client-storage',
      message:
        'Cron agendado ativo na Vercel. Para varreduras em segundo plano de múltiplas assinantes, conecte Vercel KV / Upstash Redis nas variáveis de ambiente.'
    });
  }

  try {
    // Dia da semana no horário de Brasília (UTC-3): 1 = Seg, 3 = Qua, 5 = Sex
    const nowBrt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const dayOfWeek = nowBrt.getUTCDay();
    const is3xDay = dayOfWeek === 1 || dayOfWeek === 3 || dayOfWeek === 5;

    const emails = (await kvGet('dd:sub_index')) || [];
    const processed = [];

    for (const email of emails) {
      const sub = await kvGet(`dd:sub:${email}`);
      if (!sub || !sub.active || !sub.profile) continue;

      const shouldRunToday =
        sub.frequency === 'daily' || (sub.frequency === '3x_week' && is3xDay);
      if (!shouldRunToday) continue;

      const roles = (sub.profile.idealRoles || []).slice(0, 6).join(', ');
      const companies = (sub.profile.priorityCompanies || [])
        .slice(0, 10)
        .map((c) => (typeof c === 'string' ? c : c.name))
        .join(', ');

      const searchResult = await callGemini({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Pesquise na web 4 vagas reais abertas recentemente no Brasil ou remotas para (${roles}) em empresas como (${companies}) alinhadas a: ${sub.profile.summary || ''}. Retorne título, empresa, modelo, senioridade, motivo do match e link.`
              }
            ]
          }
        ],
        useSearch: true,
        temperature: 0.4
      });

      const structured = await callGemini({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Converta estas vagas em JSON {"jobs":[{"title":"","company":"","seniority":"","model":"","matchScore":94,"matchReason":"","url":""}]}:\n${searchResult.text}`
              }
            ]
          }
        ],
        useSearch: false,
        temperature: 0.2,
        responseMimeType: 'application/json'
      });

      let jobs = [];
      try {
        jobs = JSON.parse(structured.text).jobs || [];
      } catch (e) {
        jobs = [];
      }

      if (jobs.length > 0 && sub.email) {
        const frequencyLabel =
          sub.frequency === 'daily' ? 'Todo Dia (Diária)' : '3x por Semana (Seg, Qua, Sex)';
        const html = buildDigestEmailHtml({
          userName: sub.userName || 'Assinante Data Delas',
          frequencyLabel,
          triggerType: sub.alertOnNewJobs ? 'instant_alert' : 'digest',
          summary: sub.profile.summary || '',
          jobs,
          companies: sub.profile.priorityCompanies || []
        });

        await sendEmailViaResend({
          to: sub.email,
          subject: `💙 Radar Data Delas (${frequencyLabel}): ${jobs.length} novas vagas mapeadas`,
          html
        });

        await kvSet(`dd:sub:${email}`, {
          ...sub,
          lastSweepAt: new Date().toISOString(),
          latestJobs: jobs
        });
      }

      processed.push({ email, jobsFound: jobs.length });
    }

    return res.status(200).json({
      ok: true,
      executedAt: new Date().toISOString(),
      is3xDay,
      processed
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Falha na rotina agendada.' });
  }
};
