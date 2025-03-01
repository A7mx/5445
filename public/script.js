const token = new URLSearchParams(window.location.search).get('token');
console.log('Token from URL:', token);

if (!token) {
  console.error('No token found, redirecting to login');
  alert('Please log in!');
  window.location.href = '/';
}

const socket = io({ auth: { token } });

let userData = {};
let currentChatId = null;

async function fetchWithToken(url, options = {}) {
  console.log('Fetching:', url, 'with token:', token);
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
    console.log('Response status:', response.status);
    if (!response.ok) {
      const text = await response.text();
      console.error('Fetch failed:', response.status, text);
      throw new Error(`Fetch failed: ${response.status} - ${text}`);
    }
    const data = await response.json();
    console.log('Fetch data:', data);
    return data;
  } catch (error) {
    console.error('Fetch error:', error);
    throw error;
  }
}

async function refreshUserData() {
  try {
    const data = await fetchWithToken('/api/user');
    console.log('Raw user data from /api/user:', data);
    userData = {
      userId: data.userId,
      username: data.username,
      avatar: data.avatar,
      walletId: data.walletId,
      balance: data.balance || 0,  // DIS balance
      friends: data.friends || [],
      pendingFriends: data.pendingFriends || []
    };
    updateUI();
    socket.emit('join', userData.userId);
    updateFriendsList();
  } catch (error) {
    console.error('Error fetching user data:', error);
    showError('Error fetching user data: ' + error.message);
    document.getElementById('username').textContent = 'Error';
    document.getElementById('avatar').src = 'https://via.placeholder.com/40';
    document.getElementById('balance-amount').textContent = '0 DIS';
  }
}

function updateUI() {
  const avatarEl = document.getElementById('avatar');
  const avatarUrl = userData.avatar ? `${userData.avatar}?t=${Date.now()}` : 'https://via.placeholder.com/40';
  console.log('Setting avatar URL:', avatarUrl);
  avatarEl.removeAttribute('src');
  avatarEl.src = avatarUrl;
  avatarEl.onload = () => console.log('Avatar loaded successfully:', avatarEl.src);
  avatarEl.onerror = () => {
    console.warn('Avatar failed to load:', avatarUrl);
    avatarEl.src = 'https://via.placeholder.com/40';
  };

  document.getElementById('username').textContent = userData.username || 'Unknown';
  document.getElementById('discord-id').textContent = `ID: ${userData.userId}`;
  document.getElementById('balance-amount').textContent = `${userData.balance || 0} DIS`;
  document.getElementById('wallet-id').textContent = userData.walletId || 'N/A';
  document.getElementById('dis-balance').textContent = `${userData.balance || 0.000000} DIS`;
}

function updateFriendsList() {
  const friendsList = document.getElementById('friends-list');
  const pendingList = document.getElementById('pending-list');
  friendsList.innerHTML = '';
  pendingList.innerHTML = '';

  (userData.friends || []).forEach(friend => {
    const friendItem = document.createElement('div');
    friendItem.className = 'friend-item';
    friendItem.innerHTML = `
      <img src="${friend.avatar || 'https://via.placeholder.com/40'}" alt="${friend.username}'s Avatar" onerror="this.src='https://via.placeholder.com/40'" title="Click to chat with ${friend.username}">
      <span>${friend.username} (Wallet: ${friend.walletId})</span>
    `;
    friendItem.onclick = () => startChat(friend.id, friend.username);
    friendsList.appendChild(friendItem);
  });

  (userData.pendingFriends || []).forEach(friend => {
    const pendingItem = document.createElement('div');
    pendingItem.className = 'pending-item';
    pendingItem.innerHTML = `
      <img src="${friend.avatar || 'https://via.placeholder.com/40'}" alt="${friend.username}'s Avatar" onerror="this.src='https://via.placeholder.com/40'" title="Pending friend request from ${friend.username}">
      <span>${friend.username} (Wallet: ${friend.walletId})</span>
      <button class="accept" onclick="acceptFriend('${friend.id}')">Accept</button>
      <button class="ignore" onclick="ignoreFriend('${friend.id}')">Ignore</button>
    `;
    pendingList.appendChild(pendingItem);
  });
}

