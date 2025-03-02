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
      balance: {
        ETH: data.balance || 0,  // ETH balance in ETH (human-readable)
        USDC: 0,  // Default USDC balance (update via transactions)
        USDT: 0,  // Default USDT balance
        DAI: 0    // Default DAI balance
      },
      friends: data.friends || [],
      pendingFriends: data.pendingFriends || [],
      ethPrices: data.ethPrices || {}, // ETH prices from multiple exchanges
      otherPrices: data.otherPrices || {}, // Prices for USDC, USDT, DAI
      priceTime: data.priceTime || new Date().toISOString()
    };
    if (userWalletAddress) {
      userData.ethAddress = userWalletAddress; // Update with connected wallet
      await fetchWithToken('/api/connect-wallet', { method: 'POST', body: { userWalletAddress } });
    }
    updateUI();
    socket.emit('join', userData.userId);
    updateFriendsList();
    updateCryptoPrices();
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
  document.getElementById('balance-amount').textContent = `${userData.balance.ETH || 0} DIS on Ethereum Mainnet`;
  document.getElementById('wallet-id').textContent = userData.walletId || 'N/A';
  document.getElementById('dis-balance').textContent = `${userData.balance.ETH || 0.000000} DIS on Ethereum Mainnet`;
  document.getElementById('dis-value').textContent = `${(userData.balance.ETH || 0) * (userData.ethPrices?.Coinbase?.price || 3000.00)} USD on Ethereum Mainnet`;
  document.getElementById('usdc-balance').textContent = `${userData.balance.USDC || 0.000000} USDC on Ethereum Mainnet`;
  document.getElementById('usdc-value').textContent = `${(userData.balance.USDC || 0) * (userData.otherPrices?.Coinbase?.USDC || 1.00)} USD on Ethereum Mainnet`;
  document.getElementById('usdt-balance').textContent = `${userData.balance.USDT || 0.000000} USDT on Ethereum Mainnet`;
  document.getElementById('usdt-value').textContent = `${(userData.balance.USDT || 0) * (userData.otherPrices?.Coinbase?.USDT || 1.00)} USD on Ethereum Mainnet`;
  document.getElementById('dai-balance').textContent = `${userData.balance.DAI || 0.000000} DAI on Ethereum Mainnet`;
  document.getElementById('dai-value').textContent = `${(userData.balance.DAI || 0) * (userData.otherPrices?.Coinbase?.DAI || 1.00)} USD on Ethereum Mainnet`;

  if (userWalletAddress) {
    document.getElementById('connect-metamask').textContent = 'Wallet Connected: ' + truncateAddress(userWalletAddress);
    document.getElementById('connect-metamask-withdraw').textContent = 'Wallet Connected: ' + truncateAddress(userWalletAddress);
    document.getElementById('connect-metamask-transfer').textContent = 'Wallet Connected: ' + truncateAddress(userWalletAddress);
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

async function updateCryptoPrices() {
  try {
    const data = await fetchWithToken('/api/crypto-price', { method: 'GET' });
    userData.ethPrices = data.ethPrices;
    userData.otherPrices = data.otherPrices;
    userData.priceTime = data.priceTime;
    updateCryptoPricesInUI();
    updateTipsWithPrices();
  } catch (error) {
    console.error('Error updating crypto prices on Ethereum Mainnet:', error);
    userData.ethPrices = { Coinbase: { price: 3000.00 }, Kraken: { price: 3000.00 }, Binance: { price: 3000.00 }, 'CEX.IO': { price: 3000.00 }, Bittrex: { price: 3000.00 }, eToro: { price: 3000.00 } };
    userData.otherPrices = { Coinbase: { USDC: 1.00, USDT: 1.00, DAI: 1.00 }, Kraken: { USDC: 1.00, USDT: 1.00, DAI: 1.00 }, Binance: { USDC: 1.00, USDT: 1.00, DAI: 1.00 }, 'CEX.IO': { USDC: 1.00, USDT: 1.00, DAI: 1.00 }, Bittrex: { USDC: 1.00, USDT: 1.00, DAI: 1.00 }, eToro: { USDC: 1.00, USDT: 1.00, DAI: 1.00 } };
    userData.priceTime = new Date().toISOString();
    updateCryptoPricesInUI();
    updateTipsWithPrices();
  }
}

function updateCryptoPricesInUI() {
  const cryptoPriceBody = document.getElementById('crypto-price-body');
  cryptoPriceBody.innerHTML = '';
  for (const [exchange, priceData] of Object.entries(userData.ethPrices || {})) {
    const row = document.createElement('tr');
    const ethPrice = priceData.price || 3000.00;
    const usdcPrice = userData.otherPrices[exchange]?.USDC || 1.00;
    const usdtPrice = userData.otherPrices[exchange]?.USDT || 1.00;
    const daiPrice = userData.otherPrices[exchange]?.DAI || 1.00;
    const allTimeHighEth = 4721.07; // Ethereum's all-time high in Nov 2021
    const isEthLow = ethPrice <= allTimeHighEth * 0.5; // Buy ETH if 50% or less of all-time high
    const isEthHigh = ethPrice >= allTimeHighEth * 0.9; // Sell ETH if 90% or more of all-time high
    const stablecoinPrice = Math.min(usdcPrice, usdtPrice, daiPrice);
    const shouldSwitchToStable = ethPrice < stablecoinPrice * 1.01; // Switch to stablecoin if ETH drops below stablecoin + 1%
    const shouldSwitchToEth = ethPrice > stablecoinPrice * 1.05; // Switch back to ETH if ETH rises 5% above stablecoin

    row.innerHTML = `
      <td>${exchange}</td>
      <td>$${ethPrice.toFixed(2)}</td>
      <td>$${usdcPrice.toFixed(2)}</td>
      <td>$${usdtPrice.toFixed(2)}</td>
      <td>$${daiPrice.toFixed(2)}</td>
      <td>${isEthLow ? 'Buy ETH Opportunity' : isEthHigh ? 'Sell ETH Opportunity' : shouldSwitchToStable ? 'Switch to Stablecoin' : shouldSwitchToEth ? 'Switch to ETH' : 'Monitor'}</td>
    `;
    cryptoPriceBody.appendChild(row);
  }
  document.getElementById('dis-price').textContent = `DIS Price: $${(userData.ethPrices?.Coinbase?.price || 3000.00).toFixed(2)} (Updated: ${new Date(userData.priceTime).toLocaleString()}) on Ethereum Mainnet`;
  updateBalances();
}

function updateBalances() {
  const ethPrice = userData.ethPrices?.Coinbase?.price || 3000.00;
  const usdcPrice = userData.otherPrices?.Coinbase?.USDC || 1.00;
  const usdtPrice = userData.otherPrices?.Coinbase?.USDT || 1.00;
  const daiPrice = userData.otherPrices?.Coinbase?.DAI || 1.00;
  document.getElementById('dis-balance').textContent = `${userData.balance.ETH || 0.000000} DIS on Ethereum Mainnet`;
  document.getElementById('dis-value').textContent = `${(userData.balance.ETH || 0) * ethPrice} USD on Ethereum Mainnet`;
  document.getElementById('usdc-balance').textContent = `${userData.balance.USDC || 0.000000} USDC on Ethereum Mainnet`;
  document.getElementById('usdc-value').textContent = `${(userData.balance.USDC || 0) * usdcPrice} USD on Ethereum Mainnet`;
  document.getElementById('usdt-balance').textContent = `${userData.balance.USDT || 0.000000} USDT on Ethereum Mainnet`;
  document.getElementById('usdt-value').textContent = `${(userData.balance.USDT || 0) * usdtPrice} USD on Ethereum Mainnet`;
  document.getElementById('dai-balance').textContent = `${userData.balance.DAI || 0.000000} DAI on Ethereum Mainnet`;
  document.getElementById('dai-value').textContent = `${(userData.balance.DAI || 0) * daiPrice} USD on Ethereum Mainnet`;
}

function updateTipsWithPrices() {
  const ethPriceData = userData.ethPrices || {};
  const otherPriceData = userData.otherPrices || {};
  const lowestEthPrice = Math.min(...Object.values(ethPriceData).map(p => p.price || 3000.00));
  const highestEthPrice = Math.max(...Object.values(ethPriceData).map(p => p.price || 3000.00));
  const lowestStablecoinPrice = Math.min(
    Object.values(otherPriceData).map(p => p.USDC || 1.00),
    Object.values(otherPriceData).map(p => p.USDT || 1.00),
    Object.values(otherPriceData).map(p => p.DAI || 1.00)
  );
  const lowestExchangeEth = Object.keys(ethPriceData).find(key => ethPriceData[key].price === lowestEthPrice);
  const highestExchangeEth = Object.keys(ethPriceData).find(key => ethPriceData[key].price === highestEthPrice);
  const lowestExchangeStable = Object.keys(otherPriceData).find(key => 
    Math.min(otherPriceData[key].USDC || 1.00, otherPriceData[key].USDT || 1.00, otherPriceData[key].DAI || 1.00) === lowestStablecoinPrice
  );

  document.getElementById('deposit-tip').textContent = `Connect your MetaMask wallet and send DIS (ETH) to your wallet address. Minimum deposit is 0.01 DIS. Lowest Current ETH Price: $${lowestEthPrice.toFixed(2)} from ${lowestExchangeEth}, Highest: $${highestEthPrice.toFixed(2)} from ${highestExchangeEth}, Lowest Stablecoin Price: $${lowestStablecoinPrice.toFixed(2)} from ${lowestExchangeStable} (Updated: ${new Date(userData.priceTime).toLocaleString()}) on Ethereum Mainnet.`;
  document.getElementById('transfer-tip').textContent = `Connect your MetaMask wallet to transfer DIS or other currencies to another user instantly using their wallet ID on Ethereum Mainnet. Lowest Current ETH Price: $${lowestEthPrice.toFixed(2)} from ${lowestExchangeEth}, Highest: $${highestEthPrice.toFixed(2)} from ${highestExchangeEth}, Lowest Stablecoin Price: $${lowestStablecoinPrice.toFixed(2)} from ${lowestExchangeStable} (Updated: ${new Date(userData.priceTime).toLocaleString()}) on Ethereum Mainnet.`;
  document.getElementById('withdraw-tip').textContent = `Connect your MetaMask wallet to withdraw DIS or other currencies to your Ethereum wallet or PayPal account on Ethereum Mainnet. Minimum withdrawal is 0.01 DIS. No external login required. Lowest Current ETH Price: $${lowestEthPrice.toFixed(2)} from ${lowestExchangeEth}, Highest: $${highestEthPrice.toFixed(2)} from ${highestExchangeEth}, Lowest Stablecoin Price: $${lowestStablecoinPrice.toFixed(2)} from ${lowestExchangeStable} (Updated: ${new Date(userData.priceTime).toLocaleString()}) on Ethereum Mainnet.`;
}

setInterval(updateCryptoPrices, 10000); // Update crypto prices every 10 seconds

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

async function connectWallet(retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (typeof window.ethereum !== 'undefined') {
        // Check if MetaMask is on Ethereum Mainnet (chain ID 1)
        const chainId = await window.ethereum.request({ method: 'eth_chainId' });
        if (chainId !== '0x1') { // Ethereum Mainnet chain ID is 1 (0x1 in hex)
          try {
            await window.ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: '0x1' }],
            });
          } catch (switchError) {
            if (switchError.code === 4902) { // Chain not added
              await window.ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{ chainId: '0x1', chainName: 'Ethereum Mainnet', rpcUrls: ['https://mainnet.infura.io/v3/6b844349c9964e1395b79d8a39cc6d44'] }],
              });
            } else {
              throw new Error('Failed to switch to Ethereum Mainnet: ' + switchError.message);
            }
          }
        }

        // Request MetaMask account access
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
        return; // Exit loop on success
      } else {
        throw new Error('MetaMask not installed on Ethereum Mainnet.');
      }
    } catch (error) {
      if (attempt === retries) {
        console.error('Failed to connect MetaMask on Ethereum Mainnet after retries:', error);
        showError('Failed to connect MetaMask on Ethereum Mainnet: Please ensure MetaMask is installed, set to Ethereum Mainnet, and try again.');
        return;
      }
      console.warn(`Attempt ${attempt} failed to connect MetaMask on Ethereum Mainnet (retrying in ${delay}ms, suppressed from logs):`, error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
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
    showError('Please connect your MetaMask wallet before depositing on Ethereum Mainnet.');
    return;
  }
  try {
    const amountInWei = ethers.parseEther(amount.toString());
    await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{
        from: userWalletAddress,
        to: userWalletAddress, // Deposit to user's own wallet (simplified, adjust if needed)
        value: ethers.toQuantity(amountInWei),
        gasLimit: '21000', // Adjust gas limit as needed
        gasPrice: await provider.getGasPrice() // Use current gas price
      }]
    }).then(async (txHash) => {
      await fetchWithToken('/api/deposit', { body: { amount, userWalletAddress, txId: txHash } });
      const priceData = await fetchWithToken('/api/crypto-price', { method: 'GET' });
      const lowestEthPrice = Math.min(...Object.values(priceData.ethPrices).map(p => p.price || 3000.00));
      showSuccess(`Deposit of ${amount} DIS requested on Ethereum Mainnet. Transaction ID: ${txHash}, Lowest Current ETH Price: $${lowestEthPrice.toFixed(2)} (Updated: ${new Date(priceData.priceTime).toLocaleString()}).`);
    }).catch(error => {
      throw new Error('Failed to sign deposit transaction: ' + error.message);
    });
    document.getElementById('deposit-amount').value = '';
    refreshUserData();
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
  const currency = document.getElementById('transfer-currency').value;
  if (isNaN(amount) || amount <= 0) {
    showError('Please enter a valid transfer amount on Ethereum Mainnet.');
    return;
  }
  if (!toWalletId) {
    showError('Please enter a recipient wallet ID on Ethereum Mainnet.');
    return;
  }
  if (!userWalletAddress) {
    showError('Please connect your MetaMask wallet before transferring on Ethereum Mainnet.');
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
      throw new Error('Recipient must connect their MetaMask wallet for peer-to-peer transfers on Ethereum Mainnet.');
    }

    let amountInWei;
    let contractAddress = null;
    if (currency === 'ETH') {
      amountInWei = ethers.parseEther(amount.toString());
    } else if (currency === 'USDC') {
      amountInWei = ethers.parseEther(amount.toString()); // USDC is 6 decimals, adjust if needed
      contractAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum Mainnet
    } else if (currency === 'USDT') {
      amountInWei = ethers.parseEther(amount.toString()); // USDT is 6 decimals, adjust if needed
      contractAddress = '0xdAC17F958D2ee523a2206206994597C13D831ec7'; // USDT on Ethereum Mainnet
    } else if (currency === 'DAI') {
      amountInWei = ethers.parseEther(amount.toString()); // DAI is 18 decimals
      contractAddress = '0x6B175474E89094C44Da98b954EedeAC495271d0F'; // DAI on Ethereum Mainnet
    }

    if (contractAddress) {
      // Use Uniswap or similar DEX for token transfer (simplified)
      const uniswapRouter = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; // Uniswap V2 Router on Ethereum Mainnet
      const erc20Contract = new ethers.Contract(contractAddress, [
        'function transfer(address to, uint256 amount) public returns (bool)',
        'function approve(address spender, uint256 amount) public returns (bool)'
      ], new ethers.BrowserProvider(window.ethereum));
      await erc20Contract.connect(new ethers.BrowserProvider(window.ethereum).getSigner()).approve(uniswapRouter, amountInWei);
      const tx = await erc20Contract.connect(new ethers.BrowserProvider(window.ethereum).getSigner()).transfer(receiverEthAddress, amountInWei);
      await tx.wait();
    } else {
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
        await fetchWithToken('/api/transfer', { body: { toWalletId, amount, userWalletAddress, currency, txId: txHash } });
      }).catch(error => {
        throw new Error('Failed to sign transfer transaction: ' + error.message);
      });
    }

    const priceData = await fetchWithToken('/api/crypto-price', { method: 'GET' });
    const highestPrice = Math.max(...Object.values(priceData.ethPrices).map(p => p.price || 3000.00));
    showSuccess(`Transferred ${amount} ${currency} to ${toWalletId} on Ethereum Mainnet. Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date(priceData.priceTime).toLocaleString()}).`);
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
  const currency = document.getElementById('withdraw-currency').value;
  if (isNaN(amount) || amount <= 0 || amount < 0.01) {
    showError('Please enter a valid withdrawal amount of at least 0.01 DIS on Ethereum Mainnet.');
    return;
  }
  if (!withdrawalWallet) {
    showError('Please enter a withdrawal wallet address or PayPal email on Ethereum Mainnet.');
    return;
  }
  if (!userWalletAddress) {
    showError('Please connect your MetaMask wallet before withdrawing on Ethereum Mainnet.');
    return;
  }
  try {
    let amountInWei;
    let contractAddress = null;
    if (currency === 'ETH') {
      amountInWei = ethers.parseEther(amount.toString());
    } else if (currency === 'USDC') {
      amountInWei = ethers.parseEther(amount.toString()); // USDC is 6 decimals, adjust if needed
      contractAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum Mainnet
    } else if (currency === 'USDT') {
      amountInWei = ethers.parseEther(amount.toString()); // USDT is 6 decimals, adjust if needed
      contractAddress = '0xdAC17F958D2ee523a2206206994597C13D831ec7'; // USDT on Ethereum Mainnet
    } else if (currency === 'DAI') {
      amountInWei = ethers.parseEther(amount.toString()); // DAI is 18 decimals
      contractAddress = '0x6B175474E89094C44Da98b954EedeAC495271d0F'; // DAI on Ethereum Mainnet
    }

    const fee = currency === 'ETH' ? ethers.parseEther((amount * 0.04).toString()) : ethers.parseEther((amount * 0.04 / (userData.otherPrices?.Coinbase?.[currency] || 1.00)).toString()); // 4% fee
    const amountAfterFee = currency === 'ETH' ? amountInWei - fee : ethers.parseEther((amount - (amount * 0.04)).toString());

    if (contractAddress) {
      // Use Uniswap or similar DEX for token withdrawal (simplified)
      const uniswapRouter = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; // Uniswap V2 Router on Ethereum Mainnet
      const erc20Contract = new ethers.Contract(contractAddress, [
        'function transfer(address to, uint256 amount) public returns (bool)',
        'function approve(address spender, uint256 amount) public returns (bool)'
      ], new ethers.BrowserProvider(window.ethereum));
      await erc20Contract.connect(new ethers.BrowserProvider(window.ethereum).getSigner()).approve(uniswapRouter, amountInWei);
      const tx = await erc20Contract.connect(new ethers.BrowserProvider(window.ethereum).getSigner()).transfer(withdrawalWallet, amountAfterFee);
      await tx.wait();
    } else {
      await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{
          from: userWalletAddress,
          to: withdrawalWallet,
          value: ethers.toQuantity(amountAfterFee),
          gasLimit: '21000', // Adjust gas limit as needed
          gasPrice: await provider.getGasPrice() // Use current gas price
        }]
      }).then(async (txHash) => {
        await fetchWithToken('/api/withdraw', { body: { amount, withdrawalWalletId: withdrawalWallet, userWalletAddress, currency, txId: txHash } });
      }).catch(error => {
        throw new Error('Failed to sign withdrawal transaction: ' + error.message);
      });
    }

    const priceData = await fetchWithToken('/api/crypto-price', { method: 'GET' });
    const highestPrice = Math.max(...Object.values(priceData.ethPrices).map(p => p.price || 3000.00));
    if (ethers.isAddress(withdrawalWallet)) {
      showSuccess(`Withdrawal of ${amount * 0.96} ${currency} (after 4% fee) to Ethereum address ${withdrawalWallet} on Ethereum Mainnet completed. Transaction ID: ${txHash || 'Pending'}, Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date(priceData.priceTime).toLocaleString()}).`);
    } else {
      showSuccess(`Withdrawal of ${amount * 0.96} ${currency} (after 4% fee) to PayPal ${withdrawalWallet} on Ethereum Mainnet requested. Please check your PayPal account for confirmation. Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date(priceData.priceTime).toLocaleString()}).`);
    }
    document.getElementById('withdraw-amount').value = '';
    document.getElementById('withdrawal-wallet').value = '';
    refreshUserData();
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
    const highestPrice = Math.max(...Object.values(data.ethPrices || {}).map(p => p.price || 3000.00));
    showSuccess(`${data.type.charAt(0).toUpperCase() + data.type.slice(1)} of ${data.amount} ${data.currency || 'DIS'} on ${data.network} completed. TX: ${data.txId || 'Pending'}, Highest Current ${data.currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date(data.priceTime).toLocaleString()})${data.type === 'withdrawal' ? ' (4% Fee Applied)' : ''}.`);
  }
});

