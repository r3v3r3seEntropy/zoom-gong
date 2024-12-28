// server.js

const express = require('express');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

// ================== ZOOM CONFIG (User-level OAuth) ==================
const zoomClientId = 'pC6fhDfTLmRugGqdAVVhg';
const zoomClientSecret = 'IA6UP6IAIjOkCeVz65DCZA9uLmobC9Gw';
const zoomRedirectUri = 'http://localhost:4000/auth/zoom/callback';

// ================== GOOGLE CONFIG (User-level OAuth) ==================
const googleClientId = '160011252982-lced0v3c9inj6cqkcoihlc7tlgbfbjkk.apps.googleusercontent.com';
const googleClientSecret = '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';
const googleRedirectUri = 'http://localhost:4000/auth/google/callback';
const googleScope =
  'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.profile';

// Create an Express app
const app = express();

// Enable CORS so the front-end (e.g. http://localhost:3000) can call us
app.use(
  cors({
    origin: 'http://localhost:3000',
    credentials: true,
  })
);

// Session middleware
app.use(
  session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,   // set true if using HTTPS
      httpOnly: true,
      sameSite: 'lax',
    },
  })
);

// We'll keep a global `db` reference
let db;

// Immediately-invoked async function to open the DB & create tables
(async () => {
  db = await open({
    filename: path.join(__dirname, 'app.db'),
    driver: sqlite3.Database,
  });
  console.log('Connected to SQLite at app.db');

  // Create `users` table if not exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      password TEXT NOT NULL,

      -- Zoom columns
      zoom_user_id TEXT UNIQUE,
      access_token TEXT,
      refresh_token TEXT,
      token_expiry INTEGER,  -- store as a Unix epoch (seconds)

      -- Google columns
      google_user_id TEXT UNIQUE,
      google_access_token TEXT,
      google_refresh_token TEXT,
      google_token_expiry INTEGER,

      created_at INTEGER,
      updated_at INTEGER
    );
  `);

  // Create `recordings` table if not exists
  // We'll store both Zoom & Google in a single table, with `provider` = 'zoom' or 'google'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,   -- 'zoom' or 'google'
      user_id TEXT NOT NULL,    -- for Zoom: zoom_user_id, for Google: google_user_id
      meeting_id TEXT,          -- Zoom meeting_id, or Google file.id
      recording_id TEXT,        -- Zoom file.id or empty for Google
      topic TEXT,               -- Zoom topic or Google file name
      start_time INTEGER,       -- store as Unix epoch
      download_url TEXT,
      created_at INTEGER
    );
  `);

  console.log('Created tables (if they did not exist).');
})().catch((err) => {
  console.error('Failed to set up DB:', err);
});

// ================== Helper Functions ================== //

// Return current epoch time (seconds)
function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

// Return future epoch time after `expiresIn` seconds
function futureEpoch(expiresIn) {
  return nowEpoch() + expiresIn;
}

// Quick function to update the user record's updated_at
async function updateUserTimestamp(id) {
  await db.run(
    `UPDATE users
       SET updated_at = ?
     WHERE id = ?`,
    [nowEpoch(), id]
  );
}

// =========== Storing Real Zoom User Info ===========
async function storeZoomUserData(zoomUserId, firstName, lastName, email) {
  // We'll store "full_name" = "FirstName LastName", "email", password = 'zoom123' (just a placeholder)
  // If row doesn't exist, we insert. If it does, we update.
  const existing = await db.get('SELECT * FROM users WHERE zoom_user_id = ?', [zoomUserId]);
  const fullName = `${firstName || ''} ${lastName || ''}`.trim();

  if (!existing) {
    // Insert
    await db.run(
      `INSERT INTO users (
        full_name, email, password,
        zoom_user_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [fullName, email, 'zoom123', zoomUserId, nowEpoch(), nowEpoch()]
    );
  } else {
    // Update
    await db.run(
      `UPDATE users
         SET full_name = ?,
             email = ?,
             updated_at = ?
       WHERE zoom_user_id = ?`,
      [fullName, email, nowEpoch(), zoomUserId]
    );
  }
}

// =========== Storing Real Google User Info ===========
async function storeGoogleUserData(googleUserId, name, email) {
  // We'll store "full_name" = name, email = email, password = 'google123'
  const existing = await db.get('SELECT * FROM users WHERE google_user_id = ?', [googleUserId]);
  if (!existing) {
    await db.run(
      `INSERT INTO users (
        full_name, email, password,
        google_user_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, email, 'google123', googleUserId, nowEpoch(), nowEpoch()]
    );
  } else {
    await db.run(
      `UPDATE users
         SET full_name = ?,
             email = ?,
             updated_at = ?
       WHERE google_user_id = ?`,
      [name, email, nowEpoch(), googleUserId]
    );
  }
}

