// Extract token from URL
const token = new URLSearchParams(window.location.search).get('token');
console.log('Token from URL:', token);

if (!token) {
  console.error('No token found in URL, redirecting to login');
  alert('Please log in!');
  window.location.href = '/';
}

async function fetchWithToken(url, options = {}) {
  console.log('Fetching URL:', url, 'with token:', token);
  try {
    const response = await fetch(url, {
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : null
    });
    console.log('Fetch response status:', response.status);
    if (!response.ok) {
      const text = await response.text();
      console.error('Fetch failed with status:', response.status, 'Response text:', text);
      throw new Error(`Fetch failed: ${response.status} - ${text}`);
    }
    const data = await response.json();
    console.log('Fetch succeeded, data:', data);
    return data;
  } catch (error) {
    console.error('Fetch error:', error);
    throw error;
  }
}

async function loadUserData() {
  console.log('Starting loadUserData...');
  try {
    const data = await fetchWithToken('/api/user');
    console.log('User data received:', data);

    if (!data.userId || !data.username || !data.avatar) {
      throw new Error('Invalid user data: ' + JSON.stringify(data));
    }

    // Store user data
    window.userData = {
      userId: data.userId,
      username: data.username,
      avatar: data.avatar,
      balance: typeof data.balance === 'number' ? data.balance : 0,
      walletId: data.walletId
    };

    // Update DOM
    const avatarEl = document.getElementById('avatar');
    const avatarUrl = userData.avatar ? `${userData.avatar}?t=${Date.now()}` : 'https://via.placeholder.com/40';
    console.log('Setting avatar URL:', avatarUrl);
    avatarEl.removeAttribute('src'); // Clear previous src
    avatarEl.src = avatarUrl;
    avatarEl.onload = () => console.log('Avatar loaded successfully:', avatarEl.src);
    avatarEl.onerror = () => {
      console.warn('Avatar failed to load, switching to fallback:', avatarUrl);
      avatarEl.src = 'https://via.placeholder.com/40';
    };

    const usernameEl = document.getElementById('username');
    console.log('Setting username:', userData.username);
    usernameEl.textContent = userData.username || 'Unknown';

    const discordIdEl = document.getElementById('discord-id');
    console.log('Setting Discord ID:', userData.userId);
    discordIdEl.textContent = `ID: ${userData.userId}`;

    const balanceEl = document.getElementById('balance-amount');
    console.log('Setting balance:', userData.balance);
    balanceEl.textContent = `${userData.balance} USDT`;

    console.log('DOM updated - Avatar:', avatarEl.src, 'Username:', usernameEl.textContent, 'Balance:', balanceEl.textContent);
  } catch (error) {
    console.error('Error in loadUserData:', error);
    document.getElementById('username').textContent = 'Error Loading';
    document.getElementById('avatar').src = 'https://via.placeholder.com/40';
    document.getElementById('balance-amount').textContent = '0 USDT';
    alert('Failed to load user data: ' + error.message);
  }
}

function logout() {
  console.log('Logging out...');
  localStorage.clear();
  window.location.href = '/';
}

// Start the process
console.log('Initializing dashboard...');
loadUserData();
