const express = require('express');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');

const zoomClientId = 'ares8dVjRtCeXcBUakCwhw';
const zoomClientSecret = 'S62trRukaSlzokhUsrJxniLKjmVtZirL';
const redirectUri = 'http://localhost:4000/auth/zoom/callback';

const app = express();

// Enable CORS for the frontend at http://localhost:3000 and allow credentials (cookies)
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));

app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // set to true if using HTTPS
    httpOnly: true,
    sameSite: 'lax'
  }
}));

app.get('/auth/zoom', (req, res) => {
  const authorizationUrl = `https://zoom.us/oauth/authorize?response_type=code&client_id=${zoomClientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
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
        redirect_uri: redirectUri
      },
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${zoomClientId}:${zoomClientSecret}`).toString('base64')
      }
    });

    req.session.zoomTokens = {
      accessToken: tokenResponse.data.access_token,
      refreshToken: tokenResponse.data.refresh_token
    };

    // Redirect back to frontend
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

app.listen(4000, () => {
  console.log('Backend server running on http://localhost:4000');
});
