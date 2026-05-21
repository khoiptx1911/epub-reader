// api/token-exchange.js
// Vercel Serverless Function: trao đổi auth code và refresh access token
// Sử dụng ES Modules (chạy tốt với "type": "module")

export default async function handler(req, res) {
  // Thêm cấu hình CORS để frontend giao tiếp dễ dàng
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = req.body || {};
  const client_id = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;

  if (!client_id || !client_secret) {
    console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
    return res.status(500).json({ 
      error: 'server_misconfigured', 
      error_description: 'Missing Google client credentials on server' 
    });
  }

  try {
    const fetchToken = async (params) => {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const json = await tokenRes.json().catch(() => ({}));
      return { ok: tokenRes.ok, status: tokenRes.status, json };
    };

    if (body.code) {
      // Đổi mã code lấy tokens lần đầu
      const params = new URLSearchParams();
      params.append('code', body.code);
      params.append('client_id', client_id);
      params.append('client_secret', client_secret);
      params.append('redirect_uri', body.redirect_uri || 'postmessage');
      params.append('grant_type', 'authorization_code');

      const { ok, status, json } = await fetchToken(params);
      if (!ok) return res.status(status || 400).json(json);
      return res.status(200).json(json);
    }

    if (body.refresh_token) {
      // Sử dụng refresh_token để gia hạn access_token mới
      const params = new URLSearchParams();
      params.append('refresh_token', body.refresh_token);
      params.append('client_id', client_id);
      params.append('client_secret', client_secret);
      params.append('grant_type', 'refresh_token');

      const { ok, status, json } = await fetchToken(params);
      if (!ok) return res.status(status || 400).json(json);
      return res.status(200).json(json);
    }

    return res.status(400).json({ 
      error: 'invalid_request', 
      error_description: 'Missing code or refresh_token in request' 
    });
  } catch (err) {
    console.error('token-exchange error', err);
    return res.status(500).json({ error: 'server_error', error_description: String(err) });
  }
}