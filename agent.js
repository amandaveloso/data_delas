const { verifyRequestAuth, callGemini } = require('./_utils');

const MENTOR_SYSTEM_PROMPT = `Atue como um mentor especialista em carreira, recrutamento e recolocação no mercado de trabalho, integrado ao ecossistema Data Delas (comunidade de tecnologia, dados e liderança para mulheres). O meu objetivo nesta conversa é identificar perfis de empresas e vagas específicas alinhadas aos meus valores, habilidades e aspirações profissionais.

Para isso, você deve seguir a dinâmica abaixo estritamente em duas etapas:

---
ETAPA 1: INVESTIGAÇÃO Guiada (Conversa em Blocos)
Você fará um diagnóstico completo do meu perfil. Não envie todas as perguntas de uma vez só para não me sobrecarregar. Envie blocos de 2 a 3 perguntas por vez e aguarde minhas respostas antes de prosseguir com o próximo bloco. 

Ao todo, entre os blocos, você fará de 8 a 15 perguntas cobrindo obrigatoriamente os seguintes pilares:
1. Valores no Trabalho: O que é inegociável para mim (ex: autonomia, flexibilidade, diversidade, estabilidade, transparência, etc.).
2. Atuações e Responsabilidades: O tipo de desafios e atribuições do dia a dia em que me sinto mais realizado(a) e produtivo(a).
3. Ferramentas e Tecnologias: As ferramentas, softwares, metodologias ou linguagens com as quais já trabalho ou gostaria muito de trabalhar.
4. Perfil da Empresa: Cultura interna, porte (startup, multinacional, empresa consolidada), estilo de liderança e ambiente de trabalho.
5. Impacto na Sociedade: O propósito, setor de atuação, causa ou impacto social/ambiental que gostaria que a empresa promovesse.

---
ETAPA 2: RECOMENDAÇÃO E PESQUISA DE VAGAS
Assim que você tiver respostas suficientes para todos os pilares acima, faça um resumo consolidado do meu perfil e me entregue o seguinte resultado final:
1. Lista de Empresas Prioritárias: De 10 a 20 empresas que combinem fortemente com o meu perfil mapeado, explicando sucintamente o porquê do match para cada uma.
2. Vagas e Cargos de Exemplo: Pelo menos 5 a 10 sugestões de títulos de vagas/cargos ideais para o meu momento e, se possível, buscas por oportunidades reais ativas nessas empresas ou no mercado com os requisitos correspondentes (incluindo links diretos quando encontrados na busca web).

DIRETRIZES DE FORMATAÇÃO E CONTROLE INTERNO:
- Use Markdown claro e acolhedor (negrito, listas, subtítulos organizados).
- Na Etapa 1, NUNCA envie mais de 3 perguntas na mesma mensagem e NUNCA pule para a Etapa 2 antes de cobrir os 5 pilares (mínimo de 8 perguntas somadas entre os blocos).
- Ao final de TODA resposta sua, adicione exatamente na última linha esta tag oculta de metadados (ela será lida pelo sistema e ocultada da usuária):
<!--DD_META:{"stage":1,"pillars":[1],"questionsAskedSoFar":2,"readyForRadar":false}-->
Onde:
- "stage": 1 durante a investigação guiada, ou 2 quando você entregar a recomendação final completa da Etapa 2.
- "pillars": lista com os números dos pilares (1 a 5) que JÁ foram abordados ou respondidos até este momento.
- "questionsAskedSoFar": total acumulado aproximado de perguntas já feitas.
- "readyForRadar": true SOMENTE quando você já tiver entregado o resultado completo da Etapa 2 (resumo + 10 a 20 empresas + 5 a 10 cargos e vagas).`;

const INITIAL_USER_TRIGGER =
  'Por favor, comece me fazendo o primeiro bloco com as 2 a 3 primeiras perguntas da Etapa 1.';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const session = verifyRequestAuth(req);
  if (!session) {
    return res.status(401).json({ error: 'Sessão expirada ou não autenticada. Faça login novamente.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];

    let contents = [];
    if (rawMessages.length === 0) {
      contents = [
        {
          role: 'user',
          parts: [{ text: INITIAL_USER_TRIGGER }]
        }
      ];
    } else {
      // Garante que a conversa comece com 'user' conforme exigido pela API Gemini
      if (rawMessages[0].role === 'model' || rawMessages[0].role === 'assistant') {
        contents.push({
          role: 'user',
          parts: [{ text: INITIAL_USER_TRIGGER }]
        });
      }
      for (const msg of rawMessages) {
        const text = String(msg.content || msg.text || '').trim();
        if (!text) continue;
        const role = msg.role === 'model' || msg.role === 'assistant' ? 'model' : 'user';
        const prev = contents[contents.length - 1];
        if (prev && prev.role === role) {
          prev.parts.push({ text });
        } else {
          contents.push({
            role,
            parts: [{ text }]
          });
        }
      }
    }

    // Ativa Google Search Grounding a partir do 3º turno da usuária (quando se aproxima da Etapa 2)
    // ou se a usuária pedir explicitamente vagas/pesquisa
    const userTurnCount = contents.filter((c) => c.role === 'user').length;
    const lastUserText = (contents[contents.length - 1]?.parts?.[0]?.text || '').toLowerCase();
    const shouldUseSearch =
      userTurnCount >= 3 ||
      lastUserText.includes('etapa 2') ||
      lastUserText.includes('vaga') ||
      lastUserText.includes('recomenda');

    const result = await callGemini({
      systemInstruction: MENTOR_SYSTEM_PROMPT,
      contents,
      useSearch: shouldUseSearch,
      temperature: 0.65
    });

    let cleanReply = result.text;
    let meta = {
      stage: 1,
      pillars: [1],
      questionsAskedSoFar: 2,
      readyForRadar: false
    };

    const metaMatch = cleanReply.match(/<!--\s*DD_META:\s*(\{[\s\S]*?\})\s*-->/i);
    if (metaMatch) {
      try {
        const parsed = JSON.parse(metaMatch[1]);
        meta = {
          stage: parsed.stage === 2 ? 2 : 1,
          pillars: Array.isArray(parsed.pillars) ? parsed.pillars : [1],
          questionsAskedSoFar: Number(parsed.questionsAskedSoFar) || 2,
          readyForRadar: Boolean(parsed.readyForRadar || parsed.stage === 2)
        };
      } catch (e) {
        // Ignora erro de parse no comentário oculto
      }
      cleanReply = cleanReply.replace(/<!--\s*DD_META:[\s\S]*?-->/gi, '').trim();
    } else if (
      cleanReply.toLowerCase().includes('empresas prioritárias') &&
      cleanReply.toLowerCase().includes('vagas')
    ) {
      meta = {
        stage: 2,
        pillars: [1, 2, 3, 4, 5],
        questionsAskedSoFar: 10,
        readyForRadar: true
      };
    }

    return res.status(200).json({
      reply: cleanReply,
      meta,
      sources: result.sources || [],
      groundedWithSearch: result.groundedWithSearch
    });
  } catch (err) {
    const status = err.code === 'MISSING_GEMINI_KEY' ? 503 : 500;
    return res.status(status).json({
      error: err.message || 'Erro ao comunicar com o Agente de Carreira.',
      code: err.code || 'AGENT_ERROR'
    });
  }
};
