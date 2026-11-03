const {
  getAdminPassword,
  getSubscriberPassword,
  createSessionToken,
  verifyRequestAuth,
  hasCloudKV
} = require('./_utils');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'GET') {
    const session = verifyRequestAuth(req);
    if (!session) {
      return res.status(401).json({ authenticated: false });
    }

    return res.status(200).json({
      authenticated: true,
      role: session.role,
      email: session.email || '',
      name: session.name || '',
      capabilities: {
        hasGeminiKey: Boolean((process.env.GEMINI_API_KEY || '').trim()),
        hasEmailProvider: Boolean((process.env.RESEND_API_KEY || '').trim()),
        hasCloudKV: hasCloudKV()
      }
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const password = String(body.password || '').trim();
    const email = String(body.email || '').trim();
    const name = String(body.name || '').trim();

    if (!password) {
      return res.status(400).json({ error: 'Informe a chave de acesso.' });
    }

    const adminPass = getAdminPassword();
    const subPass = getSubscriberPassword();

    let role = null;
    if (password.toLowerCase() === adminPass.toLowerCase()) {
      role = 'admin';
    } else if (subPass && password.toLowerCase() === subPass.toLowerCase()) {
      role = 'subscriber';
    }

    if (!role) {
      return res.status(401).json({ error: 'Chave de acesso inválida.' });
    }

    const token = createSessionToken({
      role,
      email,
      name
    });

    return res.status(200).json({
      authenticated: true,
      token,
      role,
      capabilities: {
        hasGeminiKey: Boolean((process.env.GEMINI_API_KEY || '').trim()),
        hasEmailProvider: Boolean((process.env.RESEND_API_KEY || '').trim()),
        hasCloudKV: hasCloudKV()
      }
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao processar autenticação.' });
  }
};
