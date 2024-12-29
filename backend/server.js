const express = require('express');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const qs = require('querystring');

// ================== ZOOM CONFIG (User-level OAuth) ==================
const zoomClientId = 'pC6fhDfTLmRugGqdAVVhg';
const zoomClientSecret = 'IA6UP6IAIjOkCeVz65DCZA9uLmobC9Gw';
const zoomRedirectUri = 'http://localhost:4000/auth/zoom/callback';

// ================== GOOGLE CONFIG (User-level OAuth) ==================
const googleClientId =
  '160011252982-ukr8itrhhcf1h0f98hhht83i2dradpel.apps.googleusercontent.com';
const googleClientSecret = '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';
const googleRedirectUri = 'http://localhost:4000/auth/google/callback';
const googleScope =
  'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';

// Create an Express app
const app = express();

// Enable CORS with specific origin and credentials
app.use(
  cors({
    origin: 'http://localhost:3000', // Allow requests only from your frontend
    credentials: true, // Allow cookies to be sent
  })
);

// Session middleware
app.use(
  session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // Set to true if using HTTPS
      httpOnly: true,
      sameSite: 'lax', // Recommended for security
    },
  })
);

// Global DB reference
let db;

// Database initialization
(async () => {
  db = await open({
    filename: path.join(__dirname, 'app.db'),
    driver: sqlite3.Database,
  });
  console.log('Connected to SQLite at app.db');

  // Create users table with modified schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT,
      password TEXT NOT NULL,
      zoom_user_id TEXT UNIQUE,
      access_token TEXT,
      refresh_token TEXT,
      token_expiry INTEGER,
      google_user_id TEXT UNIQUE,
      google_access_token TEXT,
      google_refresh_token TEXT,
      google_token_expiry INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );
  `);

  // Create recordings table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      user_id TEXT NOT NULL,
      meeting_id TEXT,
      recording_id TEXT,
      topic TEXT,
      start_time INTEGER,
      download_url TEXT,
      created_at INTEGER
    );
  `);

  console.log('Database tables created successfully');
})().catch((err) => {
  console.error('Failed to set up DB:', err);
  process.exit(1);
});

// ================== Helper Functions ==================
function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

function futureEpoch(expiresIn) {
  return nowEpoch() + expiresIn;
}

async function updateUserTimestamp(id) {
  await db.run(
    `UPDATE users
       SET updated_at = ?
     WHERE id = ?`,
    [nowEpoch(), id]
  );
}

function validateUserData(data) {
  const { userId, name, email, provider } = data;

  const errors = [];
  if (!userId) errors.push(`${provider} User ID is required`);

  return {
    isValid: errors.length === 0,
    errors,
    sanitizedData: {
      userId,
      name: name?.trim() || `${provider} User`,
      email:
        email?.trim() ||
        `<span class="math-inline">\{provider\.toLowerCase\(\)\}\_</span>{userId}@placeholder.com`,
    },
  };
}

// ================== User Data Storage ==================
async function storeZoomUserData(zoomUserId, firstName, lastName, email) {
  const validation = validateUserData({
    userId: zoomUserId,
    name: `${firstName || ''} ${lastName || ''}`.trim(),
    email,
    provider: 'Zoom',
  });

  if (!validation.isValid) {
    throw new Error(validation.errors.join(', '));
  }

  const { name: fullName, email: sanitizedEmail } = validation.sanitizedData;

  try {
    const existing = await db.get(
      'SELECT * FROM users WHERE zoom_user_id = ?',
      [zoomUserId]
    );

    if (!existing) {
      await db.run(
        `INSERT INTO users (
          full_name, email, password, zoom_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          fullName,
          sanitizedEmail,
          'zoom123',
          zoomUserId,
          nowEpoch(),
          nowEpoch(),
        ]
      );
    } else {
      await db.run(
        `UPDATE users
         SET full_name = ?, email = ?, updated_at = ?
         WHERE zoom_user_id = ?`,
        [fullName, sanitizedEmail, nowEpoch(), zoomUserId]
      );
    }
  } catch (error) {
    console.error('Database error in storeZoomUserData:', error);
    throw new Error(`Failed to store Zoom user data: ${error.message}`);
  }
}

async function storeGoogleUserData(googleUserId, name, email) {
  const validation = validateUserData({
    userId: googleUserId,
    name,
    email,
    provider: 'Google',
  });

  if (!validation.isValid) {
    throw new Error(validation.errors.join(', '));
  }

  const { name: sanitizedName, email: sanitizedEmail } =
    validation.sanitizedData;

  try {
    const existing = await db.get(
      'SELECT * FROM users WHERE google_user_id = ?',
      [googleUserId]
    );

    if (!existing) {
      await db.run(
        `INSERT INTO users (
          full_name, email, password, google_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sanitizedName,
          sanitizedEmail,
          'google123',
          googleUserId,
          nowEpoch(),
          nowEpoch(),
        ]
      );
    } else {
      await db.run(
        `UPDATE users
         SET full_name = ?, email = ?, updated_at = ?
         WHERE google_user_id = ?`,
        [sanitizedName, sanitizedEmail, nowEpoch(), googleUserId]
      );
    }
  } catch (error) {
    console.error('Database error in storeGoogleUserData:', error);
    throw new Error(`Failed to store Google user data: ${error.message}`);
  }
}

