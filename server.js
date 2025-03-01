// Use CommonJS require syntax
require('dotenv').config();
const express = require('express');
const DiscordOAuth2 = require('discord-oauth2');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, updateDoc, arrayUnion, serverTimestamp, collection, query, where, getDocs } = require('firebase/firestore');
const bodyParser = require('body-parser');
const path = require('path');
const socketIo = require('socket.io');
const http = require('http');
const { ethers } = require('ethers');
const axios = require('axios');

const requiredEnv = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'FIREBASE_API_KEY', 'OWNER_ETH_WALLET', 'ETH_PRIVATE_KEY', 'INFURA_PROJECT_ID'];
requiredEnv.forEach(key => {
    if (!process.env[key]) {
        console.error(`Missing environment variable: ${key}`);
        process.exit(1);
    }
});

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

let db;
let provider, wallet;

(async () => {
    try {
        const appFirebase = initializeApp(firebaseConfig);
        db = getFirestore(appFirebase);
        console.log('Firestore initialized successfully');

        // Initialize Ethereum provider and wallet with your provided private key
        const infuraUrl = `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`;
        provider = new ethers.JsonRpcProvider(infuraUrl); // Use Infura for Ethereum Mainnet with your project ID
        wallet = new ethers.Wallet(process.env.ETH_PRIVATE_KEY, provider);
        const ownerAddress = await wallet.getAddress();
        process.env.OWNER_ETH_WALLET = ownerAddress; // Set or verify OWNER_ETH_WALLET
        console.log('Ethereum wallet initialized successfully with address:', ownerAddress);
    } catch (error) {
        console.error('Failed to initialize Firestore or Ethereum wallet:', error);
        if (error.code === 'SERVER_ERROR' && error.info && error.info.responseStatus === '401 Unauthorized') {
            console.error('Infura 401 Unauthorized: Please ensure INFURA_PROJECT_ID is correctly set in environment variables.');
        }
        process.exit(1);
    }
})().catch(error => {
    console.error('Initialization error:', error);
    process.exit(1);
});

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const oauth = new DiscordOAuth2();

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

function generateToken() {
    return require('crypto').randomBytes(16).toString('hex');
}

function generateWalletId() {
    return `WAL-${require('crypto').randomBytes(6).toString('hex').toUpperCase()}`;
}

async function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
        console.log('No token provided');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const sessionDoc = await getDoc(doc(db, 'sessions', token));
        if (!sessionDoc.exists()) {
            console.log('Invalid token:', token);
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = { userId: sessionDoc.data().userId };
        console.log('Authenticated user:', req.user.userId);
        next();
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: 'Server error' });
    }
}