async function updateQRCode() {
  try {
    const ownerWallet = await fetchWithToken('/api/owner-wallet', { method: 'GET' });
    document.getElementById('qr-code').src = ownerWallet.qrCode || 'https://via.placeholder.com/150';
    document.getElementById('withdraw-qr').src = '';
  } catch (error) {
    showError('Error fetching QR code: ' + error.message);
  }
}

refreshUserData();

function toggleUserInfo() {
  document.getElementById('user-info').classList.toggle('hidden');
}

function toggleDeposit() {
  document.getElementById('deposit-option').classList.toggle('hidden');
}

function deposit() {
  showSection('deposit');
}

async function depositFunds() {
  const amount = parseFloat(document.getElementById('deposit-amount').value);
  if (isNaN(amount) || amount <= 0 || amount < 6) {
    showError('Please enter a valid deposit amount of at least 6 DIS.');
    return;
  }
  try {
    const verificationCode = prompt('Enter your 2FA code:');
    if (!verificationCode) {
      showError('Verification required.');
      return;
    }
    const ownerWallet = await fetchWithToken('/api/owner-wallet', { method: 'GET' });
    await fetchWithToken('/api/deposit', { body: { amount, walletId: userData.walletId, verificationCode } });
    await fetchWithToken('/api/pending-deposit', {
      method: 'POST',
      body: { userId: userData.userId, amount, timestamp: new Date().toISOString(), status: 'pending' }
    });
    showSuccess(`Deposit of ${amount} DIS requested. Send ${amount} DIS to: ${ownerWallet.wallet} and await confirmation.`);
    document.getElementById('deposit-amount').value = '';
  } catch (error) {
    showError('Deposit failed: ' + error.message);
  }
}

function showSection(sectionId) {
  document.querySelectorAll('.content-card').forEach(card => card.classList.remove('active'));
  document.getElementById(sectionId).classList.add('active');
  document.querySelectorAll('.header-actions button').forEach(btn => btn.classList.remove('active'));
  document.querySelector(`.header-actions button[onclick="showSection('${sectionId}')"]`).classList.add('active');
}

async function transferFunds() {
  const toWalletId = document.getElementById('transfer-to-wallet').value;
  const amount = parseFloat(document.getElementById('transfer-amount').value);
  if (isNaN(amount) || amount <= 0) {
    showError('Please enter a valid transfer amount.');
    return;
  }
  if (!toWalletId) {
    showError('Please enter a recipient wallet ID.');
    return;
  }
  if (toWalletId === userData.walletId) {
    showError('You cannot transfer money to your own wallet!');
    return;
  }
  try {
    const data = await fetchWithToken('/api/transfer', { body: { toWalletId, amount } });
    showSuccess(data.message);
    refreshUserData();
    document.getElementById('transfer-to-wallet').value = '';
    document.getElementById('transfer-amount').value = '';
  } catch (error) {
    showError('Transfer failed: ' + error.message);
  }
}

async function withdrawFunds() {
  const amount = parseFloat(document.getElementById('withdraw-amount').value);
  const withdrawalWallet = document.getElementById('withdrawal-wallet').value;
  if (isNaN(amount) || amount <= 0 || amount < 6) {
    showError('Please enter a valid withdrawal amount of at least 6 DIS.');
    return;
  }
  if (!withdrawalWallet) {
    showError('Please enter a withdrawal wallet address or PayPal email.');
    return;
  }
  try {
    const data = await fetchWithToken('/api/withdraw', { body: { amount, withdrawalWalletId: withdrawalWallet } });
    showSuccess(data.message);
    document.getElementById('withdraw-qr').src = data.qrCode || 'https://via.placeholder.com/150';
    refreshUserData();
    document.getElementById('withdraw-amount').value = '';
    document.getElementById('withdrawal-wallet').value = '';
  } catch (error) {
    showError('Withdrawal failed: ' + error.message);
  }
}

async function addFriend() {
  const friendId = document.getElementById('friend-id').value;
  if (!friendId) {
    showError('Please enter a friend\'s Discord ID.');
    return;
  }
  try {
    const data = await fetchWithToken('/api/add-friend', { body: { friendId } });
    showSuccess(data.message);
    refreshUserData();
    document.getElementById('friend-id').value = '';
  } catch (error) {
    showError('Friend request failed: ' + error.message);
  }
}

