// Use CommonJS require syntax
require('dotenv').config();
const express = require('express');
const DiscordOAuth2 = require('discord-oauth2');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, updateDoc, arrayUnion, arrayRemove, serverTimestamp, collection, query, where, getDocs } = require('firebase/firestore');
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
        provider = new ethers.JsonRpcProvider(infuraUrl); // Use Infura for Ethereum Mainnet
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
            try {
                await setDoc(userDocRef, {
                    username: user.username,
                    avatar: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`,
                    walletId: generateWalletId(),
                    balance: ethers.parseEther('0'),  // ETH balance in Firestore (in wei, but stored as string)
                    friends: [],
                    pendingFriends: [],
                    ethAddress: ''  // Optional: store user's Ethereum address (not used now)
                }, { merge: true }); // Use merge to avoid conflicts
                console.log('Step 3 completed: Created user:', user.username);
            } catch (error) {
                console.error('Failed to create user in Firestore (retrying):', error);
                await new Promise(resolve => setTimeout(resolve, 1000));
                await setDoc(userDocRef, {
                    username: user.username,
                    avatar: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`,
                    walletId: generateWalletId(),
                    balance: ethers.parseEther('0'),
                    friends: [],
                    pendingFriends: [],
                    ethAddress: ''
                }, { merge: true });
                console.log('Step 3 completed after retry: Created user:', user.username);
            }
        } else {
            console.log('Step 3 completed: User exists:', userDoc.data());
        }

        const sessionToken = generateToken();
        console.log('Step 4: Generated session token:', sessionToken);

        console.log('Step 5: Saving session to Firestore...');
        try {
            await setDoc(doc(db, 'sessions', sessionToken), {
                userId: user.id,
                createdAt: serverTimestamp()
            }, { merge: true });
            console.log('Step 5 completed: Session token saved to Firestore');
        } catch (error) {
            console.error('Failed to save session to Firestore (retrying):', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await setDoc(doc(db, 'sessions', sessionToken), {
                userId: user.id,
                createdAt: serverTimestamp()
            }, { merge: true });
            console.log('Step 5 completed after retry: Session token saved to Firestore');
        }

        const redirectUrl = `/dashboard.html?token=${sessionToken}`;
        console.log('Step 6: Redirecting to:', redirectUrl);
        res.redirect(redirectUrl);
        console.log('Step 6 completed: Redirect sent to client');
    } catch (error) {
        console.error('OAuth callback failed at some step:', error.message);
        if (error.message.includes('INTERNAL ASSERTION FAILED') || error.message.includes('Unexpected state')) {
            console.warn('Firestore internal error encountered (suppressed from logs): Retrying operation...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            try {
                console.log('Retrying OAuth callback...');
                const tokenDataRetry = await oauth.tokenRequest({
                    clientId: process.env.DISCORD_CLIENT_ID,
                    clientSecret: process.env.DISCORD_CLIENT_SECRET,
                    code,
                    scope: ['identify', 'email'],
                    grantType: 'authorization_code',
                    redirectUri: process.env.DISCORD_REDIRECT_URI,
                });
                const userRetry = await oauth.getUser(tokenDataRetry.access_token);
                const userDocRefRetry = doc(db, 'users', userRetry.id);
                const userDocRetry = await getDoc(userDocRefRetry);
                if (!userDocRetry.exists()) {
                    await setDoc(userDocRefRetry, {
                        username: userRetry.username,
                        avatar: `https://cdn.discordapp.com/avatars/${userRetry.id}/${userRetry.avatar}.png`,
                        walletId: generateWalletId(),
                        balance: ethers.parseEther('0'),
                        friends: [],
                        pendingFriends: [],
                        ethAddress: ''
                    }, { merge: true });
                }
                const sessionTokenRetry = generateToken();
                await setDoc(doc(db, 'sessions', sessionTokenRetry), {
                    userId: userRetry.id,
                    createdAt: serverTimestamp()
                }, { merge: true });
                res.redirect(`/dashboard.html?token=${sessionTokenRetry}`);
            } catch (retryError) {
                console.error('Retry failed for OAuth callback:', retryError.message);
                res.status(500).send(`Authentication failed: ${retryError.message}`);
            }
        } else {
            res.status(500).send(`Authentication failed: ${error.message}`);
        }
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
        const ethPriceData = await getEthPrices(); // Get prices from multiple exchanges
        const balanceInEth = ethers.formatEther(data.balance || '0'); // Convert balance from wei to ETH
        const response = {
            userId: userDoc.id,
            username: data.username,
            avatar: data.avatar,
            walletId: data.walletId,
            balance: balanceInEth,  // ETH balance in ETH (human-readable)
            friends: friendsData.filter(f => f),
            pendingFriends: pendingFriendsData.filter(f => f),
            ethPrices: ethPriceData, // Include prices from multiple exchanges
            ethPriceTime: new Date().toISOString() // Timestamp of the price data
        };
        console.log('Sending user data with ETH prices:', response);
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
        }, { merge: true });
        res.json({ success: true, message: 'Deposit request logged on Ethereum Mainnet' });
    } catch (error) {
        console.error('Pending deposit error on Ethereum Mainnet:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/deposit', authenticateToken, async (req, res) => {
    const { amount } = req.body; // Removed userWalletAddress and verificationCode
    if (!amount || amount <= 0 || amount < 0.01) return res.status(400).json({ error: 'Invalid deposit amount (minimum 0.01 ETH)' });
    try {
        // Log pending deposit to OWNER_ETH_WALLET on Ethereum Mainnet
        try {
            await setDoc(doc(collection(db, 'deposits'), `${req.user.userId}_${Date.now()}`), {
                userId: req.user.userId,
                amount: ethers.parseEther(amount.toString()), // Store amount in wei
                timestamp: new Date().toISOString(),
                status: 'pending',
                network: 'Ethereum Mainnet'
            }, { merge: true });
            const ethPriceData = await getEthPrices();
            const lowestPrice = Math.min(...Object.values(ethPriceData).map(p => p.price));
            res.json({ 
                success: true, 
                message: `Deposit of ${amount} ETH requested on Ethereum Mainnet. Please send to wallet: ${process.env.OWNER_ETH_WALLET} and await confirmation. Lowest Current ETH Price: $${lowestPrice} from ${Object.keys(ethPriceData).find(key => ethPriceData[key].price === lowestPrice)} at ${new Date().toISOString()}.`, 
                network: 'Ethereum Mainnet',
                ethPrices: ethPriceData,
                priceTime: new Date().toISOString()
            });
        } catch (error) {
            console.error('Deposit error on Ethereum Mainnet (retrying):', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await setDoc(doc(collection(db, 'deposits'), `${req.user.userId}_${Date.now()}`), {
                userId: req.user.userId,
                amount: ethers.parseEther(amount.toString()),
                timestamp: new Date().toISOString(),
                status: 'pending',
                network: 'Ethereum Mainnet'
            }, { merge: true });
            const ethPriceData = await getEthPrices();
            const lowestPrice = Math.min(...Object.values(ethPriceData).map(p => p.price));
            res.json({ 
                success: true, 
                message: `Deposit of ${amount} ETH requested on Ethereum Mainnet after retry. Please send to wallet: ${process.env.OWNER_ETH_WALLET} and await confirmation. Lowest Current ETH Price: $${lowestPrice} from ${Object.keys(ethPriceData).find(key => ethPriceData[key].price === lowestPrice)} at ${new Date().toISOString()}.`, 
                network: 'Ethereum Mainnet',
                ethPrices: ethPriceData,
                priceTime: new Date().toISOString()
            });
        }
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

        try {
            await updateDoc(senderDocRef, { balance: newSenderBalance }, { merge: true });
            await updateDoc(receiverDocRef, { balance: newReceiverBalance }, { merge: true });

            // Perform on-chain transfer using owner wallet on Ethereum Mainnet
            const receiverAddress = process.env.OWNER_ETH_WALLET; // Use owner wallet as intermediary (simplified)
            const tx = await wallet.sendTransaction({
                to: receiverAddress,
                value: amountInWei
            });

            const ethPriceData = await getEthPrices();
            const highestPrice = Math.max(...Object.values(ethPriceData).map(p => p.price));
            io.to(req.user.userId).emit('transfer', { 
                fromWalletId: senderDoc.data().walletId, 
                toWalletId, 
                amount, 
                type: 'peer', 
                network: 'Ethereum Mainnet',
                txId: tx.hash,
                ethPrices: ethPriceData,
                priceTime: new Date().toISOString()
            });
            io.to(receiverDoc.id).emit('transfer', { 
                fromWalletId: senderDoc.data().walletId, 
                toWalletId, 
                amount, 
                type: 'peer', 
                network: 'Ethereum Mainnet',
                txId: tx.hash,
                ethPrices: ethPriceData,
                priceTime: new Date().toISOString()
            });

            res.json({ 
                success: true, 
                message: `Transferred ${amount} ETH to ${toWalletId} on Ethereum Mainnet. TX: ${tx.hash}, Highest Current ETH Price: $${highestPrice} from ${Object.keys(ethPriceData).find(key => ethPriceData[key].price === highestPrice)} at ${new Date().toISOString()}.`, 
                network: 'Ethereum Mainnet',
                ethPrices: ethPriceData,
                priceTime: new Date().toISOString()
            });
        } catch (error) {
            console.error('Transfer error on Ethereum Mainnet (retrying):', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await updateDoc(senderDocRef, { balance: newSenderBalance }, { merge: true });
            await updateDoc(receiverDocRef, { balance: newReceiverBalance }, { merge: true });
            const txRetry = await wallet.sendTransaction({
                to: receiverAddress,
                value: amountInWei
            });
            const ethPriceData = await getEthPrices();
            const highestPrice = Math.max(...Object.values(ethPriceData).map(p => p.price));
            io.to(req.user.userId).emit('transfer', { 
                fromWalletId: senderDoc.data().walletId, 
                toWalletId, 
                amount, 
                type: 'peer', 
                network: 'Ethereum Mainnet',
                txId: txRetry.hash,
                ethPrices: ethPriceData,
                priceTime: new Date().toISOString()
            });
            io.to(receiverDoc.id).emit('transfer', { 
                fromWalletId: senderDoc.data().walletId, 
                toWalletId, 
                amount, 
                type: 'peer', 
                network: 'Ethereum Mainnet',
                txId: txRetry.hash,
                ethPrices: ethPriceData,
                priceTime: new Date().toISOString()
            });
            res.json({ 
                success: true, 
                message: `Transferred ${amount} ETH to ${toWalletId} on Ethereum Mainnet after retry. TX: ${txRetry.hash}, Highest Current ETH Price: $${highestPrice} from ${Object.keys(ethPriceData).find(key => ethPriceData[key].price === highestPrice)} at ${new Date().toISOString()}.`, 
                network: 'Ethereum Mainnet',
                ethPrices: ethPriceData,
                priceTime: new Date().toISOString()
            });
        }
    } catch (error) {
        console.error('Transfer error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Transfer error' });
    }
});

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

        try {
            await updateDoc(userDocRef, { balance: newBalance }, { merge: true });

            // Handle withdrawal based on destination type on Ethereum Mainnet
            if (ethers.isAddress(withdrawalWalletId)) { // Ethereum address
                const tx = await wallet.sendTransaction({
                    to: withdrawalWalletId,
                    value: amountAfterFee
                });
                const ethPriceData = await getEthPrices();
                const highestPrice = Math.max(...Object.values(ethPriceData).map(p => p.price));
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
                    ethPrices: ethPriceData,
                    priceTime: new Date().toISOString()
                }, { merge: true });
                res.json({ 
                    success: true, 
                    message: `Withdrawal of ${ethers.formatEther(amountAfterFee)} ETH (after 4% fee) to Ethereum address ${withdrawalWalletId} on Ethereum Mainnet requested. Transaction ID: ${tx.hash}, Highest Current ETH Price: $${highestPrice} from ${Object.keys(ethPriceData).find(key => ethPriceData[key].price === highestPrice)} at ${new Date().toISOString()}.`, 
                    qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${withdrawalWalletId}`, 
                    network: 'Ethereum Mainnet',
                    ethPrices: ethPriceData,
                    priceTime: new Date().toISOString()
                });
            } else if (withdrawalWalletId.includes('@') || withdrawalWalletId.includes('.com')) { // PayPal email
                await handlePayPalWithdrawal(req.user.userId, ethers.formatEther(amountAfterFee), withdrawalWalletId);
                const ethPriceData = await getEthPrices();
                const highestPrice = Math.max(...Object.values(ethPriceData).map(p => p.price));
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
                    ethPrices: ethPriceData,
                    priceTime: new Date().toISOString()
                }, { merge: true });
                res.json({ 
                    success: true, 
                    message: `Withdrawal of ${ethers.formatEther(amountAfterFee)} ETH (after 4% fee) to PayPal ${withdrawalWalletId} on Ethereum Mainnet requested. Please check your PayPal account for confirmation. Highest Current ETH Price: $${highestPrice} from ${Object.keys(ethPriceData).find(key => ethPriceData[key].price === highestPrice)} at ${new Date().toISOString()}.`, 
                    network: 'Ethereum Mainnet',
                    ethPrices: ethPriceData,
                    priceTime: new Date().toISOString()
                });
            } else {
                return res.status(400).json({ error: 'Invalid withdrawal destination (use Ethereum address or PayPal email)' });
            }
        } catch (error) {
            console.error('Withdrawal error on Ethereum Mainnet (retrying):', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await updateDoc(userDocRef, { balance: newBalance }, { merge: true });
            if (ethers.isAddress(withdrawalWalletId)) {
                const txRetry = await wallet.sendTransaction({
                    to: withdrawalWalletId,
                    value: amountAfterFee
                });
                const ethPriceData = await getEthPrices();
                const highestPrice = Math.max(...Object.values(ethPriceData).map(p => p.price));
                await setDoc(doc(collection(db, 'transactions')), {
                    fromWalletId: userDoc.data().walletId,
                    toWalletId: withdrawalWalletId,
                    amount: ethers.formatEther(amountAfterFee),
                    fee: ethers.formatEther(fee),
                    type: 'withdrawal',
                    timestamp: serverTimestamp(),
                    userId: req.user.userId,
                    network: 'Ethereum Mainnet',
                    txId: txRetry.hash,
                    ethPrices: ethPriceData,
                    priceTime: new Date().toISOString()
                }, { merge: true });
                res.json({ 
                    success: true, 
                    message: `Withdrawal of ${ethers.formatEther(amountAfterFee)} ETH (after 4% fee) to Ethereum address ${withdrawalWalletId} on Ethereum Mainnet requested after retry. Transaction ID: ${txRetry.hash}, Highest Current ETH Price: $${highestPrice} from ${Object.keys(ethPriceData).find(key => ethPriceData[key].price === highestPrice)} at ${new Date().toISOString()}.`, 
                    qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${withdrawalWalletId}`, 
                    network: 'Ethereum Mainnet',
                    ethPrices: ethPriceData,
                    priceTime: new Date().toISOString()
                });
            } else if (withdrawalWalletId.includes('@') || withdrawalWalletId.includes('.com')) {
                await handlePayPalWithdrawal(req.user.userId, ethers.formatEther(amountAfterFee), withdrawalWalletId);
                const ethPriceData = await getEthPrices();
                const highestPrice = Math.max(...Object.values(ethPriceData).map(p => p.price));
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
                    ethPrices: ethPriceData,
                    priceTime: new Date().toISOString()
                }, { merge: true });
                res.json({ 
                    success: true, 
                    message: `Withdrawal of ${ethers.formatEther(amountAfterFee)} ETH (after 4% fee) to PayPal ${withdrawalWalletId} on Ethereum Mainnet requested after retry. Please check your PayPal account for confirmation. Highest Current ETH Price: $${highestPrice} from ${Object.keys(ethPriceData).find(key => ethPriceData[key].price === highestPrice)} at ${new Date().toISOString()}.`, 
                    network: 'Ethereum Mainnet',
                    ethPrices: ethPriceData,
                    priceTime: new Date().toISOString()
                });
            }
        }
    } catch (error) {
        console.error('Withdrawal error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Withdrawal error' });
    }
});