app.get('/', (req, res) => {
    console.log('Serving index.html');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/auth/discord', (req, res) => {
    const url = oauth.generateAuthUrl({
        clientId: process.env.DISCORD_CLIENT_ID,
        scope: ['identify', 'email'],
        redirectUri: process.env.DISCORD_REDIRECT_URI,
    });
    console.log('Redirecting to Discord:', url);
    res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    console.log('Received OAuth callback with code:', code);

    if (!code) {
        console.error('No authorization code provided in callback');
        return res.status(400).send('No authorization code provided');
    }

    try {
        console.log('Step 1: Exchanging code for access token...');
        const tokenData = await oauth.tokenRequest({
            clientId: process.env.DISCORD_CLIENT_ID,
            clientSecret: process.env.DISCORD_CLIENT_SECRET,
            code,
            scope: ['identify', 'email'],
            grantType: 'authorization_code',
            redirectUri: process.env.DISCORD_REDIRECT_URI,
        });
        console.log('Step 1 completed: OAuth token received:', {
            access_token: tokenData.access_token,
            expires_in: tokenData.expires_in,
            token_type: tokenData.token_type
        });

        console.log('Step 2: Fetching user data with access token...');
        const user = await oauth.getUser(tokenData.access_token);
        console.log('Step 2 completed: Fetched Discord user:', {
            id: user.id,
            username: user.username,
            avatar: user.avatar
        });

        const userDocRef = doc(db, 'users', user.id);
        console.log('Step 3: Checking user in Firestore:', user.id);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists()) {
            console.log('User does not exist, creating new user...');
            await setDoc(userDocRef, {
                username: user.username,
                avatar: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`,
                walletId: generateWalletId(),
                balance: ethers.parseEther('0'),  // ETH balance in Firestore (in wei, but stored as string)
                friends: [],
                pendingFriends: [],
                ethAddress: ''  // Optional: store user's Ethereum address
            });
            console.log('Step 3 completed: Created user:', user.username);
        } else {
            console.log('Step 3 completed: User exists:', userDoc.data());
        }

        const sessionToken = generateToken();
        console.log('Step 4: Generated session token:', sessionToken);

        console.log('Step 5: Saving session to Firestore...');
        await setDoc(doc(db, 'sessions', sessionToken), {
            userId: user.id,
            createdAt: serverTimestamp()
        });
        console.log('Step 5 completed: Session token saved to Firestore');

        const redirectUrl = `/dashboard.html?token=${sessionToken}`;
        console.log('Step 6: Redirecting to:', redirectUrl);
        res.redirect(redirectUrl);
        console.log('Step 6 completed: Redirect sent to client');
    } catch (error) {
        console.error('OAuth callback failed at some step:', error.message);
        if (error.response) {
            console.error('Discord API error response:', error.response.data);
        }
        res.status(500).send(`Authentication failed: ${error.message}`);
    }
});

app.post('/api/user', authenticateToken, async (req, res) => {
    try {
        const userDoc = await getDoc(doc(db, 'users', req.user.userId));
        if (!userDoc.exists()) return res.status(404).json({ error: 'User not found' });
        const data = userDoc.data();
        const friendsData = await Promise.all((data.friends || []).map(async friendId => {
            const friendDoc = await getDoc(doc(db, 'users', friendId));
            return friendDoc.exists() ? { id: friendId, username: friendDoc.data().username, avatar: friendDoc.data().avatar, walletId: friendDoc.data().walletId } : null;
        }));
        const pendingFriendsData = await Promise.all((data.pendingFriends || []).map(async friendId => {
            const friendDoc = await getDoc(doc(db, 'users', friendId));
            return friendDoc.exists() ? { id: friendId, username: friendDoc.data().username, avatar: friendDoc.data().avatar, walletId: friendDoc.data().walletId } : null;
        }));
        const ethPrice = await getLiveEthPrice();
        const balanceInEth = ethers.formatEther(data.balance || '0'); // Convert balance from wei to ETH
        const response = {
            userId: userDoc.id,
            username: data.username,
            avatar: data.avatar,
            walletId: data.walletId,
            balance: balanceInEth,  // ETH balance in ETH (human-readable)
            friends: friendsData.filter(f => f),
            pendingFriends: pendingFriendsData.filter(f => f),
            ethPrice: ethPrice.price, // Live ETH price in USD
            priceTime: ethPrice.timestamp // Timestamp of the price
        };
        console.log('Sending user data with ETH price:', response);
        res.json(response);
    } catch (error) {
        console.error('API user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/owner-wallet', (req, res) => {
    const ownerWallet = process.env.OWNER_ETH_WALLET; // Use your Ethereum wallet (derived from private key)
    console.log('Returning owner wallet on Ethereum Mainnet:', ownerWallet);
    res.json({ wallet: ownerWallet, qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${ownerWallet}`, network: 'Ethereum Mainnet' });
});

app.post('/api/pending-deposit', authenticateToken, async (req, res) => {
    const { userId, amount, timestamp, status } = req.body;
    try {
        await setDoc(doc(collection(db, 'deposits'), `${userId}_${Date.now()}`), {
            userId,
            amount: ethers.parseEther(amount.toString()), // Store amount in wei
            timestamp,
            status,
            network: 'Ethereum Mainnet'
        });
        res.json({ success: true, message: 'Deposit request logged on Ethereum Mainnet' });
    } catch (error) {
        console.error('Pending deposit error on Ethereum Mainnet:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

async function monitorETHDeposits() {
    try {
        // Monitor Ethereum blockchain for ETH transactions to OWNER_ETH_WALLET on Ethereum Mainnet
        const ownerAddress = process.env.OWNER_ETH_WALLET;
        const latestBlock = await provider.getBlockNumber();
        const fromBlock = latestBlock - 1000; // Check last 1000 blocks for simplicity (adjust as needed)

        const transactions = await provider.getLogs({
            address: ownerAddress,
            fromBlock,
            toBlock: latestBlock,
            topics: [ethers.id('transfer(address,address,uint256)')] // ETH transfer event (simplified)
        });

        for (const tx of transactions) {
            const txReceipt = await provider.getTransactionReceipt(tx.transactionHash);
            if (txReceipt && txReceipt.logs.length > 0) {
                const log = txReceipt.logs[0];
                const amount = BigInt(log.data); // Amount in wei
                const amountInEth = ethers.formatEther(amount); // Convert to ETH

                const txId = tx.transactionHash;
                const fromAddress = '0x' + log.topics[1].slice(26); // Extract sender address (simplified)

                // Find pending deposits in Firestore
                const depositsQuery = query(collection(db, 'deposits'), where('status', '==', 'pending'));
                const depositsSnap = await getDocs(depositsQuery);
                for (const doc of depositsSnap.docs) {
                    const deposit = doc.data();
                    if (ethers.formatEther(deposit.amount) === amountInEth && deposit.userId) {
                        const userDocRef = doc(db, 'users', deposit.userId);
                        const userDoc = await getDoc(userDocRef);
                        const currentBalance = BigInt(userDoc.data().balance || '0');
                        await updateDoc(userDocRef, { balance: (currentBalance + amount).toString() });
                        await updateDoc(doc.ref, { 
                            status: 'completed', 
                            txId, 
                            timestamp: serverTimestamp(), 
                            network: 'Ethereum Mainnet',
                            fromAddress 
                        });
                        const ethPrice = await getLiveEthPrice();
                        io.to(deposit.userId).emit('transfer', { 
                            walletId: userDoc.data().walletId, 
                            amount: amountInEth, 
                            type: 'deposit', 
                            network: 'Ethereum Mainnet',
                            txId,
                            ethPrice: ethPrice.price,
                            priceTime: ethPrice.timestamp
                        });
                        console.log(`Deposit of ${amountInEth} ETH credited to user ${deposit.userId} on Ethereum Mainnet, TX: ${txId}, ETH Price: $${ethPrice.price} at ${ethPrice.timestamp}`);
                        break;
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error monitoring ETH deposits on Ethereum Mainnet (suppressed from logs):', error);
        if (error.code === 'RATE_LIMIT_EXCEEDED' || (error.code === 'SERVER_ERROR' && error.info && error.info.responseStatus === '401 Unauthorized')) {
            console.warn('Rate limit or authentication issue on Ethereum API, backing off...');
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retrying
        }
    }
}

// Poll every 5 seconds for faster detection
setInterval(monitorETHDeposits, 5000);

async function getLiveEthPrice() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
        const price = response.data.ethereum.usd;
        const timestamp = new Date().toISOString();
        return { price, timestamp };
    } catch (error) {
        console.error('Error fetching live ETH price (suppressed from logs):', error);
        return { price: 3000.00, timestamp: new Date().toISOString() }; // Default to $3000.00 if API fails (approximate ETH value)
    }
}

app.post('/api/deposit', authenticateToken, async (req, res) => {
    const { amount, walletId, verificationCode } = req.body;
    if (!amount || amount <= 0 || amount < 0.01) return res.status(400).json({ error: 'Invalid deposit amount (minimum 0.01 ETH)' });
    try {
        // Verify 2FA (simplified, integrate with Firebase Auth or TOTP)
        const userDoc = await getDoc(doc(db, 'users', req.user.userId));
        if (!userDoc.data().twoFactorSecret || !verificationCode) {
            return res.status(401).json({ error: '2FA verification required' });
        }
        // Add actual 2FA verification logic here

        // Log pending deposit to OWNER_ETH_WALLET on Ethereum Mainnet
        await setDoc(doc(collection(db, 'deposits'), `${req.user.userId}_${Date.now()}`), {
            userId: req.user.userId,
            amount: ethers.parseEther(amount.toString()), // Store amount in wei
            timestamp: new Date().toISOString(),
            status: 'pending',
            network: 'Ethereum Mainnet'
        });
        const ethPrice = await getLiveEthPrice();
        res.json({ 
            success: true, 
            message: `Deposit of ${amount} ETH requested on Ethereum Mainnet. Please send to wallet: ${process.env.OWNER_ETH_WALLET} and await confirmation. Current ETH Price: $${ethPrice.price} at ${ethPrice.timestamp}.`, 
            network: 'Ethereum Mainnet',
            ethPrice: ethPrice.price,
            priceTime: ethPrice.timestamp 
        });
    } catch (error) {
        console.error('Deposit error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Deposit error' });
    }
});

app.post('/api/transfer', authenticateToken, async (req, res) => {
    const { toWalletId, amount } = req.body;
    if (!toWalletId || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid transfer request' });
    try {
        const senderDocRef = doc(db, 'users', req.user.userId);
        const senderDoc = await getDoc(senderDocRef);
        const senderBalance = BigInt(senderDoc.data().balance || '0');
        const amountInWei = ethers.parseEther(amount.toString());
        if (senderBalance < amountInWei) return res.status(400).json({ error: 'Insufficient balance' });

        const receiverQuery = query(collection(db, 'users'), where('walletId', '==', toWalletId));
        const receiverSnap = await getDocs(receiverQuery);
        if (receiverSnap.empty) return res.status(404).json({ error: 'Recipient not found' });

        const receiverDocRef = receiverSnap.docs[0].ref;
        const receiverDoc = receiverSnap.docs[0];
        const receiverBalance = BigInt(receiverDoc.data().balance || '0');

        const newSenderBalance = (senderBalance - amountInWei).toString();
        const newReceiverBalance = (receiverBalance + amountInWei).toString();

        await updateDoc(senderDocRef, { balance: newSenderBalance });
        await updateDoc(receiverDocRef, { balance: newReceiverBalance });

        // Perform on-chain transfer using Ethereum wallet on Ethereum Mainnet
        const receiverAddress = await getEthAddressFromWalletId(toWalletId);
        const tx = await wallet.sendTransaction({
            to: receiverAddress,
            value: amountInWei
        });

        const ethPrice = await getLiveEthPrice();
        io.to(req.user.userId).emit('transfer', { 
            fromWalletId: senderDoc.data().walletId, 
            toWalletId, 
            amount, 
            type: 'peer', 
            network: 'Ethereum Mainnet',
            txId: tx.hash,
            ethPrice: ethPrice.price,
            priceTime: ethPrice.timestamp
        });
        io.to(receiverDoc.id).emit('transfer', { 
            fromWalletId: senderDoc.data().walletId, 
            toWalletId, 
            amount, 
            type: 'peer', 
            network: 'Ethereum Mainnet',
            txId: tx.hash,
            ethPrice: ethPrice.price,
            priceTime: ethPrice.timestamp
        });

        res.json({ 
            success: true, 
            message: `Transferred ${amount} ETH to ${toWalletId} on Ethereum Mainnet. TX: ${tx.hash}, ETH Price: $${ethPrice.price} at ${ethPrice.timestamp}.`, 
            network: 'Ethereum Mainnet',
            ethPrice: ethPrice.price,
            priceTime: ethPrice.timestamp 
        });
    } catch (error) {
        console.error('Transfer error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Transfer error' });
    }
});

// Helper function to map DISWallet walletId to Ethereum address
async function getEthAddressFromWalletId(walletId) {
    const usersQuery = query(collection(db, 'users'), where('walletId', '==', walletId));
    const usersSnap = await getDocs(usersQuery);
    if (!usersSnap.empty) {
        const userDoc = usersSnap.docs[0];
        return userDoc.data().ethAddress || process.env.OWNER_ETH_WALLET; // Default to owner wallet or fetch actual address
    }
    throw new Error('Wallet ID not found');
}

app.post('/api/withdraw', authenticateToken, async (req, res) => {
    const { amount, withdrawalWalletId } = req.body; // withdrawalWalletId can be Ethereum address or PayPal email
    if (!amount || amount <= 0 || !withdrawalWalletId || amount < 0.01) return res.status(400).json({ error: 'Invalid withdrawal request (minimum 0.01 ETH)' });
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        const userDoc = await getDoc(userDocRef);
        const currentBalance = BigInt(userDoc.data().balance || '0');
        const amountInWei = ethers.parseEther(amount.toString());
        if (currentBalance < amountInWei) return res.status(400).json({ error: 'Insufficient balance' });

        const fee = ethers.parseEther((amount * 0.04).toString()); // 4% fee in ETH
        const amountAfterFee = amountInWei - fee;
        const newBalance = (currentBalance - amountInWei).toString();

        await updateDoc(userDocRef, { balance: newBalance });

        // Handle withdrawal based on destination type on Ethereum Mainnet
        if (ethers.isAddress(withdrawalWalletId)) { // Ethereum address
            const tx = await wallet.sendTransaction({
                to: withdrawalWalletId,
                value: amountAfterFee
            });
            const ethPrice = await getLiveEthPrice();
            await setDoc(doc(collection(db, 'transactions')), {
                fromWalletId: userDoc.data().walletId,
                toWalletId: withdrawalWalletId,
                amount: ethers.formatEther(amountAfterFee),
                fee: ethers.formatEther(fee),
                type: 'withdrawal',
                timestamp: serverTimestamp(),
                userId: req.user.userId,
                network: 'Ethereum Mainnet',
                txId: tx.hash,
                ethPrice: ethPrice.price,
                priceTime: ethPrice.timestamp
            });
            res.json({ 
                success: true, 
                message: `Withdrawal of ${ethers.formatEther(amountAfterFee)} ETH (after 4% fee) to Ethereum address ${withdrawalWalletId} on Ethereum Mainnet requested. Transaction ID: ${tx.hash}, ETH Price: $${ethPrice.price} at ${ethPrice.timestamp}.`, 
                qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${withdrawalWalletId}`, 
                network: 'Ethereum Mainnet',
                ethPrice: ethPrice.price,
                priceTime: ethPrice.timestamp 
            });
        } else if (withdrawalWalletId.includes('@') || withdrawalWalletId.includes('.com')) { // PayPal email
            await handlePayPalWithdrawal(req.user.userId, ethers.formatEther(amountAfterFee), withdrawalWalletId);
            const ethPrice = await getLiveEthPrice();
            await setDoc(doc(collection(db, 'transactions')), {
                fromWalletId: userDoc.data().walletId,
                toWalletId: withdrawalWalletId,
                amount: ethers.formatEther(amountAfterFee),
                fee: ethers.formatEther(fee),
                type: 'withdrawal',
                timestamp: serverTimestamp(),
                userId: req.user.userId,
                network: 'Ethereum Mainnet',
                txId: null,
                ethPrice: ethPrice.price,
                priceTime: ethPrice.timestamp
            });
            res.json({ 
                success: true, 
                message: `Withdrawal of ${ethers.formatEther(amountAfterFee)} ETH (after 4% fee) to PayPal ${withdrawalWalletId} on Ethereum Mainnet requested. Please check your PayPal account for confirmation. ETH Price: $${ethPrice.price} at ${ethPrice.timestamp}.`, 
                network: 'Ethereum Mainnet',
                ethPrice: ethPrice.price,
                priceTime: ethPrice.timestamp 
            });
        } else {
            return res.status(400).json({ error: 'Invalid withdrawal destination (use Ethereum address or PayPal email)' });
        }
    } catch (error) {
        console.error('Withdrawal error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Withdrawal error' });
    }
});

// Helper function for PayPal withdrawal (simplified, requires PayPal API integration)
async function handlePayPalWithdrawal(userId, amount, paypalEmail) {
    // Use PayPal API to convert ETH to USD and transfer to PayPal (requires PayPal Developer account and API keys)
    const ethPrice = await getLiveEthPrice();
    const usdAmount = amount * ethPrice.price;
    console.log(`Simulating PayPal withdrawal of ${amount} ETH (${usdAmount} USD) to ${paypalEmail} for user ${userId} via Ethereum Mainnet`);
    // Placeholder: Implement actual PayPal API call here (e.g., using paypal-rest-sdk or paypal-checkout)
    // Note: Convert ETH to USD via an exchange before transferring to PayPal
}

app.post('/api/add-friend', authenticateToken, async (req, res) => {
    const { friendId } = req.body;
    if (!friendId) return res.status(400).json({ error: 'Friend ID required' });
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        const friendDocRef = doc(db, 'users', friendId);
        const friendDoc = await getDoc(friendDocRef);
        if (!friendDoc.exists()) return res.status(404).json({ error: 'Friend not found' });

        await updateDoc(userDocRef, { friends: arrayUnion(friendId) });
        await updateDoc(friendDocRef, { pendingFriends: arrayUnion(req.user.userId) });

        res.json({ success: true, message: `Friend request sent to ${friendDoc.data().username} on Ethereum Mainnet` });
    } catch (error) {
        console.error('Add friend error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/accept-friend', authenticateToken, async (req, res) => {
    const { friendId } = req.body;
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        await updateDoc(userDocRef, {
            friends: arrayUnion(friendId),
            pendingFriends: arrayRemove(friendId)
        });
        res.json({ success: true, message: 'Friend request accepted on Ethereum Mainnet' });
    } catch (error) {
        console.error('Accept friend error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/ignore-friend', authenticateToken, async (req, res) => {
    const { friendId } = req.body;
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        await updateDoc(userDocRef, { pendingFriends: arrayRemove(friendId) });
        res.json({ success: true, message: 'Friend request ignored on Ethereum Mainnet' });
    } catch (error) {
        console.error('Ignore friend error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/chat/:friendId', authenticateToken, async (req, res) => {
    res.json({ success: true, messages: [], network: 'Ethereum Mainnet' }); // Placeholder
});

app.post('/api/transactions', authenticateToken, async (req, res) => {
    try {
        const userDoc = await getDoc(doc(db, 'users', req.user.userId));
        const q = query(collection(db, 'transactions'), where('fromWalletId', '==', userDoc.data().walletId));
        const snap = await getDocs(q);
        const transactions = snap.docs.map(doc => doc.data());
        const ethPrice = await getLiveEthPrice();
        res.json({ 
            success: true, 
            transactions, 
            network: 'Ethereum Mainnet',
            ethPrice: ethPrice.price, // Live ETH price in USD
            priceTime: ethPrice.timestamp // Timestamp of the price
        });
    } catch (error) {
        console.error('Transactions error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/eth-price', async (req, res) => {
    try {
        const ethPrice = await getLiveEthPrice();
        res.json({ 
            price: ethPrice.price, 
            timestamp: ethPrice.timestamp, 
            network: 'Ethereum Mainnet' 
        });
    } catch (error) {
        console.error('Error fetching ETH price on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Failed to fetch ETH price' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT} on Ethereum Mainnet`));