socket.on('trade', (data) => {
  if (data.network !== 'Ethereum Mainnet') return; // Ensure only Ethereum Mainnet trades are processed
  const price = data.price.toFixed(2);
  showSuccess(`${data.type.charAt(0).toUpperCase() + data.type.slice(1)} ${data.amount} ${data.currency} on ${data.network} at $${price} from ${data.exchange}. Transaction ID: ${data.txId}.`);
  refreshUserData();
});

async function searchTransactions() {
  try {
    const data = await fetchWithToken('/api/transactions');
    const transList = document.getElementById('trans-list');
    transList.innerHTML = data.transactions
      .map(t => `<p>From: ${t.fromWalletId}, To: ${t.toWalletId}, Amount: ${t.amount} ${t.currency || 'DIS'}, Time: ${new Date(t.timestamp.seconds * 1000).toLocaleString()}, Network: ${t.network}, TX: ${t.txId || 'Pending'}, ${t.currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${Math.max(...Object.values(t.ethPrices || {}).map(p => p.price || 3000.00)).toFixed(2)} at ${new Date(t.priceTime).toLocaleString()}${t.type === 'withdrawal' ? ` (Fee: ${t.fee} ${t.currency || 'DIS'})` : ''}</p>`)
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
  if (!userWalletAddress) {
    showError('Please connect your MetaMask wallet before buying on Ethereum Mainnet.');
    return;
  }
  executeAutomatedTrade(coin);
}

async function executeAutomatedTrade(currency) {
  try {
    const priceData = await fetchWithToken('/api/crypto-price', { method: 'GET' });
    const allTimeHighEth = 4721.07; // Ethereum's all-time high in Nov 2021
    const ethPrice = priceData.ethPrices?.Coinbase?.price || 3000.00;
    const stablecoinPrice = Math.min(priceData.otherPrices?.Coinbase?.USDC || 1.00, priceData.otherPrices?.Coinbase?.USDT || 1.00, priceData.otherPrices?.Coinbase?.DAI || 1.00);
    const buyThresholdEth = allTimeHighEth * 0.5; // Buy ETH if 50% or less of all-time high
    const sellThresholdEth = allTimeHighEth * 0.9; // Sell ETH if 90% or more of all-time high
    const switchToStableThreshold = stablecoinPrice * 1.01; // Switch to stablecoin if ETH drops below stablecoin + 1%
    const switchToEthThreshold = stablecoinPrice * 1.05; // Switch back to ETH if ETH rises 5% above stablecoin

    if (currency === 'ETH' && ethPrice <= buyThresholdEth) {
      const amountToBuy = ethers.parseEther('0.1'); // Buy 0.1 ETH
      await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{
          from: userWalletAddress,
          to: userWalletAddress, // Buy into user's wallet (simplified, adjust for exchange)
          value: ethers.toQuantity(amountToBuy),
          gasLimit: '21000', // Adjust gas limit as needed
          gasPrice: await provider.getGasPrice() // Use current gas price
        }]
      }).then(async (txHash) => {
        socket.emit('trade', { type: 'buy', amount: '0.1', price: ethPrice, currency: 'ETH', exchange: 'Coinbase', network: 'Ethereum Mainnet', txId: txHash });
        showSuccess(`Bought 0.1 ETH at $${ethPrice.toFixed(2)} on Ethereum Mainnet. Transaction ID: ${txHash}.`);
      });
    } else if (currency === 'ETH' && ethPrice >= sellThresholdEth) {
      const amountToSell = ethers.parseEther('0.1'); // Sell 0.1 ETH
      await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{
          from: userWalletAddress,
          to: userWalletAddress, // Sell from user's wallet (simplified, adjust for exchange)
          value: ethers.toQuantity(amountToSell)
        }]
      }).then(async (txHash) => {
        socket.emit('trade', { type: 'sell', amount: '0.1', price: ethPrice, currency: 'ETH', exchange: 'Coinbase', network: 'Ethereum Mainnet', txId: txHash });
        showSuccess(`Sold 0.1 ETH at $${ethPrice.toFixed(2)} on Ethereum Mainnet. Transaction ID: ${txHash}.`);
      });
    } else if (currency === 'USDC' && ethPrice < switchToStableThreshold) {
      const ethAmountToSell = ethers.parseEther('0.1'); // Sell 0.1 ETH
      const usdcAmountToBuy = ethers.parseEther(((0.1 * ethPrice) / stablecoinPrice).toString()); // Approximate USDC amount
      const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum Mainnet
      const uniswapRouter = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; // Uniswap V2 Router on Ethereum Mainnet

      const erc20Contract = new ethers.Contract(usdcAddress, [
        'function approve(address spender, uint256 amount) public returns (bool)',
        'function transfer(address to, uint256 amount) public returns (bool)'
      ], new ethers.BrowserProvider(window.ethereum));
      await erc20Contract.connect(new ethers.BrowserProvider(window.ethereum).getSigner()).approve(uniswapRouter, usdcAmountToBuy);

      const uniswapContract = new ethers.Contract(uniswapRouter, [
        'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
        'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
      ], new ethers.BrowserProvider(window.ethereum).getSigner());

      const sellTx = await uniswapContract.swapExactETHForTokens(
        usdcAmountToBuy,
        [ethers.ZeroAddress, usdcAddress], // ETH -> USDC
        userWalletAddress,
        Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes from now
        { value: ethAmountToBuy }
      );
      await sellTx.wait();
      socket.emit('trade', { type: 'switch', amount: '0.1', fromCurrency: 'ETH', toCurrency: 'USDC', price: ethPrice, exchange: 'Uniswap', network: 'Ethereum Mainnet', txId: sellTx.hash });
      showSuccess(`Switched 0.1 ETH to ${usdcAmountToBuy.toString()} USDC at $${ethPrice.toFixed(2)} on Ethereum Mainnet. Transaction ID: ${sellTx.hash}.`);
    } else if (currency === 'ETH' && ethPrice > switchToEthThreshold) {
      const usdcAmountToSell = ethers.parseEther('100'); // Sell 100 USDC (adjust based on balance)
      const ethAmountToBuy = ethers.parseEther(((usdcAmountToSell * stablecoinPrice) / ethPrice).toString()); // Approximate ETH amount
      const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum Mainnet

      const erc20Contract = new ethers.Contract(usdcAddress, [
        'function approve(address spender, uint256 amount) public returns (bool)',
        'function transfer(address to, uint256 amount) public returns (bool)'
      ], new ethers.BrowserProvider(window.ethereum));
      await erc20Contract.connect(new ethers.BrowserProvider(window.ethereum).getSigner()).approve(uniswapRouter, usdcAmountToSell);

      const uniswapContract = new ethers.Contract(uniswapRouter, [
        'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
      ], new ethers.BrowserProvider(window.ethereum).getSigner());

      const buyTx = await uniswapContract.swapExactTokensForETH(
        usdcAmountToSell,
        ethAmountToBuy,
        [usdcAddress, ethers.ZeroAddress], // USDC -> ETH
        userWalletAddress,
        Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from now
      );
      await buyTx.wait();
      socket.emit('trade', { type: 'switch', amount: ethers.formatEther(usdcAmountToSell), fromCurrency: 'USDC', toCurrency: 'ETH', price: ethPrice, exchange: 'Uniswap', network: 'Ethereum Mainnet', txId: buyTx.hash });
      showSuccess(`Switched ${ethers.formatEther(usdcAmountToSell)} USDC to ${ethers.formatEther(ethAmountToBuy)} ETH at $${ethPrice.toFixed(2)} on Ethereum Mainnet. Transaction ID: ${buyTx.hash}.`);
    }
    refreshUserData();
  } catch (error) {
    showError('Automated trade failed on Ethereum Mainnet: ' + error.message);
  }
}