// ================== Token Management ==================
async function getUserByZoomId(zoomUserId) {
  return db.get('SELECT * FROM users WHERE zoom_user_id = ?', [zoomUserId]);
}

async function getUserByGoogleId(googleUserId) {
  return db.get('SELECT * FROM users WHERE google_user_id = ?', [googleUserId]);
}

async function storeZoomTokens(
  zoomUserId,
  accessToken,
  refreshToken,
  expiresIn
) {
  if (!zoomUserId || !accessToken) {
    throw new Error('Missing required token data for Zoom');
  }

  const expiry = futureEpoch(expiresIn);
  try {
    const existing = await getUserByZoomId(zoomUserId);
    if (!existing) {
      await db.run(
        `INSERT INTO users (
          full_name, email, password,
          zoom_user_id, access_token, refresh_token, token_expiry,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'Unknown Zoom',
          `zoom_${zoomUserId}@placeholder.com`,
          'zoom123',
          zoomUserId,
          accessToken,
          refreshToken,
          expiry,
          nowEpoch(),
          nowEpoch(),
        ]
      );
    } else {
      await db.run(
        `UPDATE users
         SET access_token = ?,
             refresh_token = ?,
             token_expiry = ?,
             updated_at = ?
         WHERE zoom_user_id = ?`,
        [accessToken, refreshToken, expiry, nowEpoch(), zoomUserId]
      );
    }
  } catch (error) {
    console.error('Error storing Zoom tokens:', error);
    throw new Error(`Failed to store Zoom tokens: ${error.message}`);
  }
}
async function storeGoogleTokens(
  googleUserId,
  accessToken,
  refreshToken,
  expiresIn
) {
  const expiry = futureEpoch(expiresIn);
  try {
    const existing = await getUserByGoogleId(googleUserId);
    if (!existing) {
      await db.run(
        `INSERT INTO users (
          full_name, email, password,
          google_user_id, google_access_token, google_refresh_token, google_token_expiry,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'Unknown Google',
          `google_${googleUserId}@placeholder.com`,
          'google123',
          googleUserId,
          accessToken,
          refreshToken,
          expiry,
          nowEpoch(),
          nowEpoch(),
        ]
      );
    } else {
      await db.run(
        `UPDATE users
         SET google_access_token = ?,
             google_refresh_token = ?,
             google_token_expiry = ?,
             updated_at = ?
         WHERE google_user_id = ?`,
        [accessToken, refreshToken, expiry, nowEpoch(), googleUserId]
      );
    }
  } catch (error) {
    console.error('Error storing Google tokens:', error);
    throw new Error('Failed to store Google tokens');
  }
}

// ================== Token Refresh ==================
async function refreshZoomTokens(refreshToken) {
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);

    const resp = await axios.post('https://zoom.us/oauth/token', params, {
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`<span class="math-inline">\{zoomClientId\}\:</span>{zoomClientSecret}`).toString('base64'),
      },
    });
    return resp.data;
  } catch (error) {
    console.error('Error refreshing Zoom tokens:', error);
    throw new Error('Failed to refresh Zoom tokens');
  }
}

async function refreshGoogleTokens(refreshToken) {
  try {
    const resp = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    return resp.data;
  } catch (error) {
    console.error('Error refreshing Google tokens:', error);
    throw new Error('Failed to refresh Google tokens');
  }
}

