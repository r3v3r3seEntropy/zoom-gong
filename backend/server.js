const express = require('express');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');

/////////////////////////////////////////////
// ZOOM CONFIG
/////////////////////////////////////////////
const zoomClientId = 'pC6fhDfTLmRugGqdAVVhg';
const zoomClientSecret = 'IA6UP6IAIjOkCeVz65DCZA9uLmobC9Gw';
const zoomRedirectUri = 'http://localhost:4000/auth/zoom/callback';

/////////////////////////////////////////////
// GOOGLE CONFIG
/////////////////////////////////////////////
const googleClientId = '160011252982-lced0v3c9inj6cqkcoihlc7tlgbfbjkk.apps.googleusercontent.com';
const googleClientSecret = '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';
const googleRedirectUri = 'http://localhost:4000/auth/google/callback';

// Replace this with the actual Folder ID for your Meet Recordings folder in Drive
const googleFolderId = '1NMTnL3-QLCmucR_X2JMNifHI5SaHsxm3'; 

const app = express();

// Enable CORS from frontend, allow credentials
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));

app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, 
    httpOnly: true,
    sameSite: 'lax'
  }
}));

//////////////////////
// ZOOM AUTH ROUTES
//////////////////////
app.get('/auth/zoom', (req, res) => {
  const authorizationUrl = `https://zoom.us/oauth/authorize?response_type=code&client_id=${zoomClientId}&redirect_uri=${encodeURIComponent(zoomRedirectUri)}`;
  res.redirect(authorizationUrl);
});

app.get('/auth/zoom/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code returned from Zoom');

  try {
    const tokenResponse = await axios.post('https://zoom.us/oauth/token', null, {
      params: {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: zoomRedirectUri
      },
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${zoomClientId}:${zoomClientSecret}`).toString('base64')
      }
    });

    req.session.zoomTokens = {
      accessToken: tokenResponse.data.access_token,
      refreshToken: tokenResponse.data.refresh_token
    };

    res.redirect('http://localhost:3000');
  } catch (error) {
    console.error('Error fetching Zoom tokens:', error.response?.data || error.message);
    res.status(500).send('Error exchanging code for token.');
  }
});

app.get('/api/zoom/status', (req, res) => {
  const connected = !!(req.session.zoomTokens && req.session.zoomTokens.accessToken);
  res.json({ connected });
});

app.get('/api/zoom/recordings', async (req, res) => {
  if (!req.session.zoomTokens || !req.session.zoomTokens.accessToken) {
    return res.status(401).send('Not connected to Zoom');
  }

  try {
    const response = await axios.get('https://api.zoom.us/v2/users/me/recordings', {
      headers: {
        Authorization: `Bearer ${req.session.zoomTokens.accessToken}`
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Zoom recordings:', error.response?.data || error.message);
    res.status(500).send('Error fetching recordings.');
  }
});

//////////////////////
// GOOGLE AUTH ROUTES
//////////////////////
app.get('/auth/google', (req, res) => {
  const authorizationUrl = 
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    `response_type=code&` +
    `client_id=${googleClientId}&` +
    `redirect_uri=${encodeURIComponent(googleRedirectUri)}&` +
    `scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.readonly')}&` +
    `access_type=offline&` +
    `prompt=consent`;

  res.redirect(authorizationUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code returned from Google');

  try {
    const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
      code: code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: googleRedirectUri,
      grant_type: 'authorization_code'
    });

    req.session.googleTokens = {
      accessToken: tokenResponse.data.access_token,
      refreshToken: tokenResponse.data.refresh_token
    };

    // Redirect back to frontend
    res.redirect('http://localhost:3000');
  } catch (error) {
    console.error('Error fetching Google tokens:', error.response?.data || error.message);
    res.status(500).send('Error exchanging code for token.');
  }
});

app.get('/api/google/status', (req, res) => {
  const connected = !!(req.session.googleTokens && req.session.googleTokens.accessToken);
  res.json({ connected });
});

app.get('/api/google/recordings', async (req, res) => {
  if (!req.session.googleTokens || !req.session.googleTokens.accessToken) {
    return res.status(401).send('Not connected to Google');
  }

  const accessToken = req.session.googleTokens.accessToken;

  try {
    // Query for videos in a specific folder (Google Meet recordings folder).
    // This query finds all MP4 videos in the specified folder.
    const query = `'${googleFolderId}' in parents and mimeType='video/mp4'`;
    const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        q: query,
        fields: 'files(id,name,mimeType,createdTime,size,thumbnailLink)'
      }
    });

    res.json({ files: response.data.files });
  } catch (error) {
    console.error('Error fetching Google Drive files:', error.response?.data || error.message);
    res.status(500).send('Error fetching recordings.');
  }
});

//////////////////////
// LOGOUT ROUTE
//////////////////////
app.get('/api/logout', (req, res) => {
  req.session.destroy(err => {
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