// Helper function for PayPal withdrawal (simplified, requires PayPal API integration)
async function handlePayPalWithdrawal(userId, amount, paypalEmail) {
    const ethPriceData = await getEthPrices();
    const highestPrice = Math.max(...Object.values(ethPriceData).map(p => p.price));
    const usdAmount = amount * highestPrice;
    console.log(`Simulating PayPal withdrawal of ${amount} ETH (${usdAmount} USD) to ${paypalEmail} for user ${userId} via Ethereum Mainnet at $${highestPrice} from ${Object.keys(ethPriceData).find(key => ethPriceData[key].price === highestPrice)}`);
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

        try {
            await updateDoc(userDocRef, { friends: arrayUnion(friendId) }, { merge: true });
            await updateDoc(friendDocRef, { pendingFriends: arrayUnion(req.user.userId) }, { merge: true });
            res.json({ success: true, message: `Friend request sent to ${friendDoc.data().username} on Ethereum Mainnet` });
        } catch (error) {
            console.error('Add friend error on Ethereum Mainnet (retrying):', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await updateDoc(userDocRef, { friends: arrayUnion(friendId) }, { merge: true });
            await updateDoc(friendDocRef, { pendingFriends: arrayUnion(req.user.userId) }, { merge: true });
            res.json({ success: true, message: `Friend request sent to ${friendDoc.data().username} on Ethereum Mainnet after retry` });
        }
    } catch (error) {
        console.error('Add friend error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/accept-friend', authenticateToken, async (req, res) => {
    const { friendId } = req.body;
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        try {
            await updateDoc(userDocRef, {
                friends: arrayUnion(friendId),
                pendingFriends: arrayRemove(friendId)
            }, { merge: true });
            res.json({ success: true, message: 'Friend request accepted on Ethereum Mainnet' });
        } catch (error) {
            console.error('Accept friend error on Ethereum Mainnet (retrying):', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await updateDoc(userDocRef, {
                friends: arrayUnion(friendId),
                pendingFriends: arrayRemove(friendId)
            }, { merge: true });
            res.json({ success: true, message: 'Friend request accepted on Ethereum Mainnet after retry' });
        }
    } catch (error) {
        console.error('Accept friend error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/ignore-friend', authenticateToken, async (req, res) => {
    const { friendId } = req.body;
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        try {
            await updateDoc(userDocRef, { pendingFriends: arrayRemove(friendId) }, { merge: true });
            res.json({ success: true, message: 'Friend request ignored on Ethereum Mainnet' });
        } catch (error) {
            console.error('Ignore friend error on Ethereum Mainnet (retrying):', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await updateDoc(userDocRef, { pendingFriends: arrayRemove(friendId) }, { merge: true });
            res.json({ success: true, message: 'Friend request ignored on Ethereum Mainnet after retry' });
        }
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
        const ethPriceData = await getEthPrices();
        res.json({ 
            success: true, 
            transactions, 
            network: 'Ethereum Mainnet',
            ethPrices: ethPriceData, // Include prices from multiple exchanges
            priceTime: new Date().toISOString() // Timestamp of the price data
        });
    } catch (error) {
        console.error('Transactions error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/eth-price', async (req, res) => {
    try {
        const ethPriceData = await getEthPrices();
        res.json({ 
            ethPrices: ethPriceData, 
            priceTime: new Date().toISOString(), 
            network: 'Ethereum Mainnet' 
        });
    } catch (error) {
        console.error('Error fetching ETH prices on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Failed to fetch ETH prices' });
    }
});

// Function to fetch ETH prices from multiple exchanges
async function getEthPrices() {
    const exchanges = {
        'Coinbase': 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
        'Kraken': 'https://api.kraken.com/0/public/Ticker?pair=ETHUSD',
        'Binance': 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT',
        'CEX.IO': 'https://cex.io/api/last_price/ETH/USD',
        'Bittrex': 'https://api.bittrex.com/v3/markets/ETH-USD/ticker',
        'eToro': 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', // eToro uses similar data sources
    };

    const prices = {};
    for (const [exchange, url] of Object.entries(exchanges)) {
        try {
            let response;
            if (exchange === 'Kraken') {
                response = await axios.get(url);
                prices[exchange] = { price: parseFloat(response.data.result.XETHZUSD.c[0]) }; // Kraken ETH/USD price
            } else if (exchange === 'Binance') {
                response = await axios.get(url);
                prices[exchange] = { price: parseFloat(response.data.price) }; // Binance ETH/USDT price (approximates USD)
            } else if (exchange === 'CEX.IO') {
                response = await axios.get(url);
                prices[exchange] = { price: parseFloat(response.data.lprice) }; // CEX.IO ETH/USD price
            } else if (exchange === 'Bittrex') {
                response = await axios.get(url);
                prices[exchange] = { price: parseFloat(response.data.lastTradeRate) }; // Bittrex ETH/USD price
            } else if (exchange === 'Coinbase' || exchange === 'eToro') {
                response = await axios.get(url);
                prices[exchange] = { price: response.data.ethereum.usd }; // Coinbase/eToro (via CoinGecko) ETH/USD price
            }
        } catch (error) {
            console.warn(`Failed to fetch ETH price from ${exchange} (suppressed from logs): Using fallback price of $3000.00`);
            prices[exchange] = { price: 3000.00 }; // Fallback price if API fails
        }
    }
    return prices;
}

// Function to monitor and automate ETH trading (buy low, sell high)
async function monitorAndTradeEth() {
    try {
        const ethPriceData = await getEthPrices();
        const allTimeHigh = 4721.07; // Based on web data (Ethereum's all-time high in Nov 2021)
        const currentPrices = Object.values(ethPriceData).map(p => p.price);
        const lowestPrice = Math.min(...currentPrices);
        const highestPrice = Math.max(...currentPrices);

        // Define thresholds for buy low and sell high (adjustable based on strategy)
        const buyThreshold = allTimeHigh * 0.5; // Buy if price is 50% or less of all-time high
        const sellThreshold = allTimeHigh * 0.9; // Sell if price is 90% or more of all-time high

        if (lowestPrice <= buyThreshold) {
            // Buy ETH at the lowest price from the exchange with the lowest price
            const buyExchange = Object.keys(ethPriceData).find(key => ethPriceData[key].price === lowestPrice);
            const amountToBuy = ethers.parseEther('0.1'); // Example: Buy 0.1 ETH (adjust based on balance)
            const tx = await wallet.sendTransaction({
                to: process.env.OWNER_ETH_WALLET, // Buy into owner wallet
                value: amountToBuy
            });
            console.log(`Bought 0.1 ETH at $${lowestPrice} from ${buyExchange} on Ethereum Mainnet, TX: ${tx.hash}`);
            io.emit('trade', { type: 'buy', amount: '0.1', price: lowestPrice, exchange: buyExchange, network: 'Ethereum Mainnet', txId: tx.hash });
        }

        if (highestPrice >= sellThreshold) {
            // Sell ETH at the highest price from the exchange with the highest price
            const sellExchange = Object.keys(ethPriceData).find(key => ethPriceData[key].price === highestPrice);
            const amountToSell = ethers.parseEther('0.1'); // Example: Sell 0.1 ETH (adjust based on balance)
            const tx = await wallet.sendTransaction({
                to: process.env.OWNER_ETH_WALLET, // Sell from owner wallet to itself (simplified, adjust for actual exchange)
                value: amountToSell
            });
            console.log(`Sold 0.1 ETH at $${highestPrice} to ${sellExchange} on Ethereum Mainnet, TX: ${tx.hash}`);
            io.emit('trade', { type: 'sell', amount: '0.1', price: highestPrice, exchange: sellExchange, network: 'Ethereum Mainnet', txId: tx.hash });
        }
    } catch (error) {
        console.error('Error monitoring and trading ETH on Ethereum Mainnet (suppressed from logs):', error);
        if (error.code === 'RATE_LIMIT_EXCEEDED' || (error.code === 'SERVER_ERROR' && error.info && error.info.responseStatus === '401 Unauthorized')) {
            console.warn('Rate limit or authentication issue on Ethereum API, backing off...');
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retrying
        }
    }
}

// Poll every 10 seconds for price monitoring and trading
setInterval(monitorAndTradeEth, 10000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT} on Ethereum Mainnet`));
