const express = require('express');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// ZOOM CONFIG
const zoomClientId = 'pC6fhDfTLmRugGqdAVVhg';
const zoomClientSecret = 'IA6UP6IAIjOkCeVz65DCZA9uLmobC9Gw';
const zoomRedirectUri = 'http://localhost:4000/auth/zoom/callback';


// GOOGLE CONFIG
const googleClientId = '160011252982-lced0v3c9inj6cqkcoihlc7tlgbfbjkk.apps.googleusercontent.com';
const googleClientSecret = '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';
const googleRedirectUri = 'http://localhost:4000/auth/google/callback';
const googleScope =
  'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.profile';
  const googleFolderId = '1NMTnL3-QLCmucR_X2JMNifHI5SaHsxm3'; 

let db;

// Initialize DB
(async () => {
  db = await open({
    filename: './tokens.db',
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT,
      user_id TEXT,
      access_token TEXT,
      refresh_token TEXT,
      expires_at INTEGER
    )
  `);
})();

const app = express();

// Enable CORS from frontend, allow credentials
app.use(
  cors({
    origin: 'http://localhost:3000',
    credentials: true,
  })
);

app.use(
  session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: 'lax',
    },
  })
);

// Helper: Retrieve tokens from DB by provider & user_id
async function getTokens(provider, userId) {
  return db.get(`SELECT * FROM user_tokens WHERE provider=? AND user_id=?`, [
    provider,
    userId,
  ]);
}

// Helper: Store or update tokens in DB
async function storeTokens(
  provider,
  userId,
  accessToken,
  refreshToken,
  expiresIn
) {
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : null;
  const existing = await getTokens(provider, userId);
  if (existing) {
    await db.run(
      `UPDATE user_tokens SET access_token=?, refresh_token=?, expires_at=? WHERE id=?`,
      [accessToken, refreshToken, expiresAt, existing.id]
    );
  } else {
    await db.run(
      `INSERT INTO user_tokens (provider, user_id, access_token, refresh_token, expires_at) VALUES (?,?,?,?,?)`,
      [provider, userId, accessToken, refreshToken, expiresAt]
    );
  }
}

// Helper: Refresh Google tokens if expired
async function refreshGoogleTokens(refreshToken) {
  const response = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: googleClientId,
    client_secret: googleClientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return response.data;
}

// Helper: Refresh Zoom tokens if expired
async function refreshZoomTokens(refreshToken) {
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);

  const response = await axios.post('https://zoom.us/oauth/token', params, {
    headers: {
      Authorization:
        'Basic ' +
        Buffer.from(`${zoomClientId}:${zoomClientSecret}`).toString('base64'),
    },
  });
  return response.data;
}

// Get user tokens and refresh if needed
async function ensureTokens(provider, userId) {
  const tokens = await getTokens(provider, userId);
  if (!tokens) return null;
  // Check if expired
  if (tokens.expires_at && Date.now() > tokens.expires_at) {
    // Need refresh
    let newTokens;
    if (provider === 'google') {
      newTokens = await refreshGoogleTokens(tokens.refresh_token);
      await storeTokens(
        'google',
        userId,
        newTokens.access_token,
        newTokens.refresh_token || tokens.refresh_token,
        newTokens.expires_in
      );
    } else if (provider === 'zoom') {
      newTokens = await refreshZoomTokens(tokens.refresh_token);
      await storeTokens(
        'zoom',
        userId,
        newTokens.access_token,
        newTokens.refresh_token || tokens.refresh_token,
        newTokens.expires_in
      );
    }
  }
  return getTokens(provider, userId);
}

// ZOOM AUTH ROUTES
app.get('/auth/zoom', (req, res) => {
  const authorizationUrl = `https://zoom.us/oauth/authorize?response_type=code&client_id=${zoomClientId}&redirect_uri=${encodeURIComponent(
    zoomRedirectUri
  )}`;
  res.redirect(authorizationUrl);
});

app.get('/auth/zoom/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code returned from Zoom');

  try {
    const tokenResponse = await axios.post(
      'https://zoom.us/oauth/token',
      null,
      {
        params: {
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: zoomRedirectUri,
        },
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(`${zoomClientId}:${zoomClientSecret}`).toString(
              'base64'
            ),
        },
      }
    );

    const accessToken = tokenResponse.data.access_token;
    const refreshToken = tokenResponse.data.refresh_token;
    const expiresIn = tokenResponse.data.expires_in;

    // Get Zoom user info
    const userInfo = await axios.get('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const zoomUserId = userInfo.data.id;

    // Store tokens in DB
    await storeTokens('zoom', zoomUserId, accessToken, refreshToken, expiresIn);

    // Store user info in session
    req.session.user = { provider: 'zoom', user_id: zoomUserId };
    res.redirect('http://localhost:3000');
  } catch (error) {
    console.error(
      'Error fetching Zoom tokens:',
      error.response?.data || error.message
    );
    res.status(500).send('Error exchanging code for token.');
  }
});

app.get('/api/zoom/status', async (req, res) => {
  if (!req.session.user || req.session.user.provider !== 'zoom')
    return res.json({ connected: false });
  const tokens = await ensureTokens('zoom', req.session.user.user_id);
  res.json({ connected: !!tokens });
});

app.get('/api/zoom/recordings', async (req, res) => {
  if (!req.session.user || req.session.user.provider !== 'zoom')
    return res.status(401).send('Not connected to Zoom');
  const tokens = await ensureTokens('zoom', req.session.user.user_id);
  if (!tokens) return res.status(401).send('No tokens found');

  try {
    const response = await axios.get(
      'https://api.zoom.us/v2/users/me/recordings',
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error(
      'Error fetching Zoom recordings:',
      error.response?.data || error.message
    );
    res.status(500).send('Error fetching recordings.');
  }
});

app.get('/api/zoom/userinfo', async (req, res) => {
  if (!req.session.user || req.session.user.provider !== 'zoom')
    return res.status(401).send('Not connected to Zoom');
  const tokens = await ensureTokens('zoom', req.session.user.user_id);
  if (!tokens) return res.status(401).send('No tokens found');

  try {
    const response = await axios.get('https://api.zoom.us/v2/users/me', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });
    res.json(response.data);
  } catch (error) {
    console.error(
      'Error fetching Zoom user info:',
      error.response?.data || error.message
    );
    res.status(500).send('Error fetching Zoom user info.');
  }
});

// GOOGLE AUTH ROUTES
app.get('/auth/google', (req, res) => {
  const authorizationUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    `response_type=code&` +
    `client_id=${googleClientId}&` +
    `redirect_uri=${encodeURIComponent(googleRedirectUri)}&` +
    `scope=${encodeURIComponent(googleScope)}&` +
    `access_type=offline&` +
    `prompt=consent`;
  res.redirect(authorizationUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code returned from Google');

  try {
    const tokenResponse = await axios.post(
      'https://oauth2.googleapis.com/token',
      {
        code: code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: googleRedirectUri,
        grant_type: 'authorization_code',
      }
    );

    const accessToken = tokenResponse.data.access_token;
    const refreshToken = tokenResponse.data.refresh_token;
    const expiresIn = tokenResponse.data.expires_in;

    // Get Google user info
    const userInfo = await axios.get(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const googleUserId = userInfo.data.id; // 'id' is stable identifier for the user

    // Store tokens in DB
    await storeTokens(
      'google',
      googleUserId,
      accessToken,
      refreshToken,
      expiresIn
    );

    // Store user in session
    req.session.user = { provider: 'google', user_id: googleUserId };
    res.redirect('http://localhost:3000');
  } catch (error) {
    console.error(
      'Error fetching Google tokens:',
      error.response?.data || error.message
    );
    res.status(500).send('Error exchanging code for token.');
  }
});

app.get('/api/google/status', async (req, res) => {
  if (!req.session.user || req.session.user.provider !== 'google')
    return res.json({ connected: false });
  const tokens = await ensureTokens('google', req.session.user.user_id);
  res.json({ connected: !!tokens });
});

app.get('/api/google/recordings', async (req, res) => {
  if (!req.session.user || req.session.user.provider !== 'google')
    return res.status(401).send('Not connected to Google');
  const tokens = await ensureTokens('google', req.session.user.user_id);
  if (!tokens) return res.status(401).send('No tokens found');

  try {
    const query = `'${googleFolderId}' in parents and mimeType='video/mp4'`;
    const response = await axios.get(
      'https://www.googleapis.com/drive/v3/files',
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        params: {
          q: query,
          fields:
            'files(id,name,mimeType,createdTime,size,thumbnailLink)',
        },
      }
    );

    res.json({ files: response.data.files });
  } catch (error) {
    console.error(
      'Error fetching Google Drive files:',
      error.response?.data || error.message
    );
    res.status(500).send('Error fetching recordings.');
  }
});

app.get('/api/google/userinfo', async (req, res) => {
  if (!req.session.user || req.session.user.provider !== 'google')
    return res.status(401).send('Not connected to Google');
  const tokens = await ensureTokens('google', req.session.user.user_id);
  if (!tokens) return res.status(401).send('No tokens found');

  try {
    const response = await axios.get(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error(
      'Error fetching Google user info:',
      error.response?.data || error.message
    );
    res.status(500).send('Error fetching Google user info.');
  }
});

// LOGOUT ROUTE
app.get('/api/logout', async (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).send('Error logging out.');
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.listen(4000, () => {
  console.log('Backend server running on http://localhost:4000');
});