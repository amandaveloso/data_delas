const {
  verifyRequestAuth,
  callGemini,
  hasCloudKV,
  kvGet,
  kvSet
} = require('./_utils');

function safeParseJson(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

function buildFallbackJobSearchUrl(title, company) {
  const q = [title, company].filter(Boolean).join(' ');
  return `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(q)}&location=Brasil`;
}

function normalizeJob(rawJob, idx, groundedUris = new Set()) {
  const title = String(rawJob.title || 'Oportunidade Compatível').trim();
  const company = String(rawJob.company || 'Empresa Mapeada').trim();
  let url = String(rawJob.url || rawJob.link || '').trim();

  const looksValidHttp = /^https?:\/\/[^\s]+$/i.test(url);
  // Evita links inventados de vagas específicas com IDs fictícios não vindos da busca real
  const isSuspiciousDeepId =
    looksValidHttp &&
    !groundedUris.has(url) &&
    /\/(jobs\/view\/\d+|job\/\d+|vagas\/\d+)/i.test(url);

  if (!looksValidHttp || isSuspiciousDeepId) {
    url = buildFallbackJobSearchUrl(title, company);
  }

  return {
    id: rawJob.id || `radar-${Date.now()}-${idx}`,
    title,
    company,
    seniority: String(rawJob.seniority || 'Pleno').trim(),
    model: String(rawJob.model || 'Remoto / Híbrido').trim(),
    city: String(rawJob.city || 'Brasil').trim(),
    skills: Array.isArray(rawJob.skills)
      ? rawJob.skills.slice(0, 6).map((s) => String(s).trim())
      : ['Dados', 'Tecnologia'],
    matchScore: Math.min(99, Math.max(75, Number(rawJob.matchScore) || 92)),
    matchReason: String(
      rawJob.matchReason || 'Forte aderência aos seus 5 pilares de valores, atuação e ferramentas.'
    ).trim(),
    description: String(
      rawJob.description || rawJob.matchReason || 'Oportunidade mapeada pelo Radar IA Data Delas.'
    ).trim(),
    url,
    foundAt: new Date().toISOString(),
    isNew: true
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Leitura pública opcional das vagas do Mural sincronizadas na nuvem
  if (req.method === 'GET') {
    if (req.query?.publicJobs === '1' && hasCloudKV()) {
      const jobs = await kvGet('dd:public_mural_jobs');
      return res.status(200).json({ jobs: Array.isArray(jobs) ? jobs : null });
    }
    return res.status(200).json({ status: 'ok', cloudKV: hasCloudKV() });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const session = verifyRequestAuth(req);
  if (!session) {
    return res.status(401).json({ error: 'Não autorizado. Faça login novamente.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const action = body.action || '';

    // 1. Sincronizar vagas públicas do Mural (apenas Admin)
    if (action === 'sync_public_jobs') {
      if (session.role !== 'admin') {
        return res.status(403).json({ error: 'Apenas administradoras podem alterar o Mural Público.' });
      }
      const jobs = Array.isArray(body.jobs) ? body.jobs : [];
      const savedCloud = hasCloudKV() ? await kvSet('dd:public_mural_jobs', jobs) : false;
      return res.status(200).json({ ok: true, savedCloud });
    }

    // 2. Salvar assinatura / preferências de frequência na nuvem (quando KV ativo)
    if (action === 'save_subscription') {
      const subscription = body.subscription || {};
      let savedCloud = false;
      if (hasCloudKV() && subscription.email) {
        const key = `dd:sub:${String(subscription.email).toLowerCase().trim()}`;
        savedCloud = await kvSet(key, {
          ...subscription,
          updatedAt: new Date().toISOString()
        });
        const list = (await kvGet('dd:sub_index')) || [];
        const emailNorm = String(subscription.email).toLowerCase().trim();
        if (!list.includes(emailNorm)) {
          list.push(emailNorm);
          await kvSet('dd:sub_index', list);
        }
      }
      return res.status(200).json({ ok: true, savedCloud });
    }

    // 3. Extrair perfil estruturado + empresas + vagas a partir da conversa com o Mentor
    if (action === 'extract_profile') {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const sources = Array.isArray(body.sources) ? body.sources : [];
      const groundedUris = new Set(sources.map((s) => s.uri).filter(Boolean));

      const transcript = messages
        .map((m) => `${m.role === 'model' || m.role === 'assistant' ? 'MENTOR' : 'USUÁRIA'}: ${m.content}`)
        .join('\n\n');

      const sourcesText =
        sources.length > 0
          ? `\nFONTES WEB REAIS ENCONTRADAS NA CONVERSA:\n${sources
              .map((s) => `- ${s.title}: ${s.uri}`)
              .join('\n')}`
          : '';

      const extractionPrompt = `Com base no histórico da mentoria de carreira abaixo, extraia e estruture o perfil completo da usuária em formato JSON estrito.

HISTÓRICO DA CONVERSA:
${transcript}
${sourcesText}

Retorne APENAS um objeto JSON válido com exatamente esta estrutura:
{
  "headline": "Título curto do perfil profissional (ex: Analista de Dados Pleno | BI & Produto)",
  "summary": "Resumo consolidado em 3 a 4 frases em 3ª ou 2ª pessoa destacando os diferenciais do perfil.",
  "pillars": {
    "valores": "Resumo dos valores inegociáveis no trabalho",
    "atuacoes": "Resumo das atuações e responsabilidades ideais",
    "ferramentas": ["Ferramenta 1", "Ferramenta 2", "Ferramenta 3"],
    "perfilEmpresa": "Cultura, porte, modelo e estilo de liderança ideais",
    "impactoSociedade": "Propósito, setores e impacto desejados"
  },
  "priorityCompanies": [
    {
      "name": "Nome da Empresa",
      "sector": "Setor de atuação",
      "matchReason": "Explicação sucinta do porquê do match com o perfil",
      "careersUrl": "URL oficial de carreiras ou busca de vagas na empresa"
    }
  ],
  "idealRoles": [
    "Cargo Ideal 1",
    "Cargo Ideal 2"
  ],
  "matchedJobs": [
    {
      "title": "Título da Vaga",
      "company": "Empresa",
      "seniority": "Júnior | Pleno | Sênior | Liderança",
      "model": "Remoto | Híbrido | Presencial",
      "city": "Brasil ou Cidade/UF",
      "skills": ["Skill 1", "Skill 2", "Skill 3"],
      "matchScore": 94,
      "matchReason": "Por que essa oportunidade combina com os 5 pilares dela",
      "description": "Resumo dos desafios e requisitos da vaga",
      "url": "URL real encontrada nas fontes web acima, ou deixe vazio para gerarmos busca direta no LinkedIn"
    }
  ]
}

REGRAS:
- Inclua de 10 a 20 empresas em "priorityCompanies".
- Inclua de 5 a 10 cargos em "idealRoles".
- Inclua de 5 a 8 oportunidades em "matchedJobs" alinhadas ao perfil.`;

      const result = await callGemini({
        contents: [{ role: 'user', parts: [{ text: extractionPrompt }] }],
        useSearch: false,
        temperature: 0.3,
        responseMimeType: 'application/json'
      });

      const parsed = safeParseJson(result.text);
      if (!parsed) {
        return res.status(500).json({ error: 'Não foi possível estruturar os dados do perfil.' });
      }

      const normalizedJobs = (parsed.matchedJobs || []).map((j, idx) =>
        normalizeJob(j, idx, groundedUris)
      );

      return res.status(200).json({
        profile: {
          headline: parsed.headline || 'Profissional Tech & Dados',
          summary: parsed.summary || '',
          pillars: parsed.pillars || {},
          priorityCompanies: Array.isArray(parsed.priorityCompanies) ? parsed.priorityCompanies : [],
          idealRoles: Array.isArray(parsed.idealRoles) ? parsed.idealRoles : [],
          updatedAt: new Date().toISOString()
        },
        jobs: normalizedJobs
      });
    }

    // 4. Executar varredura ativa de novas vagas na Web (Google Search Grounding + Indexação)
    if (action === 'run_sweep') {
      const profile = body.profile || {};
      const existingTitles = new Set(
        (Array.isArray(body.existingJobKeys) ? body.existingJobKeys : []).map((k) =>
          String(k).toLowerCase().trim()
        )
      );

      const companiesList = (profile.priorityCompanies || [])
        .slice(0, 12)
        .map((c) => (typeof c === 'string' ? c : c.name))
        .filter(Boolean)
        .join(', ');
      const rolesList = (profile.idealRoles || []).slice(0, 8).join(', ');
      const toolsList = Array.isArray(profile.pillars?.ferramentas)
        ? profile.pillars.ferramentas.join(', ')
        : profile.pillars?.ferramentas || '';

      // Passo A: Pesquisa web fundamentada no Google Search para encontrar vagas reais e recentes
      const searchPrompt = `Pesquise na web vagas reais e recentes abertas no Brasil ou remotas para os seguintes cargos: ${
        rolesList || 'Analista de Dados, Cientista de Dados, Analytics Engineer, Operações'
      }.
Priorize estas empresas (ou similares do mesmo perfil): ${companiesList || 'empresas de tecnologia, dados e impacto no Brasil'}.
Perfil da candidata:
- Resumo: ${profile.summary || ''}
- Valores: ${profile.pillars?.valores || ''}
- Ferramentas/Skills: ${toolsList}
- Perfil de empresa desejado: ${profile.pillars?.perfilEmpresa || ''}
- Impacto desejado: ${profile.pillars?.impactoSociedade || ''}

Traga de 4 a 6 oportunidades reais e aderentes encontradas, informando título exato, empresa, modelo (Remoto/Híbrido/Presencial), senioridade, skills pedidas, motivo do match com o perfil dela e link da vaga/página de carreira.`;

      const groundedSearch = await callGemini({
        contents: [{ role: 'user', parts: [{ text: searchPrompt }] }],
        useSearch: true,
        temperature: 0.45
      });

      const groundedUris = new Set((groundedSearch.sources || []).map((s) => s.uri).filter(Boolean));
      const sourcesListText = (groundedSearch.sources || [])
        .map((s) => `- ${s.title}: ${s.uri}`)
        .join('\n');

      // Passo B: Estruturação limpa em JSON a partir do resultado da busca
      const formatPrompt = `Converta as vagas encontradas abaixo em JSON estrito.
RESULTADO DA BUSCA:
${groundedSearch.text}

FONTES REAIS VERIFICADAS:
${sourcesListText}

Retorne APENAS JSON neste formato:
{
  "jobs": [
    {
      "title": "Nome da Vaga",
      "company": "Empresa",
      "seniority": "Júnior | Pleno | Sênior | Liderança",
      "model": "Remoto | Híbrido | Presencial",
      "city": "Brasil ou Cidade/UF",
      "skills": ["Skill 1", "Skill 2", "Skill 3"],
      "matchScore": 95,
      "matchReason": "Explicação personalizada do match com os pilares da candidata",
      "description": "Resumo objetivo das responsabilidades e requisitos",
      "url": "URL exata presente em FONTES REAIS VERIFICADAS acima, ou vazio se não houver URL direta"
    }
  ]
}`;

      const structured = await callGemini({
        contents: [{ role: 'user', parts: [{ text: formatPrompt }] }],
        useSearch: false,
        temperature: 0.2,
        responseMimeType: 'application/json'
      });

      const parsed = safeParseJson(structured.text) || { jobs: [] };
      const sweptJobs = (parsed.jobs || []).map((j, idx) => {
        const norm = normalizeJob(j, idx, groundedUris);
        const dedupKey = `${norm.title.toLowerCase()}::${norm.company.toLowerCase()}`;
        norm.isNew = !existingTitles.has(dedupKey);
        return norm;
      });

      return res.status(200).json({
        jobs: sweptJobs,
        newCount: sweptJobs.filter((j) => j.isNew).length,
        sources: groundedSearch.sources || [],
        groundedWithSearch: groundedSearch.groundedWithSearch,
        sweptAt: new Date().toISOString()
      });
    }

    return res.status(400).json({ error: 'Ação inválida informada para /api/radar.' });
  } catch (err) {
    const status = err.code === 'MISSING_GEMINI_KEY' ? 503 : 500;
    return res.status(status).json({
      error: err.message || 'Erro ao executar o Radar de Vagas.',
      code: err.code || 'RADAR_ERROR'
    });
  }
};