async function acceptFriend(friendId) {
  try {
    const data = await fetchWithToken('/api/accept-friend', { body: { friendId } });
    showSuccess(data.message);
    refreshUserData();
  } catch (error) {
    showError('Accept friend failed: ' + error.message);
  }
}

async function ignoreFriend(friendId) {
  try {
    const data = await fetchWithToken('/api/ignore-friend', { body: { friendId } });
    showSuccess(data.message);
    refreshUserData();
  } catch (error) {
    showError('Ignore friend failed: ' + error.message);
  }
}

function startChat(friendId, friendUsername) {
  currentChatId = friendId;
  document.getElementById('chat-with').textContent = friendUsername;
  fetchChatHistory(friendId);
  document.getElementById('chat-panel').classList.remove('hidden');
  document.getElementById('chat-panel').classList.add('open');
}

function closeChat() {
  document.getElementById('chat-panel').classList.remove('open');
  document.getElementById('chat-panel').classList.add('hidden');
  currentChatId = null;
}

async function fetchChatHistory(friendId) {
  try {
    const data = await fetchWithToken(`/api/chat/${friendId}`, { method: 'GET' });
    const chatBox = document.getElementById('chat-box');
    const noMessages = document.getElementById('no-messages');
    if (data.messages && data.messages.length > 0) {
      chatBox.innerHTML = data.messages.map(msg => `<p>${msg.from === userData.userId ? 'You' : friendId}: ${msg.message}</p>`).join('');
      if (noMessages) noMessages.remove();
    } else {
      chatBox.innerHTML = `
        <div id="no-messages">
          <span style="font-size: 24px;">📩</span>
          <p>No messages</p>
          <p>Messages from your friend will be shown here</p>
        </div>
      `;
    }
    chatBox.scrollTop = chatBox.scrollHeight;
  } catch (error) {
    showError('Error fetching chat history: ' + error.message);
  }
}

function sendChat() {
  if (!currentChatId) return;
  const message = document.getElementById('chat-input').value.trim();
  if (!message) return;
  socket.emit('chat', { toId: currentChatId, message });
  document.getElementById('chat-input').value = '';
}

socket.on('chat', ({ from, message }) => {
  if (from === currentChatId || from === userData.userId) {
    const chatBox = document.getElementById('chat-box');
    const noMessages = document.getElementById('no-messages');
    if (noMessages) noMessages.remove();
    chatBox.innerHTML += `<p>${from === userData.userId ? 'You' : from}: ${message}</p>`;
    chatBox.scrollTop = chatBox.scrollHeight;
  }
});

socket.on('transfer', (data) => {
  if (data.walletId === userData.walletId || data.fromWalletId === userData.walletId || data.toWalletId === userData.walletId) {
    refreshUserData();
    if (data.type === 'peer' || data.type === 'deposit' || data.type === 'withdrawal') {
      searchTransactions();
    }
  }
});

async function searchTransactions() {
  try {
    const data = await fetchWithToken('/api/transactions');
    const transList = document.getElementById('trans-list');
    transList.innerHTML = data.transactions
      .map(t => `<p>From: ${t.fromWalletId}, To: ${t.toWalletId}, Amount: ${t.amount} DIS, Time: ${new Date(t.timestamp.seconds * 1000)}${t.type === 'withdrawal' ? ` (Fee: ${t.fee} DIS)` : ''}</p>`)
      .join('');
  } catch (error) {
    showError('Error fetching transactions: ' + error.message);
  }
}

function showSuccess(message) {
  alert(message);
}

function showError(message) {
  alert(message);
}

function logout() {
  localStorage.clear();
  window.location.href = '/';
}

function filterCoins(type, value = '') {
  const coins = document.querySelectorAll('.coin-item');
  if (type === 'all') {
    coins.forEach(coin => coin.style.display = 'flex');
  } else if (type === 'search') {
    coins.forEach(coin => {
      const coinName = coin.getAttribute('data-coin').toLowerCase();
      coin.style.display = coinName.includes(value.toLowerCase()) ? 'flex' : 'none';
    });
  }
}

function buyCoin(coin) {
  alert(`Buy ${coin} feature coming soon! Implement an exchange or marketplace to purchase DIS with PayPal or fiat.`);
}

showSection('deposit');