// Zoom: get user by zoom_user_id
async function getUserByZoomId(zoomUserId) {
  return db.get('SELECT * FROM users WHERE zoom_user_id = ?', [zoomUserId]);
}

// Zoom: store tokens
async function storeZoomTokens(zoomUserId, accessToken, refreshToken, expiresIn) {
  const expiry = futureEpoch(expiresIn);

  const existing = await getUserByZoomId(zoomUserId);
  if (!existing) {
    // Insert minimal row if not exist
    await db.run(
      `INSERT INTO users (
        full_name, email, password,
        zoom_user_id, access_token, refresh_token, token_expiry,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'Unknown Zoom',       // full_name placeholder
        'zoom@example.com',   // email placeholder
        'zoom123',            // password placeholder
        zoomUserId,
        accessToken,
        refreshToken,
        expiry,
        nowEpoch(),
        nowEpoch(),
      ]
    );
  } else {
    // Update
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
}

// Zoom: refresh tokens
async function refreshZoomTokens(refreshToken) {
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);

  const resp = await axios.post('https://zoom.us/oauth/token', params, {
    headers: {
      Authorization:
        'Basic ' + Buffer.from(`${zoomClientId}:${zoomClientSecret}`).toString('base64'),
    },
  });
  return resp.data; // { access_token, refresh_token, expires_in, ... }
}

// Zoom: ensure tokens
async function ensureZoomTokens(zoomUserId) {
  const user = await getUserByZoomId(zoomUserId);
  if (!user) return null;

  const now = nowEpoch();
  const expiry = user.token_expiry || 0;
  if (expiry <= now) {
    // token expired, refresh
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
  // Return updated
  return getUserByZoomId(zoomUserId);
}

// =========== Google ===========

async function getUserByGoogleId(googleUserId) {
  return db.get('SELECT * FROM users WHERE google_user_id = ?', [googleUserId]);
}

async function storeGoogleTokens(googleUserId, accessToken, refreshToken, expiresIn) {
  const expiry = futureEpoch(expiresIn);

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
        'google@example.com',
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
}

async function refreshGoogleTokens(refreshToken) {
  const resp = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: googleClientId,
    client_secret: googleClientSecret,
    refresh_token,
    grant_type: 'refresh_token',
  });
  return resp.data; // { access_token, refresh_token, expires_in, ... }
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

// =========== Recordings ===========

async function storeRecordings(provider, userId, items) {
  if (!items || !items.length) return;

  for (const item of items) {
    if (provider === 'zoom') {
      const meetingId = item.id;
      const topic = item.topic || null;
      const startTimeSec = item.start_time
        ? Math.floor(new Date(item.start_time).getTime() / 1000)
        : null;

      for (const file of item.recording_files || []) {
        await db.run(
          `INSERT INTO recordings (
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
        `INSERT INTO recordings (
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
          null, // or item.webContentLink
          nowEpoch(),
        ]
      );
    }
  }
}

// ================== ZOOM AUTH ROUTES ==================
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
    // Exchange code -> tokens
    const tokenResp = await axios.post('https://zoom.us/oauth/token', null, {
      params: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: zoomRedirectUri,
      },
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${zoomClientId}:${zoomClientSecret}`).toString('base64'),
      },
    });
    const { access_token, refresh_token, expires_in } = tokenResp.data;

    // Get Zoom user info
    const userInfo = await axios.get('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { id: zoomUserId, first_name, last_name, email } = userInfo.data;

    // 1) Store real user info (full_name, email)
    await storeZoomUserData(zoomUserId, first_name, last_name, email);

    // 2) Store tokens
    await storeZoomTokens(zoomUserId, access_token, refresh_token, expires_in);

    // Save session
    req.session.user = { zoom_user_id: zoomUserId, provider: 'zoom' };
    res.redirect('http://localhost:3000');
  } catch (err) {
    console.error('Zoom callback error:', err.response?.data || err.message);
    res.status(500).send('Error exchanging Zoom code for token.');
  }
});

app.get('/api/zoom/status', async (req, res) => {
  if (!req.session.user?.zoom_user_id) {
    return res.json({ connected: false });
  }
  const user = await getUserByZoomId(req.session.user.zoom_user_id);
  res.json({ connected: !!user?.access_token });
});

app.get('/api/zoom/recordings', async (req, res) => {
  if (!req.session.user?.zoom_user_id) {
    return res.status(401).send('Not connected to Zoom');
  }
  const user = await ensureZoomTokens(req.session.user.zoom_user_id);
  if (!user || !user.access_token) {
    return res.status(401).send('No valid Zoom tokens');
  }

  try {
    const resp = await axios.get('https://api.zoom.us/v2/users/me/recordings', {
      headers: { Authorization: `Bearer ${user.access_token}` },
      params: {
        from: '2023-01-01',
        to: '2024-12-31',
        page_size: 30,
      },
    });
    if (resp.data.meetings?.length) {
      await storeRecordings('zoom', user.zoom_user_id, resp.data.meetings);
    }
    res.json(resp.data);
  } catch (err) {
    console.error('Error fetching Zoom recordings:', err.response?.data || err.message);
    res.status(500).send('Error fetching recordings.');
  }
});

