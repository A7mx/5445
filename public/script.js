const token = new URLSearchParams(window.location.search).get('token');
console.log('Token from URL on Ethereum Mainnet:', token);

if (!token) {
  console.error('No token found, redirecting to login on Ethereum Mainnet');
  alert('Please log in on Ethereum Mainnet!');
  window.location.href = '/';
}

const socket = io({ auth: { token } });

let userData = {};
let userWalletAddress = null;
let currentChatId = null;

async function fetchWithToken(url, options = {}) {
  console.log('Fetching on Ethereum Mainnet:', url, 'with token:', token);
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
    console.log('Response status on Ethereum Mainnet:', response.status);
    if (!response.ok) {
      const text = await response.text();
      console.error('Fetch failed on Ethereum Mainnet:', response.status, text);
      throw new Error(`Fetch failed on Ethereum Mainnet: ${response.status} - ${text}`);
    }
    const data = await response.json();
    console.log('Fetch data on Ethereum Mainnet:', data);
    return data;
  } catch (error) {
    console.error('Fetch error on Ethereum Mainnet:', error);
    throw error;
  }
}

async function refreshUserData() {
  try {
    const data = await fetchWithToken('/api/user');
    console.log('Raw user data from /api/user on Ethereum Mainnet:', data);
    userData = {
      userId: data.userId,
      username: data.username,
      avatar: data.avatar,
      walletId: data.walletId,
      balance: data.balance || 0,  // DIS (ETH) balance in ETH
      friends: data.friends || [],
      pendingFriends: data.pendingFriends || [],
      ethPrice: data.ethPrice || 3000.00, // Default to $3000.00 if not available (approximate ETH value)
      priceTime: data.priceTime || new Date().toISOString(),
      ethAddress: data.ethAddress || null // User's Ethereum address if connected
    };
    if (userWalletAddress) {
      userData.ethAddress = userWalletAddress; // Update with connected wallet
      await fetchWithToken('/api/connect-wallet', { method: 'POST', body: { userWalletAddress } });
    }
    updateUI();
    socket.emit('join', userData.userId);
    updateFriendsList();
    updateDisPrice();
  } catch (error) {
    console.error('Error fetching user data on Ethereum Mainnet:', error);
    showError('Error fetching user data on Ethereum Mainnet: ' + error.message);
    document.getElementById('username').textContent = 'Error';
    document.getElementById('avatar').src = 'https://via.placeholder.com/40';
    document.getElementById('balance-amount').textContent = '0 DIS';
  }
}