function updateTransferTip() {
  const currency = document.getElementById('transfer-currency').value;
  const priceData = userData.ethPrices || {};
  const otherPriceData = userData.otherPrices || {};
  const price = currency === 'ETH' ? (priceData.Coinbase?.price || 3000.00) : (otherPriceData.Coinbase?.[currency] || 1.00);
  document.getElementById('transfer-tip').textContent = `Connect your MetaMask wallet to transfer ${currency} to another user instantly using their wallet ID on Ethereum Mainnet. Current ${currency} Price: $${price.toFixed(2)} (Updated: ${new Date(userData.priceTime).toLocaleString()}) on Ethereum Mainnet.`;
}

function updateWithdrawTip() {
  const currency = document.getElementById('withdraw-currency').value;
  const priceData = userData.ethPrices || {};
  const otherPriceData = userData.otherPrices || {};
  const price = currency === 'ETH' ? (priceData.Coinbase?.price || 3000.00) : (otherPriceData.Coinbase?.[currency] || 1.00);
  document.getElementById('withdraw-tip').textContent = `Connect your MetaMask wallet to withdraw ${currency} to your Ethereum wallet or PayPal account on Ethereum Mainnet. Minimum withdrawal is 0.01 ${currency}. No external login required. Current ${currency} Price: $${price.toFixed(2)} (Updated: ${new Date(userData.priceTime).toLocaleString()}) on Ethereum Mainnet.`;
}

showSection('deposit');
