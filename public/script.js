const token = new URLSearchParams(window.location.search).get('token');
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
      balance: data.balance,
      friends: data.friends || [],
      pendingFriends: data.pendingFriends || []
    };
    updateUI();
    socket.emit('join', userData.userId);
    updateFriendsList();
    updateQRCode();
  } catch (error) {
    console.error('Error fetching user data:', error);
    showError('Error fetching user data: ' + error.message);
    document.getElementById('username').textContent = 'Error';
    document.getElementById('avatar').src = 'https://via.placeholder.com/40';
    document.getElementById('balance-amount').textContent = '0 USDT';
  }
}

function updateUI() {
  const avatarEl = document.getElementById('avatar');
  const avatarUrl = userData.avatar ? `${userData.avatar}?t=${Date.now()}` : 'https://via.placeholder.com/40';
  console.log('Attempting to set avatar URL:', avatarUrl);
  avatarEl.removeAttribute('src');
  avatarEl.src = avatarUrl;
  avatarEl.onload = () => console.log('Avatar loaded successfully:', avatarEl.src);
  avatarEl.onerror = () => {
    console.warn('Avatar failed to load:', avatarUrl, 'Switching to fallback');
    avatarEl.src = 'https://via.placeholder.com/40';
  };

  document.getElementById('username').textContent = userData.username || 'Unknown';
  document.getElementById('discord-id').textContent = `ID: ${userData.userId}`;
  document.getElementById('balance-amount').textContent = `${userData.balance || 0} USDT`;
  document.getElementById('wallet-id').textContent = userData.walletId || 'N/A';
}

async function getOwnerWallet() {
  try {
    const data = await fetchWithToken('/api/owner-wallet', { method: 'GET' });
    return { address: data.wallet, qrCode: data.qrCode };
  } catch (error) {
    console.error('Error fetching owner wallet:', error);
    return { address: 'Error', qrCode: 'https://via.placeholder.com/150' };
  }
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
    const ownerWallet = await getOwnerWallet();
    document.getElementById('qr-code').src = ownerWallet.qrCode;
    document.getElementById('withdraw-qr').src = '';
    console.log('Owner wallet for deposits:', ownerWallet.address);
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
  if (isNaN(amount) || amount <= 0) {
    showError('Please enter a valid deposit amount.');
    return;
  }
  try {
    const ownerWallet = await getOwnerWallet();
    const data = await fetchWithToken('/api/deposit', { body: { amount, walletId: userData.walletId } });
    showSuccess(`${data.message} Send ${amount} USDT to: ${ownerWallet.address}`);
    document.getElementById('deposit-amount').value = '';
  } catch (error) {
    showError('Deposit failed: ' + error.message);
  }
}

function showSection(sectionId) {
  document.querySelectorAll('.card').forEach(card => card.classList.remove('active'));
  document.getElementById(sectionId).classList.add('active');
  document.querySelectorAll('.sidebar nav ul li').forEach(li => li.classList.remove('active'));
  document.querySelector(`.sidebar nav ul li[onclick="showSection('${sectionId}')"]`).classList.add('active');
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
  if (isNaN(amount) || amount <= 0) {
    showError('Please enter a valid withdrawal amount.');
    return;
  }
  if (!withdrawalWallet) {
    showError('Please enter a withdrawal wallet ID.');
    return;
  }
  try {
    const data = await fetchWithToken('/api/withdraw', { body: { amount, withdrawalWalletId: withdrawalWallet } });
    showSuccess(`${data.message} Sending ${amount} USDT to: ${withdrawalWallet}`);
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

asyn