app.get('/api/zoom/userinfo', async (req, res) => {
  if (!req.session.user?.zoom_user_id) {
    return res.status(401).send('Not connected to Zoom');
  }
  const user = await ensureZoomTokens(req.session.user.zoom_user_id);
  if (!user || !user.access_token) {
    return res.status(401).send('No valid Zoom tokens');
  }

  try {
    const uinfo = await axios.get('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${user.access_token}` },
    });
    res.json(uinfo.data);
  } catch (err) {
    console.error('Error fetching Zoom user info:', err.response?.data || err.message);
    res.status(500).send('Error fetching Zoom user info.');
  }
});

// ================== GOOGLE AUTH ROUTES ==================
app.get('/auth/google', (req, res) => {
  const authorizationUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    `response_type=code&client_id=${googleClientId}&redirect_uri=${encodeURIComponent(
      googleRedirectUri
    )}&scope=${encodeURIComponent(googleScope)}&access_type=offline&prompt=consent`;
  res.redirect(authorizationUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code returned from Google');

  try {
    const tokenResp = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: googleRedirectUri,
      grant_type: 'authorization_code',
    });
    const { access_token, refresh_token, expires_in } = tokenResp.data;

    // Get Google user info
    const uinfoResp = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { id: googleUserId, name, email } = uinfoResp.data;

    // 1) Store real user info
    await storeGoogleUserData(googleUserId, name, email);

    // 2) Store tokens
    await storeGoogleTokens(googleUserId, access_token, refresh_token, expires_in);

    // Save session
    req.session.user = { google_user_id: googleUserId, provider: 'google' };
    res.redirect('http://localhost:3000');
  } catch (err) {
    console.error('Google callback error:', err.response?.data || err.message);
    res.status(500).send('Error exchanging Google code for token.');
  }
});

app.get('/api/google/status', async (req, res) => {
  if (!req.session.user?.google_user_id) {
    return res.json({ connected: false });
  }
  const user = await getUserByGoogleId(req.session.user.google_user_id);
  res.json({ connected: !!user?.google_access_token });
});

app.get('/api/google/recordings', async (req, res) => {
  if (!req.session.user?.google_user_id) {
    return res.status(401).send('Not connected to Google');
  }
  const user = await ensureGoogleTokens(req.session.user.google_user_id);
  if (!user || !user.google_access_token) {
    return res.status(401).send('No valid Google tokens');
  }

  try {
    // Example: find "Meet Recordings" folder, list .mp4 files
    const folderSearch = await axios.get('https://www.googleapis.com/drive/v3/files', {
      headers: { Authorization: `Bearer ${user.google_access_token}` },
      params: {
        q: "name = 'Meet Recordings' and mimeType = 'application/vnd.google-apps.folder' and trashed=false",
        fields: 'files(id,name)',
      },
    });
    if (!folderSearch.data.files || folderSearch.data.files.length === 0) {
      return res.json({ files: [] });
    }
    const meetFolderId = folderSearch.data.files[0].id;

    // List .mp4
    const filesResp = await axios.get('https://www.googleapis.com/drive/v3/files', {
      headers: { Authorization: `Bearer ${user.google_access_token}` },
      params: {
        q: `'${meetFolderId}' in parents and mimeType='video/mp4' and trashed=false`,
        fields: 'files(id, name, createdTime, size, thumbnailLink)',
      },
    });
    const files = filesResp.data.files || [];

    if (files.length) {
      await storeRecordings('google', user.google_user_id, files);
    }
    res.json({ files });
  } catch (err) {
    console.error('Error fetching Google recordings:', err.response?.data || err.message);
    res.status(500).send('Error fetching Google recordings.');
  }
});

app.get('/api/google/userinfo', async (req, res) => {
  if (!req.session.user?.google_user_id) {
    return res.status(401).send('Not connected to Google');
  }
  const user = await ensureGoogleTokens(req.session.user.google_user_id);
  if (!user || !user.google_access_token) {
    return res.status(401).send('No valid Google tokens');
  }

  try {
    const resp = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${user.google_access_token}` },
    });
    res.json(resp.data);
  } catch (err) {
    console.error('Error fetching Google user info:', err.response?.data || err.message);
    res.status(500).send('Error fetching Google user info.');
  }
});

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

// =========== Start the Server ===========
app.listen(4000, () => {
  console.log('Backend server running on http://localhost:4000');
});
