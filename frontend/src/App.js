import React, { useState, useEffect } from 'react';
import axios from 'axios';

// Configure axios globally
axios.defaults.withCredentials = true;

const App = () => {
  const [connectedToZoom, setConnectedToZoom] = useState(false);
  const [recordings, setRecordings] = useState([]);

  useEffect(() => {
    checkZoomStatus();
  }, []);

  const checkZoomStatus = async () => {
    try {
      const response = await axios.get('http://localhost:4000/api/zoom/status');
      if (response.data.connected) {
        setConnectedToZoom(true);
        fetchRecordings();
      }
    } catch (error) {
      console.error('Error checking Zoom status:', error);
    }
  };

  const handleConnectZoom = () => {
    window.location.href = 'http://localhost:4000/auth/zoom';
  };

  const fetchRecordings = async () => {
    try {
      const response = await axios.get('http://localhost:4000/api/zoom/recordings');
      setRecordings(response.data.meetings || []);
    } catch (error) {
      console.error('Error fetching recordings:', error);
    }
  };

  return (
    <div style={styles.appContainer}>
      <div style={styles.sidebar}>
        <h1 style={styles.logo}>My App</h1>
        <button
          style={{
            ...styles.connectButton,
            backgroundColor: connectedToZoom ? '#4CAF50' : '#0e71eb'
          }}
          onClick={handleConnectZoom}
          disabled={connectedToZoom}
        >
          {connectedToZoom ? 'Connected to Zoom' : 'Connect with Zoom'}
        </button>

        <nav style={styles.nav}>
          <a href="#profile" style={styles.navLink}>Profile</a>
          {connectedToZoom && <a href="#recordings" style={styles.navLink}>Recordings</a>}
        </nav>
      </div>

      <div style={styles.mainContent}>
        <div style={styles.profileHeader}>
          <div style={styles.profileInfo}>
            <img
              src="https://via.placeholder.com/40"
              alt="User Avatar"
              style={styles.avatar}
            />
            <div>
              <h2 style={styles.userName}>Aritra Das</h2>
              <p style={styles.planInfo}>Current Plan: Workplace Basic</p>
            </div>
          </div>
        </div>

        <div style={styles.bodyContent}>
          <div style={styles.card}>
            <h3>Welcome to Your Dashboard</h3>
            <p>Here you can access your profile settings and view recordings once connected to Zoom.</p>
          </div>
          <div style={styles.card}>
            <h3>Upgrade Your Plan</h3>
            <p>Explore new features by upgrading to the Pro plan.</p>
            <button style={styles.button}>View Plans</button>
          </div>

          {connectedToZoom && (
            <div style={styles.card}>
              <h3>Your Zoom Recordings</h3>
              {recordings.length === 0 ? (
                <p>No recordings found.</p>
              ) : (
                <ul>
                  {recordings.map((recording) => (
                    <li key={recording.uuid}>
                      {recording.topic} - {new Date(recording.start_time).toLocaleString()}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const styles = {
  appContainer: {
    display: 'flex',
    fontFamily: 'sans-serif',
    height: '100vh',
    backgroundColor: '#f6f6f6'
  },
  sidebar: {
    width: '220px',
    backgroundColor: '#ffffff',
    borderRight: '1px solid #ddd',
    display: 'flex',
    flexDirection: 'column',
    padding: '20px 0',
    alignItems: 'center'
  },
  logo: {
    textAlign: 'center',
    fontSize: '1.2rem',
    marginBottom: '40px',
    color: '#333'
  },
  connectButton: {
    width: '80%',
    padding: '10px 0',
    border: 'none',
    borderRadius: '4px',
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: '1rem',
    marginBottom: '20px'
  },
  nav: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    marginTop: '20px'
  },
  navLink: {
    display: 'block',
    padding: '10px 20px',
    textDecoration: 'none',
    color: '#333',
    margin: '5px 0'
  },
  mainContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    padding: '20px'
  },
  profileHeader: {
    backgroundColor: '#ffffff',
    padding: '20px',
    borderRadius: '8px',
    marginBottom: '20px',
    display: 'flex',
    alignItems: 'center'
  },
  profileInfo: {
    display: 'flex',
    alignItems: 'center'
  },
  avatar: {
    borderRadius: '50%',
    width: '40px',
    height: '40px',
    marginRight: '15px'
  },
  userName: {
    fontSize: '1.1rem',
    margin: '0 0 5px 0',
    color: '#333'
  },
  planInfo: {
    margin: 0,
    fontSize: '0.9rem',
    color: '#666'
  },
  bodyContent: {
    flex: 1,
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gridGap: '20px'
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    padding: '20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
  },
  button: {
    marginTop: '10px',
    padding: '8px 12px',
    border: 'none',
    backgroundColor: '#0e71eb',
    color: '#fff',
    borderRadius: '4px',
    cursor: 'pointer'
  }
};

export default App;