async function ensureZoomTokens(zoomUserId) {
  const user = await getUserByZoomId(zoomUserId);
  if (!user) return null;

  const now = nowEpoch();
  const expiry = user.token_expiry || 0;
  if (expiry <= now) {
    if (user.refresh_token) {
      const newTokens = await refreshZoomTokens(user.refresh_token);
      await storeZoomTokens(
        zoomUserId,
        newTokens.access_token,
        newTokens.refresh_token || user.refresh_token,
        newTokens.expires_in
      );
    } else {
      return null;
    }
  }
  return getUserByZoomId(zoomUserId);
}

async function ensureGoogleTokens(googleUserId) {
  const user = await getUserByGoogleId(googleUserId);
  if (!user) return null;

  const now = nowEpoch();
  const expiry = user.google_token_expiry || 0;
  if (expiry <= now) {
    if (user.google_refresh_token) {
      const newTokens = await refreshGoogleTokens(user.google_refresh_token);
      await storeGoogleTokens(
        googleUserId,
        newTokens.access_token,
        newTokens.refresh_token || user.google_refresh_token,
        newTokens.expires_in
      );
    } else {
      return null;
    }
  }
  return getUserByGoogleId(googleUserId);
}
// =========== LOGOUT ===========
app.get('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).send('Error logging out.');
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});
// ================== Recordings Management ==================
async function storeRecordings(provider, userId, items) {
  if (!items || !items.length) return;

  for (const item of items) {
    try {
      if (provider === 'zoom') {
        const meetingId = item.id;
        const topic = item.topic || null;
        const startTimeSec = item.start_time
          ? Math.floor(new Date(item.start_time).getTime() / 1000)
          : null;

        for (const file of item.recording_files || []) {
          await db.run(
            `INSERT OR REPLACE INTO recordings (
              provider, user_id, meeting_id, recording_id,
              topic, start_time, download_url, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              'zoom',
              userId,
              meetingId,
              file.id,
              topic,
              startTimeSec,
              file.download_url || null,
              nowEpoch(),
            ]
          );
        }
      } else if (provider === 'google') {
        const fileId = item.id;
        const fileName = item.name || null;
        const createdTimeSec = item.createdTime
          ? Math.floor(new Date(item.createdTime).getTime() / 1000)
          : null;

        await db.run(
          `INSERT OR REPLACE INTO recordings (
            provider, user_id, meeting_id, recording_id,
            topic, start_time, download_url, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'google',
            userId,
            fileId,
            '',
            fileName,
            createdTimeSec,
            item.webContentLink || null,
            nowEpoch(),
          ]
        );
      }
    } catch (error) {
      console.error(`Error storing ${provider} recording:`, error);
    }
  }
}

// ================== Auth Routes ==================
app.get('/auth/zoom', (req, res) => {
  const authorizationUrl = `https://zoom.us/oauth/authorize?response_type=code&client_id=${zoomClientId}&redirect_uri=${encodeURIComponent(
    zoomRedirectUri
  )}`;
  res.redirect(authorizationUrl);
});


app.get('/auth/google', (req, res) => {
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    `client_id=${googleClientId}&` +
    `redirect_uri=${encodeURIComponent(googleRedirectUri)}&` +
    `scope=${encodeURIComponent(googleScope)}&` +
    'response_type=code&' +
    'access_type=offline&' +
    'prompt=consent';
  res.redirect(authUrl);
});
app.get('/auth/zoom/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    console.error('No authorization code received from Zoom');
    return res.status(400).send('No code returned from Zoom');
  }

  try {
    // Create proper form data
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', zoomRedirectUri);

    // Make token request with proper headers
    const tokenResp = await axios.post(
      'https://zoom.us/oauth/token',
      params, {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${zoomClientId}:${zoomClientSecret}`
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    // Validate token response
    if (!tokenResp.data || !tokenResp.data.access_token) {
      console.error('Invalid token response from Zoom:', tokenResp.data);
      return res.status(500).send('Invalid token response from Zoom');
    }

    const { access_token, refresh_token, expires_in } = tokenResp.data;

    // Get user info with new token
    const userInfo = await axios.get('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userInfo.data || !userInfo.data.id) {
      console.error('Invalid user info response from Zoom:', userInfo.data);
      return res.status(500).send('Invalid user info from Zoom');
    }

    const { id: zoomUserId, first_name, last_name, email } = userInfo.data;

    // Store user data and tokens
    await storeZoomUserData(zoomUserId, first_name, last_name, email);
    await storeZoomTokens(zoomUserId, access_token, refresh_token, expires_in);

    req.session.user = { zoom_user_id: zoomUserId, provider: 'zoom' };
    res.redirect('http://localhost:3000');
  } catch (err) {
    console.error('Zoom authentication error:', {
      message: err.message,
      response: err.response?.data,
      stack: err.stack,
    });
    res.status(500).send('Error during Zoom authentication');
  }
});

// Updated Google callback route
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    console.error('No authorization code received from Google');
    return res.status(400).send('No code returned from Google');
  }

  try {
    const params = new URLSearchParams();
    params.append('code', code);
    params.append('client_id', googleClientId);
    params.append('client_secret', googleClientSecret);
    params.append('redirect_uri', googleRedirectUri);
    params.append('grant_type', 'authorization_code');

    const tokenResp = await axios.post(
      'https://oauth2.googleapis.com/token',
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    // Validate token response
    if (!tokenResp.data || !tokenResp.data.access_token) {
      console.error('Invalid token response from Google:', tokenResp.data);
      return res.status(500).send('Invalid token response from Google');
    }

    const { access_token, refresh_token, expires_in } = tokenResp.data;

    // Get user info with new token
    const userInfo = await axios.get(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );

    if (!userInfo.data || !userInfo.data.id) {
      console.error('Invalid user info response from Google:', userInfo.data);
      return res.status(500).send('Invalid user info from Google');
    }

    const { id: googleUserId, name, email } = userInfo.data;

    // Store user data and tokens
    await storeGoogleUserData(googleUserId, name, email);
    await storeGoogleTokens(
      googleUserId,
      access_token,
      refresh_token,
      expires_in
    );

    req.session.user = { google_user_id: googleUserId, provider: 'google' };
    res.redirect('http://localhost:3000');
  } catch (err) {
    console.error('Google authentication error:', {
      message: err.message,
      response: err.response?.data,
      stack: err.stack,
    });
    res.status(500).send('Error during Google authentication');
  }
});
// ================== Status Routes ==================
app.get('/api/zoom/status', async (req, res) => {
  if (!req.session.user?.zoom_user_id) {
    return res.json({ connected: false });
  }
  const user = await getUserByZoomId(req.session.user.zoom_user_id);
  res.json({ connected: !!user?.access_token });
});

app.get('/api/google/status', async (req, res) => {
  if (!req.session.user?.google_user_id) {
    return res.json({ connected: false });
  }
  const user = await getUserByGoogleId(req.session.user.google_user_id);
  res.json({ connected: !!user?.google_access_token });
});

// ================== Recording Routes ==================
app.get('/api/zoom/recordings', async (req, res) => {
  if (!req.session.user?.zoom_user_id) {
    return res.status(401).send('Not connected to Zoom');
  }

  try {
    const user = await ensureZoomTokens(req.session.user.zoom_user_id);
    if (!user?.access_token) {
      return res.status(401).send('No valid Zoom tokens');
    }

    const resp = await axios.get(
      'https://api.zoom.us/v2/users/me/recordings',
      {
        headers: { Authorization: `Bearer ${user.access_token}` },
        params: {
          from: '2023-01-01',
          to: '2024-12-31',
          page_size: 30,
        },
      }
    );

    if (resp.data.meetings?.length) {
      await storeRecordings('zoom', user.zoom_user_id, resp.data.meetings);
    }
    res.json(resp.data);
  } catch (err) {
    console.error(
      'Error fetching Zoom recordings:',
      err.response?.data || err.message
    );
    res.status(500).send('Error fetching Zoom recordings');
  }
});

app.get('/api/google/recordings', async (req, res) => {
  if (!req.session.user?.google_user_id) {
    return res.status(401).send('Not connected to Google');
  }

  try {
    const user = await ensureGoogleTokens(req.session.user.google_user_id);
    if (!user?.google_access_token) {
      return res.status(401).send('No valid Google tokens');
    }

    // Search for Meet Recordings folder
    const folderSearch = await axios.get(
      'https://www.googleapis.com/drive/v3/files',
      {
        headers: { Authorization: `Bearer ${user.google_access_token}` },
        params: {
          q: "name = 'Meet Recordings' and mimeType = 'application/vnd.google-apps.folder' and trashed=false",
          fields: 'files(id,name)',
        },
      }
    );

    if (!folderSearch.data.files?.length) {
      return res.json({ files: [] });
    }

    const meetFolderId = folderSearch.data.files[0].id;

    // List MP4 files
    const filesResp = await axios.get(
      'https://www.googleapis.com/drive/v3/files',
      {
        headers: { Authorization: `Bearer ${user.google_access_token}` },
        params: {
          q: `'${meetFolderId}' in parents and mimeType='video/mp4' and trashed=false`,
          fields:
            'files(id,name,createdTime,size,thumbnailLink,webContentLink)',
        },
      }
    );

    const files = filesResp.data.files || [];
    if (files.length) {
      await storeRecordings('google', user.google_user_id, files);
    }
    res.json({ files });
  } catch (err) {
    console.error(
      'Error fetching Google recordings:',
      err.response?.data || err.message
    );
    res.status(500).send('Error fetching Google recordings');
  }
});

// ================== User Info Routes ==================
app.get('/api/zoom/userinfo', async (req, res) => {
  if (!req.session.user?.zoom_user_id) {
    return res.status(401).send('Not connected to Zoom');
  }

  try {
    const user = await ensureZoomTokens(req.session.user.zoom_user_id);
    if (!user?.access_token) {
      return res.status(401).send('No valid Zoom tokens');
    }

    const resp = await axios.get('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${user.access_token}` },
    });
    res.json(resp.data);
  } catch (err) {
    console.error(
      'Error fetching Zoom user info:',
      err.response?.data || err.message
    );
    res.status(500).send('Error fetching Zoom user info');
  }
});