function updateUI() {
  const avatarEl = document.getElementById('avatar');
  const avatarUrl = userData.avatar ? `${userData.avatar}?t=${Date.now()}` : 'https://via.placeholder.com/40';
  console.log('Setting avatar URL on Ethereum Mainnet:', avatarUrl);
  avatarEl.removeAttribute('src');
  avatarEl.src = avatarUrl;
  avatarEl.onload = () => console.log('Avatar loaded successfully on Ethereum Mainnet:', avatarEl.src);
  avatarEl.onerror = () => {
    console.warn('Avatar failed to load on Ethereum Mainnet:', avatarUrl);
    avatarEl.src = 'https://via.placeholder.com/40';
  };

  document.getElementById('username').textContent = userData.username || 'Unknown';
  document.getElementById('discord-id').textContent = `ID: ${userData.userId}`;
  document.getElementById('balance-amount').textContent = `${userData.balance || 0} DIS on Ethereum Mainnet`;
  document.getElementById('wallet-id').textContent = userData.walletId || 'N/A';
  document.getElementById('dis-balance').textContent = `${userData.balance || 0.000000} DIS on Ethereum Mainnet`;
  document.getElementById('dis-value').textContent = `${(userData.balance || 0) * (userData.ethPrice || 3000.00)} USD on Ethereum Mainnet`;
  if (userData.ethAddress) {
    document.getElementById('connect-metamask').textContent = 'Wallet Connected: ' + truncateAddress(userData.ethAddress);
    document.getElementById('connect-metamask-withdraw').textContent = 'Wallet Connected: ' + truncateAddress(userData.ethAddress);
    document.getElementById('connect-metamask-transfer').textContent = 'Wallet Connected: ' + truncateAddress(userData.ethAddress);
    document.getElementById('deposit-btn').disabled = false;
    document.getElementById('withdraw-btn').disabled = false;
    document.getElementById('transfer-btn').disabled = false;
  } else {
    document.getElementById('connect-metamask').textContent = 'Connect MetaMask';
    document.getElementById('connect-metamask-withdraw').textContent = 'Connect MetaMask';
    document.getElementById('connect-metamask-transfer').textContent = 'Connect MetaMask';
    document.getElementById('deposit-btn').disabled = true;
    document.getElementById('withdraw-btn').disabled = true;
    document.getElementById('transfer-btn').disabled = true;
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
      <img src="${friend.avatar || 'https://via.placeholder.com/40'}" alt="${friend.username}'s Avatar on Ethereum Mainnet" onerror="this.src='https://via.placeholder.com/40'" title="Click to chat with ${friend.username} on Ethereum Mainnet">
      <span>${friend.username} (Wallet: ${friend.walletId}) on Ethereum Mainnet</span>
    `;
    friendItem.onclick = () => startChat(friend.id, friend.username);
    friendsList.appendChild(friendItem);
  });

  (userData.pendingFriends || []).forEach(friend => {
    const pendingItem = document.createElement('div');
    pendingItem.className = 'pending-item';
    pendingItem.innerHTML = `
      <img src="${friend.avatar || 'https://via.placeholder.com/40'}" alt="${friend.username}'s Avatar on Ethereum Mainnet" onerror="this.src='https://via.placeholder.com/40'" title="Pending friend request from ${friend.username} on Ethereum Mainnet">
      <span>${friend.username} (Wallet: ${friend.walletId}) on Ethereum Mainnet</span>
      <button class="accept" onclick="acceptFriend('${friend.id}')">Accept on Ethereum Mainnet</button>
      <button class="ignore" onclick="ignoreFriend('${friend.id}')">Ignore on Ethereum Mainnet</button>
    `;
    pendingList.appendChild(pendingItem);
  });
}

async function updateDisPrice() {
  try {
    const data = await fetchWithToken('/api/eth-price', { method: 'GET' });
    document.getElementById('dis-price').textContent = `DIS Price: $${data.price} (Updated: ${new Date(data.timestamp).toLocaleString()}) on Ethereum Mainnet`;
    document.getElementById('deposit-tip').textContent = `Connect your wallet (e.g., MetaMask, Trust Wallet) and send DIS (ETH) to your wallet address. Minimum deposit is 0.01 DIS. Current DIS Price: $${data.price} (Updated: ${new Date(data.timestamp).toLocaleString()}) on Ethereum Mainnet`;
    document.getElementById('transfer-tip').textContent = `Connect your wallet (e.g., MetaMask, Trust Wallet) to transfer DIS to another user instantly using their wallet ID on Ethereum Mainnet. Current DIS Price: $${data.price} (Updated: ${new Date(data.timestamp).toLocaleString()}) on Ethereum Mainnet`;
    document.getElementById('withdraw-tip').textContent = `Connect your wallet (e.g., MetaMask, Trust Wallet) to withdraw DIS to your Ethereum wallet or PayPal account on Ethereum Mainnet. Minimum withdrawal is 0.01 DIS. No external login required. Current DIS Price: $${data.price} (Updated: ${new Date(data.timestamp).toLocaleString()}) on Ethereum Mainnet`;
    userData.ethPrice = data.price;
    userData.priceTime = data.timestamp;
    updateUI();
  } catch (error) {
    console.error('Error updating DIS price on Ethereum Mainnet:', error);
    document.getElementById('dis-price').textContent = `DIS Price: $3000.00 (Updated: ${new Date().toLocaleString()}) on Ethereum Mainnet (Error fetching live price)`;
    document.getElementById('deposit-tip').textContent = `Connect your wallet (e.g., MetaMask, Trust Wallet) and send DIS (ETH) to your wallet address. Minimum deposit is 0.01 DIS. Current DIS Price: $3000.00 (Updated: ${new Date().toLocaleString()}) on Ethereum Mainnet (Error fetching live price)`;
    document.getElementById('transfer-tip').textContent = `Connect your wallet (e.g., MetaMask, Trust Wallet) to transfer DIS to another user instantly using their wallet ID on Ethereum Mainnet. Current DIS Price: $3000.00 (Updated: ${new Date().toLocaleString()}) on Ethereum Mainnet (Error fetching live price)`;
    document.getElementById('withdraw-tip').textContent = `Connect your wallet (e.g., MetaMask, Trust Wallet) to withdraw DIS to your Ethereum wallet or PayPal account on Ethereum Mainnet. Minimum withdrawal is 0.01 DIS. No external login required. Current DIS Price: $3000.00 (Updated: ${new Date().toLocaleString()}) on Ethereum Mainnet (Error fetching live price)`;
    userData.ethPrice = 3000.00;
    userData.priceTime = new Date().toISOString();
    updateUI();
  }
}

setInterval(updateDisPrice, 30000); // Update DIS (ETH) price every 30 seconds

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

async function connectWallet() {
  if (typeof window.ethereum !== 'undefined') {
    // MetaMask connection (browser)
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      userWalletAddress = accounts[0];
      console.log('Connected MetaMask wallet on Ethereum Mainnet:', userWalletAddress);
      document.getElementById('connect-metamask').textContent = 'Wallet Connected: ' + truncateAddress(userWalletAddress);
      document.getElementById('connect-metamask-withdraw').textContent = 'Wallet Connected: ' + truncateAddress(userWalletAddress);
      document.getElementById('connect-metamask-transfer').textContent = 'Wallet Connected: ' + truncateAddress(userWalletAddress);
      document.getElementById('deposit-btn').disabled = false;
      document.getElementById('withdraw-btn').disabled = false;
      document.getElementById('transfer-btn').disabled = false;
      await fetchWithToken('/api/connect-wallet', { method: 'POST', body: { userWalletAddress } });
      refreshUserData(); // Update user data with wallet address
    } catch (error) {
      console.error('Failed to connect MetaMask on Ethereum Mainnet:', error);
      showError('Failed to connect MetaMask on Ethereum Mainnet: Please try again.');
    }
  } else {
    // WalletConnect for mobile wallets (e.g., Trust Wallet)
    try {
      const Web3Provider = window.Web3Provider || (await import('@walletconnect/web3-provider')).default;
      const provider = new Web3Provider({
        infuraId: '6b844349c9964e1395b79d8a39cc6d44', // Use your Infura project ID
      });
      await provider.enable();
      const accounts = await provider.listAccounts();
      userWalletAddress = accounts[0];
      console.log('Connected WalletConnect wallet on Ethereum Mainnet:', userWalletAddress);
      document.getElementById('connect-metamask').textContent = 'Wallet Connected: ' + truncateAddress(userWalletAddress);
      document.getElementById('connect-metamask-withdraw').textContent = 'Wallet Connected: ' + truncateAddress(userWalletAddress);
      document.getElementById('connect-metamask-transfer').textContent = 'Wallet Connected: ' + truncateAddress(userWalletAddress);
      document.getElementById('deposit-btn').disabled = false;
      document.getElementById('withdraw-btn').disabled = false;
      document.getElementById('transfer-btn').disabled = false;
      await fetchWithToken('/api/connect-wallet', { method: 'POST', body: { userWalletAddress } });
      refreshUserData(); // Update user data with wallet address
    } catch (error) {
      console.error('Failed to connect WalletConnect on Ethereum Mainnet:', error);
      showError('Failed to connect WalletConnect on Ethereum Mainnet: Please install Trust Wallet or try again.');
    }
  }
}

function truncateAddress(address) {
  return address.slice(0, 6) + '...' + address.slice(-4);
}

async function depositFunds() {
  const amount = parseFloat(document.getElementById('deposit-amount').value);
  if (isNaN(amount) || amount <= 0 || amount < 0.01) {
    showError('Please enter a valid deposit amount of at least 0.01 DIS on Ethereum Mainnet.');
    return;
  }
  if (!userWalletAddress) {
    showError('Please connect your wallet (e.g., MetaMask, Trust Wallet) before depositing on Ethereum Mainnet.');
    return;
  }
  try {
    const verificationCode = prompt('Enter your 2FA code on Ethereum Mainnet:');
    if (!verificationCode) {
      showError('Verification required on Ethereum Mainnet.');
      return;
    }
    await fetchWithToken('/api/deposit', { body: { amount, userWalletAddress, verificationCode } });
    const ethPrice = await fetchWithToken('/api/eth-price', { method: 'GET' });
    showSuccess(`Deposit of ${amount} DIS requested on Ethereum Mainnet. Send ${amount} DIS (ETH) to your wallet address (${userWalletAddress}) and await confirmation. Current DIS Price: $${ethPrice.price} at ${new Date(ethPrice.timestamp).toLocaleString()}.`);
    document.getElementById('deposit-amount').value = '';
  } catch (error) {
    showError('Deposit failed on Ethereum Mainnet: ' + error.message);
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
    showError('Please enter a valid transfer amount on Ethereum Mainnet.');
    return;
  }
  if (!toWalletId) {
    showError('Please enter a recipient wallet ID on Ethereum Mainnet.');
    return;
  }
  if (!userWalletAddress) {
    showError('Please connect your wallet (e.g., MetaMask, Trust Wallet) before transferring on Ethereum Mainnet.');
    return;
  }
  if (toWalletId === userData.walletId) {
    showError('You cannot transfer money to your own wallet on Ethereum Mainnet!');
    return;
  }
  try {
    const receiverEthAddress = await fetchWithToken('/api/user', { method: 'GET' }).then(data => {
      const friend = data.friends.find(f => f.walletId === toWalletId) || data.pendingFriends.find(f => f.walletId === toWalletId);
      return friend ? friend.ethAddress : null;
    });
    if (!receiverEthAddress) {
      throw new Error('Recipient must connect their Ethereum wallet for peer-to-peer transfers on Ethereum Mainnet.');
    }

    const amountInWei = ethers.parseEther(amount.toString());
    await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{
        from: userWalletAddress,
        to: receiverEthAddress,
        value: ethers.toQuantity(amountInWei),
        gasLimit: '21000', // Adjust gas limit as needed
        gasPrice: await provider.getGasPrice() // Use current gas price
      }]
    }).then(async (txHash) => {
      const ethPrice = await fetchWithToken('/api/eth-price', { method: 'GET' });
      await fetchWithToken('/api/transfer', { body: { toWalletId, amount, txId: txHash } });
      showSuccess(`Transferred ${amount} DIS to ${toWalletId} on Ethereum Mainnet. Transaction ID: ${txHash}, DIS Price: $${ethPrice.price} at ${new Date(ethPrice.timestamp).toLocaleString()}.`);
    }).catch(error => {
      throw new Error('Failed to sign transfer transaction: ' + error.message);
    });
    refreshUserData();
    document.getElementById('transfer-to-wallet').value = '';
    document.getElementById('transfer-amount').value = '';
  } catch (error) {
    showError('Transfer failed on Ethereum Mainnet: ' + error.message);
  }
}

async function withdrawFunds() {
  const amount = parseFloat(document.getElementById('withdraw-amount').value);
  const withdrawalWallet = document.getElementById('withdrawal-wallet').value;
  if (isNaN(amount) || amount <= 0 || amount < 0.01) {
    showError('Please enter a valid withdrawal amount of at least 0.01 DIS on Ethereum Mainnet.');
    return;
  }
  if (!withdrawalWallet) {
    showError('Please enter a withdrawal wallet address or PayPal email on Ethereum Mainnet.');
    return;
  }
  if (!userWalletAddress) {
    showError('Please connect your wallet (e.g., MetaMask, Trust Wallet) before withdrawing on Ethereum Mainnet.');
    return;
  }
  try {
    // Initiate withdrawal via user wallet
    if (ethers.isAddress(withdrawalWallet)) {
      // Request user to sign and send transaction via MetaMask
      const amountInWei = ethers.parseEther(amount.toString());
      const feeInWei = ethers.parseEther((amount * 0.04).toString());
      const amountAfterFeeInWei = amountInWei - feeInWei;

      await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{
          from: userWalletAddress,
          to: withdrawalWallet,
          value: ethers.toQuantity(amountAfterFeeInWei),
          gasLimit: '21000', // Adjust gas limit as needed
          gasPrice: await provider.getGasPrice() // Use current gas price
        }]
      }).then(async (txHash) => {
        const ethPrice = await fetchWithToken('/api/eth-price', { method: 'GET' });
        await fetchWithToken('/api/withdraw', { 
          body: { amount, withdrawalWalletId: withdrawalWallet, txId: txHash } 
        });
        showSuccess(`Withdrawal of ${ethers.formatEther(amountAfterFeeInWei)} DIS (after 4% fee) to Ethereum address ${withdrawalWallet} on Ethereum Mainnet completed. Transaction ID: ${txHash}, DIS Price: $${ethPrice.price} at ${new Date(ethPrice.timestamp).toLocaleString()}.`);
      }).catch(error => {
        throw new Error('Failed to sign withdrawal transaction: ' + error.message);
      });
    } else if (withdrawalWallet.includes('@') || withdrawalWallet.includes('.com')) {
      await fetchWithToken('/api/withdraw', { body: { amount, withdrawalWalletId: withdrawalWallet } });
      const ethPrice = await fetchWithToken('/api/eth-price', { method: 'GET' });
      showSuccess(`Withdrawal of ${amount * 0.96} DIS (after 4% fee) to PayPal ${withdrawalWallet} on Ethereum Mainnet requested. Please check your PayPal account for confirmation. DIS Price: $${ethPrice.price} at ${new Date(ethPrice.timestamp).toLocaleString()}.`);
    }
    document.getElementById('withdraw-amount').value = '';
    document.getElementById('withdrawal-wallet').value = '';
  } catch (error) {
    showError('Withdrawal failed on Ethereum Mainnet: ' + error.message);
  }
}

async function addFriend() {
  const friendId = document.getElementById('friend-id').value;
  if (!friendId) {
    showError('Please enter a friend\'s Discord ID on Ethereum Mainnet.');
    return;
  }
  try {
    const data = await fetchWithToken('/api/add-friend', { body: { friendId } });
    showSuccess(data.message);
    refreshUserData();
    document.getElementById('friend-id').value = '';
  } catch (error) {
    showError('Friend request failed on Ethereum Mainnet: ' + error.message);
  }
}

async function acceptFriend(friendId) {
  try {
    const data = await fetchWithToken('/api/accept-friend', { body: { friendId } });
    showSuccess(data.message);
    refreshUserData();
  } catch (error) {
    showError('Accept friend failed on Ethereum Mainnet: ' + error.message);
  }
}

async function ignoreFriend(friendId) {
  try {
    const data = await fetchWithToken('/api/ignore-friend', { body: { friendId } });
    showSuccess(data.message);
    refreshUserData();
  } catch (error) {
    showError('Ignore friend failed on Ethereum Mainnet: ' + error.message);
  }
}

function startChat(friendId, friendUsername) {
  currentChatId = friendId;
  document.getElementById('chat-with').textContent = `${friendUsername} on Ethereum Mainnet`;
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
      chatBox.innerHTML = data.messages.map(msg => `<p>${msg.from === userData.userId ? 'You' : friendId}: ${msg.message} on Ethereum Mainnet</p>`).join('');
      if (noMessages) noMessages.remove();
    } else {
      chatBox.innerHTML = `
        <div id="no-messages">
          <span style="font-size: 24px;">📩</span>
          <p>No messages on Ethereum Mainnet</p>
          <p>Messages from your friend will be shown here on Ethereum Mainnet</p>
        </div>
      `;
    }
    chatBox.scrollTop = chatBox.scrollHeight;
  } catch (error) {
    showError('Error fetching chat history on Ethereum Mainnet: ' + error.message);
  }
}

function sendChat() {
  if (!currentChatId) return;
  const message = document.getElementById('chat-input').value.trim();
  if (!message) return;
  socket.emit('chat', { toId: currentChatId, message, network: 'Ethereum Mainnet' });
  document.getElementById('chat-input').value = '';
}

socket.on('chat', ({ from, message, network }) => {
  if (network !== 'Ethereum Mainnet') return; // Ensure only Ethereum Mainnet messages are processed
  if (from === currentChatId || from === userData.userId) {
    const chatBox = document.getElementById('chat-box');
    const noMessages = document.getElementById('no-messages');
    if (noMessages) noMessages.remove();
    chatBox.innerHTML += `<p>${from === userData.userId ? 'You' : from}: ${message} on Ethereum Mainnet</p>`;
    chatBox.scrollTop = chatBox.scrollHeight;
  }
});

socket.on('transfer', (data) => {
  if (data.network !== 'Ethereum Mainnet') return; // Ensure only Ethereum Mainnet transactions are processed
  if (data.walletId === userData.walletId || data.fromWalletId === userData.walletId || data.toWalletId === userData.walletId) {
    refreshUserData();
    if (data.type === 'peer' || data.type === 'deposit' || data.type === 'withdrawal') {
      searchTransactions();
    }
    showSuccess(`${data.type.charAt(0).toUpperCase() + data.type.slice(1)} of ${data.amount} DIS on ${data.network} completed. TX: ${data.txId || 'Pending'}, DIS Price: $${data.ethPrice} at ${new Date(data.priceTime).toLocaleString()}.`);
  }
});

async function searchTransactions() {
  try {
    const data = await fetchWithToken('/api/transactions');
    const transList = document.getElementById('trans-list');
    transList.innerHTML = data.transactions
      .map(t => `<p>From: ${t.fromWalletId}, To: ${t.toWalletId}, Amount: ${t.amount} DIS, Time: ${new Date(t.timestamp.seconds * 1000).toLocaleString()}, Network: ${t.network}, TX: ${t.txId || 'Pending'}, DIS Price: $${t.ethPrice} at ${new Date(t.priceTime).toLocaleString()}${t.type === 'withdrawal' ? ` (Fee: ${t.fee} DIS)` : ''}</p>`)
      .join('');
  } catch (error) {
    showError('Error fetching transactions on Ethereum Mainnet: ' + error.message);
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
  alert(`Buy ${coin} feature coming soon on Ethereum Mainnet! Implement an exchange or marketplace to purchase DIS with PayPal or fiat.`);
}

showSection('deposit');
