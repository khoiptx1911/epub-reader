// Vercel Serverless Function: exchanges authorization code for tokens and refreshes access tokens
// Requires environment variables: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (set in Vercel dashboard)

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = req.body || {};
  const client_id = process.env.GOOGLE_CLIENT_ID || process.env.CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET || process.env.CLIENT_SECRET;

  if (!client_id || !client_secret) {
    console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
    return res.status(500).json({ error: 'server_misconfigured', error_description: 'Missing Google client credentials on server' });
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
      // Exchange authorization code for tokens (one-time)
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
      // Use refresh_token to obtain a new access token
      const params = new URLSearchParams();
      params.append('refresh_token', body.refresh_token);
      params.append('client_id', client_id);
      params.append('client_secret', client_secret);
      params.append('grant_type', 'refresh_token');

      const { ok, status, json } = await fetchToken(params);
      if (!ok) return res.status(status || 400).json(json);
      return res.status(200).json(json);
    }

    return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code or refresh_token in request' });
  } catch (err) {
    console.error('token-exchange error', err);
    return res.status(500).json({ error: 'server_error', error_description: String(err) });
  }
};