app.get('/api/google/userinfo', async (req, res) => {
  if (!req.session.user?.google_user_id) {
    return res.status(401).send('Not connected to Google');
  }

  try {
    const user = await ensureGoogleTokens(req.session.user.google_user_id);
    if (!user?.google_access_token) {
      return res.status(401).send('No valid Google tokens');
    }

    const resp = await axios.get(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${user.google_access_token}` },
      }
    );
    res.json(resp.data);
  } catch (err) {
    console.error(
      'Error fetching Google user info:',
      err.response?.data || err.message
    );
    res.status(500).send('Error fetching Google user info');
  }
});

// ================== Video Streaming Routes (Corrected) ==================
app.get('/api/zoom/embed', async (req, res) => {
  const { url } = req.query;
  console.log("Received request for:", url);

  if (!url) {
    return res.status(400).send('No URL provided');
  }

  try {
    const decodedUrl = decodeURIComponent(url);
    console.log("Decoded URL:", decodedUrl);

    const response = await axios.get(decodedUrl, {
      responseType: 'stream',
    });

    console.log("Response Headers from Zoom:", response.headers);

    // No need to get or set Content-Length

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline');
    // No need to set Content-Length 

    response.data.pipe(res);
  } catch (err) {
    console.error('Error streaming Zoom recording:', err);
    res.status(500).send('Error streaming recording');
  }
});
app.get('/api/zoom/proxy', async (req, res) => {
  const { zoomRecordingUrl } = req.query; // Get the encoded download URL from the query parameters

  if (!zoomRecordingUrl) {
    return res.status(400).send('No Zoom recording URL provided');
  }

  try {
    const decodedUrl = decodeURIComponent(zoomRecordingUrl); // Decode the URL

    // 1. Get the user's Zoom access token (IMPORTANT: Adapt this to your token storage)
    const user = await ensureZoomTokens(req.session.user?.zoom_user_id);
    if (!user || !user.access_token) {
      return res.status(401).send('No valid Zoom tokens');
    }

    // 2. Make a request to Zoom with the user's access token and stream the response
    const zoomResponse = await axios.get(decodedUrl, {
      headers: {
        Authorization: `Bearer ${user.access_token}`, // Include authorization header
        // Add any other required headers for Zoom here
      },
      responseType: 'stream', // Important for streaming
    });

    // 3. Set headers for streaming the video to the frontend
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Transfer-Encoding', 'chunked'); // Set explicitly for clarity

    // 4. Pipe (stream) the response from Zoom to the frontend response
    zoomResponse.data.pipe(res);
  } catch (err) {
    console.error('Error proxying Zoom recording:', err);
    res.status(500).send('Error proxying Zoom recording');
  }
});
app.get('/api/google/embed', async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) {
    return res.status(400).send('No file ID provided');
  }

  try {
    const user = await ensureGoogleTokens(req.session.user?.google_user_id);
    if (!user?.google_access_token) {
      return res.status(401).send('No valid Google tokens');
    }

    const response = await axios.get(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${user.google_access_token}`,
        },
        responseType: 'stream',
      }
    );

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline');

    response.data.pipe(res);
  } catch (err) {
    console.error('Error streaming Google recording:', err);
    res.status(500).send('Error streaming recording');
  }
});

// ================== Logout Route ==================
app.get('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).send('Error logging out');
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.listen(4000, () => {
  console.log('Backend server running on http://localhost:4000');
});