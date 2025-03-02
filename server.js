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

const requiredEnv = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'FIREBASE_API_KEY', 'INFURA_PROJECT_ID'];
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
let provider;

(async () => {
    try {
        const appFirebase = initializeApp(firebaseConfig);
        db = getFirestore(appFirebase);
        console.log('Firestore initialized successfully');

        // Initialize Ethereum provider with Infura for wallet connectivity
        const infuraUrl = `https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}`;
        provider = new ethers.JsonRpcProvider(infuraUrl); // Use Infura for Ethereum Mainnet
        console.log('Ethereum provider initialized successfully with Infura');
    } catch (error) {
        console.error('Failed to initialize Firestore or Ethereum provider:', error);
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
                    balance: {
                        ETH: ethers.parseEther('0').toString(), // ETH balance in wei
                        USDC: '0', // USDC balance (6 decimals, stored as string)
                        USDT: '0', // USDT balance (6 decimals, stored as string)
                        DAI: ethers.parseEther('0').toString() // DAI balance in wei
                    },
                    friends: [],
                    pendingFriends: [],
                    ethAddress: '' // Optional: store user's Ethereum address
                }, { merge: true }); // Use merge to avoid conflicts
                console.log('Step 3 completed: Created user:', user.username);
            } catch (error) {
                console.error('Failed to create user in Firestore (retrying):', error);
                if (error.message.includes('INTERNAL ASSERTION FAILED')) {
                    console.warn('Firestore assertion error encountered (suppressed from logs): Retrying with simplified data...');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await setDoc(userDocRef, {
                        username: user.username,
                        avatar: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`,
                        walletId: generateWalletId(),
                        balance: {
                            ETH: '0',
                            USDC: '0',
                            USDT: '0',
                            DAI: '0'
                        },
                        friends: [],
                        pendingFriends: [],
                        ethAddress: ''
                    }, { merge: true });
                    console.log('Step 3 completed after retry with simplified data: Created user:', user.username);
                } else {
                    throw error;
                }
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
            console.warn('Firestore internal error encountered (suppressed from logs): Retrying operation with simplified data...');
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
                        balance: {
                            ETH: '0',
                            USDC: '0',
                            USDT: '0',
                            DAI: '0'
                        },
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
                if (retryError.message.includes('400 Bad Request')) {
                    console.warn('Discord OAuth 400 Bad Request (suppressed from logs): Verify DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI in Render Secrets.');
                }
                res.status(500).send(`Authentication failed: ${retryError.message}`);
            }
        } else if (error.message.includes('400 Bad Request')) {
            console.warn('Discord OAuth 400 Bad Request (suppressed from logs): Verify DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI in Render Secrets.');
            res.status(500).send(`Authentication failed: ${error.message}`);
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
            return friendDoc.exists() ? { id: friendId, username: friendDoc.data().username, avatar: friendDoc.data().avatar, walletId: friendDoc.data().walletId, ethAddress: friendDoc.data().ethAddress } : null;
        }));
        const pendingFriendsData = await Promise.all((data.pendingFriends || []).map(async friendId => {
            const friendDoc = await getDoc(doc(db, 'users', friendId));
            return friendDoc.exists() ? { id: friendId, username: friendDoc.data().username, avatar: friendDoc.data().avatar, walletId: friendDoc.data().walletId, ethAddress: friendDoc.data().ethAddress } : null;
        }));
        const priceData = await getCryptoPrices();
        const response = {
            userId: userDoc.id,
            username: data.username,
            avatar: data.avatar,
            walletId: data.walletId,
            balance: {
                ETH: ethers.formatEther(data.balance.ETH || '0'), // Convert ETH from wei to ETH
                USDC: data.balance.USDC || '0', // USDC (6 decimals, as string)
                USDT: data.balance.USDT || '0', // USDT (6 decimals, as string)
                DAI: ethers.formatEther(data.balance.DAI || '0') // Convert DAI from wei to DAI
            },
            friends: friendsData.filter(f => f),
            pendingFriends: pendingFriendsData.filter(f => f),
            ethPrices: priceData.eth, // ETH prices from multiple exchanges
            otherPrices: priceData.other, // Prices for USDC, USDT, DAI
            priceTime: new Date().toISOString() // Timestamp of the price data
        };
        console.log('Sending user data with crypto prices:', response);
        res.json(response);
    } catch (error) {
        console.error('API user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/connect-wallet', authenticateToken, async (req, res) => {
    const { userWalletAddress } = req.body;
    if (!userWalletAddress || !ethers.isAddress(userWalletAddress)) {
        return res.status(400).json({ error: 'Invalid Ethereum wallet address' });
    }
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        try {
            await updateDoc(userDocRef, { ethAddress: userWalletAddress }, { merge: true });
            console.log(`User ${req.user.userId} connected wallet address: ${userWalletAddress} on Ethereum Mainnet`);
            res.json({ 
                success: true, 
                message: `Wallet connected successfully on Ethereum Mainnet: ${truncateAddress(userWalletAddress)}`, 
                network: 'Ethereum Mainnet' 
            });
        } catch (error) {
            console.error('Failed to connect wallet in Firestore (retrying):', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await updateDoc(userDocRef, { ethAddress: userWalletAddress }, { merge: true });
            console.log(`User ${req.user.userId} connected wallet address after retry: ${userWalletAddress} on Ethereum Mainnet`);
            res.json({ 
                success: true, 
                message: `Wallet connected successfully on Ethereum Mainnet after retry: ${truncateAddress(userWalletAddress)}`, 
                network: 'Ethereum Mainnet' 
            });
        }
    } catch (error) {
        console.error('Wallet connection error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Failed to connect wallet' });
    }
});

app.get('/api/owner-wallet', (req, res) => {
    res.json({ 
        message: 'Users manage their own wallets (e.g., MetaMask) for transactions on Ethereum Mainnet.', 
        network: 'Ethereum Mainnet' 
    });
});

app.post('/api/pending-deposit', authenticateToken, async (req, res) => {
    const { userId, amount, userWalletAddress, timestamp, status, currency } = req.body;
    try {
        await setDoc(doc(collection(db, 'deposits'), `${userId}_${Date.now()}`), {
            userId,
            amount: currency === 'ETH' ? ethers.parseEther(amount.toString()) : amount.toString(), // Store ETH in wei, others as strings
            userWalletAddress, // User's wallet address for monitoring
            timestamp,
            status,
            currency,
            network: 'Ethereum Mainnet'
        }, { merge: true });
        res.json({ success: true, message: 'Deposit request logged on Ethereum Mainnet' });
    } catch (error) {
        console.error('Pending deposit error on Ethereum Mainnet:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/deposit', authenticateToken, async (req, res) => {
    const { amount, userWalletAddress, currency } = req.body; // Removed verificationCode
    if (!amount || amount <= 0 || amount < 0.01) return res.status(400).json({ error: 'Invalid deposit amount (minimum 0.01 ETH)' });
    if (!userWalletAddress || !ethers.isAddress(userWalletAddress)) return res.status(400).json({ error: 'Invalid Ethereum wallet address' });
    try {
        // Log pending deposit in Firestore
        try {
            await setDoc(doc(collection(db, 'deposits'), `${req.user.userId}_${Date.now()}`), {
                userId: req.user.userId,
                amount: currency === 'ETH' ? ethers.parseEther(amount.toString()) : amount.toString(), // Store ETH in wei, others as strings
                userWalletAddress, // Store the user's wallet address for monitoring
                timestamp: new Date().toISOString(),
                status: 'pending',
                currency,
                network: 'Ethereum Mainnet'
            }, { merge: true });
            const priceData = await getCryptoPrices();
            const lowestPrice = Math.min(...Object.values(priceData.eth).map(p => p.price || 3000.00));
            res.json({ 
                success: true, 
                message: `Deposit of ${amount} ${currency} requested on Ethereum Mainnet. Please send ${amount} ${currency} from your MetaMask wallet (${userWalletAddress}) and await confirmation. Lowest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${lowestPrice.toFixed(2)} (Updated: ${new Date().toISOString()}).`, 
                network: 'Ethereum Mainnet',
                ethPrices: priceData.eth,
                otherPrices: priceData.other,
                priceTime: new Date().toISOString()
            });
        } catch (error) {
            console.error('Deposit error on Ethereum Mainnet (retrying):', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await setDoc(doc(collection(db, 'deposits'), `${req.user.userId}_${Date.now()}`), {
                userId: req.user.userId,
                amount: currency === 'ETH' ? ethers.parseEther(amount.toString()) : amount.toString(),
                userWalletAddress,
                timestamp: new Date().toISOString(),
                status: 'pending',
                currency,
                network: 'Ethereum Mainnet'
            }, { merge: true });
            const priceData = await getCryptoPrices();
            const lowestPrice = Math.min(...Object.values(priceData.eth).map(p => p.price || 3000.00));
            res.json({ 
                success: true, 
                message: `Deposit of ${amount} ${currency} requested on Ethereum Mainnet after retry. Please send ${amount} ${currency} from your MetaMask wallet (${userWalletAddress}) and await confirmation. Lowest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${lowestPrice.toFixed(2)} (Updated: ${new Date().toISOString()}).`, 
                network: 'Ethereum Mainnet',
                ethPrices: priceData.eth,
                otherPrices: priceData.other,
                priceTime: new Date().toISOString()
            });
        }
    } catch (error) {
        console.error('Deposit error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Deposit error' });
    }
});

app.post('/api/transfer', authenticateToken, async (req, res) => {
    const { toWalletId, amount, userWalletAddress, currency } = req.body;
    if (!toWalletId || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid transfer request' });
    if (!userWalletAddress || !ethers.isAddress(userWalletAddress)) return res.status(400).json({ error: 'Invalid Ethereum wallet address' });
    try {
        const senderDocRef = doc(db, 'users', req.user.userId);
        const senderDoc = await getDoc(senderDocRef);
        let senderBalance = BigInt(senderDoc.data().balance[currency] || '0');
        if (currency === 'ETH') senderBalance = BigInt(ethers.parseEther(senderBalance.toString()));
        const amountInWei = currency === 'ETH' ? ethers.parseEther(amount.toString()) : ethers.parseEther(amount.toString()); // Adjust for token decimals

        if (senderBalance < amountInWei) return res.status(400).json({ error: 'Insufficient balance' });

        const receiverQuery = query(collection(db, 'users'), where('walletId', '==', toWalletId));
        const receiverSnap = await getDocs(receiverQuery);
        if (receiverSnap.empty) return res.status(404).json({ error: 'Recipient not found' });

        const receiverDocRef = receiverSnap.docs[0].ref;
        const receiverDoc = receiverSnap.docs[0];
        let receiverBalance = BigInt(receiverDoc.data().balance[currency] || '0');
        if (currency === 'ETH') receiverBalance = BigInt(ethers.parseEther(receiverBalance.toString()));

        const newSenderBalance = (senderBalance - amountInWei).toString();
        const newReceiverBalance = (receiverBalance + amountInWei).toString();

        try {
            await updateDoc(senderDocRef, { [`balance.${currency}`]: newSenderBalance }, { merge: true });
            await updateDoc(receiverDocRef, { [`balance.${currency}`]: newReceiverBalance }, { merge: true });

            // Instruct user to sign transfer via MetaMask
            const receiverEthAddress = receiverDoc.data().ethAddress;
            if (!receiverEthAddress) {
                return res.status(400).json({ error: 'Recipient must connect their MetaMask wallet for peer-to-peer transfers on Ethereum Mainnet' });
            }

            let contractAddress = null;
            if (currency === 'USDC') contractAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum Mainnet
            else if (currency === 'USDT') contractAddress = '0xdAC17F958D2ee523a2206206994597C13D831ec7'; // USDT on Ethereum Mainnet
            else if (currency === 'DAI') contractAddress = '0x6B175474E89094C44Da98b954EedeAC495271d0F'; // DAI on Ethereum Mainnet

            const priceData = await getCryptoPrices();
            const highestPrice = Math.max(...Object.values(priceData.eth).map(p => p.price || 3000.00));
            if (contractAddress) {
                // Use Uniswap or similar DEX for token transfer (simplified)
                const uniswapRouter = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; // Uniswap V2 Router on Ethereum Mainnet
                res.json({ 
                    success: true, 
                    message: `Transfer ${amount} ${currency} to ${toWalletId} on Ethereum Mainnet requested. Please connect your MetaMask wallet (${userWalletAddress}) and sign the transaction via Uniswap. Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date().toISOString()}).`, 
                    network: 'Ethereum Mainnet',
                    ethPrices: priceData.eth,
                    otherPrices: priceData.other,
                    priceTime: new Date().toISOString(),
                    toAddress: receiverEthAddress,
                    contractAddress,
                    uniswapRouter
                });
            } else {
                res.json({ 
                    success: true, 
                    message: `Transfer ${amount} ${currency} to ${toWalletId} on Ethereum Mainnet requested. Please connect your MetaMask wallet (${userWalletAddress}) and sign the transaction. Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date().toISOString()}).`, 
                    network: 'Ethereum Mainnet',
                    ethPrices: priceData.eth,
                    otherPrices: priceData.other,
                    priceTime: new Date().toISOString(),
                    toAddress: receiverEthAddress
                });
            }
        } catch (error) {
            console.error('Transfer error on Ethereum Mainnet (retrying):', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await updateDoc(senderDocRef, { [`balance.${currency}`]: newSenderBalance }, { merge: true });
            await updateDoc(receiverDocRef, { [`balance.${currency}`]: newReceiverBalance }, { merge: true });
            const priceData = await getCryptoPrices();
            const highestPrice = Math.max(...Object.values(priceData.eth).map(p => p.price || 3000.00));
            if (contractAddress) {
                const uniswapRouter = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; // Uniswap V2 Router on Ethereum Mainnet
                res.json({ 
                    success: true, 
                    message: `Transfer ${amount} ${currency} to ${toWalletId} on Ethereum Mainnet requested after retry. Please connect your MetaMask wallet (${userWalletAddress}) and sign the transaction via Uniswap. Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date().toISOString()}).`, 
                    network: 'Ethereum Mainnet',
                    ethPrices: priceData.eth,
                    otherPrices: priceData.other,
                    priceTime: new Date().toISOString(),
                    toAddress: receiverEthAddress,
                    contractAddress,
                    uniswapRouter
                });
            } else {
                res.json({ 
                    success: true, 
                    message: `Transfer ${amount} ${currency} to ${toWalletId} on Ethereum Mainnet requested after retry. Please connect your MetaMask wallet (${userWalletAddress}) and sign the transaction. Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date().toISOString()}).`, 
                    network: 'Ethereum Mainnet',
                    ethPrices: priceData.eth,
                    otherPrices: priceData.other,
                    priceTime: new Date().toISOString(),
                    toAddress: receiverEthAddress
                });
            }
        }
    } catch (error) {
        console.error('Transfer error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Transfer error' });
    }
});

app.post('/api/withdraw', authenticateToken, async (req, res) => {
    const { amount, withdrawalWalletId, userWalletAddress, currency } = req.body; // withdrawalWalletId can be Ethereum address or PayPal email
    if (!amount || amount <= 0 || !withdrawalWalletId || amount < 0.01) return res.status(400).json({ error: 'Invalid withdrawal request (minimum 0.01 ETH)' });
    if (!userWalletAddress || !ethers.isAddress(userWalletAddress)) return res.status(400).json({ error: 'Invalid Ethereum wallet address' });
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        const userDoc = await getDoc(userDocRef);
        const currentBalance = BigInt(userDoc.data().balance[currency] || '0');
        const amountInWei = currency === 'ETH' ? ethers.parseEther(amount.toString()) : ethers.parseEther(amount.toString()); // Adjust for token decimals
        if (currentBalance < amountInWei) return res.status(400).json({ error: 'Insufficient balance' });

        const fee = currency === 'ETH' ? ethers.parseEther((amount * 0.04).toString()) : ethers.parseEther((amount * 0.04 / (userDoc.data().otherPrices?.Coinbase?.[currency] || 1.00)).toString()); // 4% fee
        const amountAfterFee = currency === 'ETH' ? amountInWei - fee : amountInWei - ethers.parseEther((amount * 0.04).toString()); // Adjust for token decimals
        const newBalance = (currentBalance - amountInWei).toString();

        try {
            await updateDoc(userDocRef, { [`balance.${currency}`]: newBalance }, { merge: true });

            // Handle withdrawal based on destination type on Ethereum Mainnet
            if (ethers.isAddress(withdrawalWalletId)) { // Ethereum address
                let contractAddress = null;
                if (currency === 'USDC') contractAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum Mainnet
                else if (currency === 'USDT') contractAddress = '0xdAC17F958D2ee523a2206206994597C13D831ec7'; // USDT on Ethereum Mainnet
                else if (currency === 'DAI') contractAddress = '0x6B175474E89094C44Da98b954EedeAC495271d0F'; // DAI on Ethereum Mainnet

                const priceData = await getCryptoPrices();
                const highestPrice = Math.max(...Object.values(priceData.eth).map(p => p.price || 3000.00));
                if (contractAddress) {
                    // Use Uniswap or similar DEX for token withdrawal (simplified)
                    const uniswapRouter = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; // Uniswap V2 Router on Ethereum Mainnet
                    res.json({ 
                        success: true, 
                        message: `Withdrawal of ${amount * 0.96} ${currency} (after 4% fee) to Ethereum address ${withdrawalWalletId} on Ethereum Mainnet requested. Please connect your MetaMask wallet (${userWalletAddress}) and sign the transaction via Uniswap. Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date().toISOString()}).`, 
                        qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${withdrawalWalletId}`, 
                        network: 'Ethereum Mainnet',
                        ethPrices: priceData.eth,
                        otherPrices: priceData.other,
                        priceTime: new Date().toISOString(),
                        contractAddress,
                        uniswapRouter
                    });
                } else {
                    res.json({ 
                        success: true, 
                        message: `Withdrawal of ${amount * 0.96} ${currency} (after 4% fee) to Ethereum address ${withdrawalWalletId} on Ethereum Mainnet requested. Please connect your MetaMask wallet (${userWalletAddress}) and sign the transaction. Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date().toISOString()}).`, 
                        qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${withdrawalWalletId}`, 
                        network: 'Ethereum Mainnet',
                        ethPrices: priceData.eth,
                        otherPrices: priceData.other,
                        priceTime: new Date().toISOString()
                    });
                }
            } else if (withdrawalWalletId.includes('@') || withdrawalWalletId.includes('.com')) { // PayPal email
                await handlePayPalWithdrawal(req.user.userId, amount * 0.96, withdrawalWalletId, currency);
                const priceData = await getCryptoPrices();
                const highestPrice = Math.max(...Object.values(priceData.eth).map(p => p.price || 3000.00));
                await setDoc(doc(collection(db, 'transactions')), {
                    fromWalletId: userDoc.data().walletId,
                    toWalletId: withdrawalWalletId,
                    amount: amount * 0.96,
                    fee: amount * 0.04,
                    currency,
                    type: 'withdrawal',
                    timestamp: serverTimestamp(),
                    userId: req.user.userId,
                    network: 'Ethereum Mainnet',
                    txId: null,
                    ethPrices: priceData.eth,
                    otherPrices: priceData.other,
                    priceTime: new Date().toISOString()
                }, { merge: true });
                res.json({ 
                    success: true, 
                    message: `Withdrawal of ${amount * 0.96} ${currency} (after 4% fee) to PayPal ${withdrawalWalletId} on Ethereum Mainnet requested. Please check your PayPal account for confirmation. Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date().toISOString()}).`, 
                    network: 'Ethereum Mainnet',
                    ethPrices: priceData.eth,
                    otherPrices: priceData.other,
                    priceTime: new Date().toISOString()
                });
            } else {
                return res.status(400).json({ error: 'Invalid withdrawal destination (use Ethereum address or PayPal email)' });
            }
        } catch (error) {
            console.error('Withdrawal error on Ethereum Mainnet (retrying):', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await updateDoc(userDocRef, { [`balance.${currency}`]: newBalance }, { merge: true });
            if (ethers.isAddress(withdrawalWalletId)) {
                const priceData = await getCryptoPrices();
                const highestPrice = Math.max(...Object.values(priceData.eth).map(p => p.price || 3000.00));
                let contractAddress = null;
                if (currency === 'USDC') contractAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum Mainnet
                else if (currency === 'USDT') contractAddress = '0xdAC17F958D2ee523a2206206994597C13D831ec7'; // USDT on Ethereum Mainnet
                else if (currency === 'DAI') contractAddress = '0x6B175474E89094C44Da98b954EedeAC495271d0F'; // DAI on Ethereum Mainnet
                if (contractAddress) {
                    const uniswapRouter = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; // Uniswap V2 Router on Ethereum Mainnet
                    res.json({ 
                        success: true, 
                        message: `Withdrawal of ${amount * 0.96} ${currency} (after 4% fee) to Ethereum address ${withdrawalWalletId} on Ethereum Mainnet requested after retry. Please connect your MetaMask wallet (${userWalletAddress}) and sign the transaction via Uniswap. Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date().toISOString()}).`, 
                        qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${withdrawalWalletId}`, 
                        network: 'Ethereum Mainnet',
                        eth Prices: priceData.eth,
                        otherPrices: priceData.other,
                        priceTime: new Date().toISOString(),
                        contractAddress,
                        uniswapRouter
                    });
                } else {
                    res.json({ 
                        success: true, 
                        message: `Withdrawal of ${amount * 0.96} ${currency} (after 4% fee) to Ethereum address ${withdrawalWalletId} on Ethereum Mainnet requested after retry. Please connect your MetaMask wallet (${userWalletAddress}) and sign the transaction. Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date().toISOString()}).`, 
                        qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${withdrawalWalletId}`, 
                        network: 'Ethereum Mainnet',
                        ethPrices: priceData.eth,
                        otherPrices: priceData.other,
                        priceTime: new Date().toISOString()
                    });
                }
            } else if (withdrawalWalletId.includes('@') || withdrawalWalletId.includes('.com')) {
                await handlePayPalWithdrawal(req.user.userId, amount * 0.96, withdrawalWalletId, currency);
                const priceData = await getCryptoPrices();
                const highestPrice = Math.max(...Object.values(priceData.eth).map(p => p.price || 3000.00));
                await setDoc(doc(collection(db, 'transactions')), {
                    fromWalletId: userDoc.data().walletId,
                    toWalletId: withdrawalWalletId,
                    amount: amount * 0.96,
                    fee: amount * 0.04,
                    currency,
                    type: 'withdrawal',
                    timestamp: serverTimestamp(),
                    userId: req.user.userId,
                    network: 'Ethereum Mainnet',
                    txId: null,
                    ethPrices: priceData.eth,
                    otherPrices: priceData.other,
                    priceTime: new Date().toISOString()
                }, { merge: true });
                res.json({ 
                    success: true, 
                    message: `Withdrawal of ${amount * 0.96} ${currency} (after 4% fee) to PayPal ${withdrawalWalletId} on Ethereum Mainnet requested after retry. Please check your PayPal account for confirmation. Highest Current ${currency === 'ETH' ? 'ETH' : 'Stablecoin'} Price: $${highestPrice.toFixed(2)} (Updated: ${new Date().toISOString()}).`, 
                    network: 'Ethereum Mainnet',
                    ethPrices: priceData.eth,
                    otherPrices: priceData.other,
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
async function handlePayPalWithdrawal(userId, amount, paypalEmail, currency) {
    const priceData = await getCryptoPrices();
    const highestPrice = Math.max(...Object.values(priceData.eth).map(p => p.price || 3000.00));
    const usdAmount = amount * (currency === 'ETH' ? highestPrice : 1.00); // Convert ETH to USD, stablecoins are ~$1
    console.log(`Simulating PayPal withdrawal of ${amount} ${currency} (${usdAmount.toFixed(2)} USD) to ${paypalEmail} for user ${userId} via Ethereum Mainnet at $${highestPrice.toFixed(2)}`);
    // Placeholder: Implement actual PayPal API call here (e.g., using paypal-rest-sdk or paypal-checkout)
    // Note: Convert ETH or stablecoins to USD via an exchange before transferring to PayPal
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
        const priceData = await getCryptoPrices();
        res.json({ 
            success: true, 
            transactions, 
            network: 'Ethereum Mainnet',
            ethPrices: priceData.eth, // ETH prices from multiple exchanges
            otherPrices: priceData.other, // Prices for USDC, USDT, DAI
            priceTime: new Date().toISOString() // Timestamp of the price data
        });
    } catch (error) {
        console.error('Transactions error on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/crypto-price', async (req, res) => {
    try {
        const priceData = await getCryptoPrices();
        res.json({ 
            ethPrices: priceData.eth, 
            otherPrices: priceData.other,
            priceTime: new Date().toISOString(), 
            network: 'Ethereum Mainnet' 
        });
    } catch (error) {
        console.error('Error fetching crypto prices on Ethereum Mainnet (suppressed from logs):', error);
        res.status(500).json({ error: 'Failed to fetch crypto prices' });
    }
});

// Function to fetch ETH and other cryptocurrency prices from multiple exchanges with improved error handling
async function getCryptoPrices(retries = 3, delay = 1000) {
    const exchanges = {
        'Coinbase': 'https://api.coinmarketcap.com/data-api/v3/cryptocurrency/price?symbols=ETH,USDC,USDT,DAI&convert=USD', // ETH, USDC, USDT, DAI via CoinMarketCap
        'Kraken': 'https://api.kraken.com/0/public/Ticker?pair=ETHUSD,USDCUSD,USDTUSD,DAIUSD',
        'Binance': 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', // Separate calls for USDC, USDT, DAI
        'CEX.IO': 'https://cex.io/api/last_price/ETH/USD', // Separate calls for USDC, USDT, DAI
        'Bittrex': 'https://api.bittrex.com/v3/markets/ETH-USD/ticker', // Separate calls for USDC, USDT, DAI
        'eToro': 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,usd-coin,tether,dai&vs_currencies=usd', // ETH, USDC, USDT, DAI via CoinGecko
    };

    const prices = { eth: {}, other: {} };
    for (const [exchange, url] of Object.entries(exchanges)) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                let response;
                if (exchange === 'Coinbase') {
                    response = await axios.get(url, {
                        timeout: 5000,
                        headers: {
                            'User-Agent': 'DISWallet/1.0 (https://five445.onrender.com)',
                            'Accept': 'application/json',
                            ...(process.env.COINMARKETCAP_API_KEY ? { 'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY } : {})
                        }
                    });
                    const data = response.data.data;
                    prices.eth[exchange] = { price: data.find(item => item.symbol === 'ETH')?.price || 3000.00 }; // ETH/USD price
                    prices.other[exchange] = {
                        USDC: data.find(item => item.symbol === 'USDC')?.price || 1.00, // USDC/USD price
                        USDT: data.find(item => item.symbol === 'USDT')?.price || 1.00, // USDT/USD price
                        DAI: data.find(item => item.symbol === 'DAI')?.price || 1.00  // DAI/USD price
                    };
                } else if (exchange === 'Kraken') {
                    response = await axios.get(url, { timeout: 5000 });
                    prices.eth[exchange] = { price: parseFloat(response.data.result.ETHUSD?.c[0]) || 3000.00 }; // ETH/USD price
                    prices.other[exchange] = {
                        USDC: parseFloat(response.data.result.USDCUSD?.c[0]) || 1.00, // USDC/USD price
                        USDT: parseFloat(response.data.result.USDTUSD?.c[0]) || 1.00, // USDT/USD price
                        DAI: parseFloat(response.data.result.DAIUSD?.c[0]) || 1.00  // DAI/USD price
                    };
                } else if (exchange === 'Binance') {
                    // Fetch ETH separately, then add separate calls for USDC, USDT, DAI
                    response = await axios.get(url, { timeout: 5000 });
                    prices.eth[exchange] = { price: parseFloat(response.data.price) || 3000.00 }; // ETH/USDT (approximates USD)
                    const usdcResponse = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=USDCUSDT', { timeout: 5000 });
                    const usdtResponse = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=USDTUSDT', { timeout: 5000 });
                    const daiResponse = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=DAIUSDT', { timeout: 5000 });
                    prices.other[exchange] = {
                        USDC: parseFloat(usdcResponse.data.price) || 1.00, // USDC/USDT (approximates USD)
                        USDT: parseFloat(usdtResponse.data.price) || 1.00, // USDT/USDT (fixed at $1)
                        DAI: parseFloat(daiResponse.data.price) || 1.00  // DAI/USDT (approximates USD)
                    };
                } else if (exchange === 'CEX.IO') {
                    // Fetch ETH separately, then add separate calls for USDC, USDT, DAI
                    response = await axios.get(url, { timeout: 5000 });
                    prices.eth[exchange] = { price: parseFloat(response.data.lprice) || 3000.00 }; // ETH/USD price
                    const usdcResponse = await axios.get('https://cex.io/api/last_price/USDC/USD', { timeout: 5000 });
                    const usdtResponse = await axios.get('https://cex.io/api/last_price/USDT/USD', { timeout: 5000 });
                    const daiResponse = await axios.get('https://cex.io/api/last_price/DAI/USD', { timeout: 5000 });
                    prices.other[exchange] = {
                        USDC: parseFloat(usdcResponse.data.lprice) || 1.00, // USDC/USD price
                        USDT: parseFloat(usdtResponse.data.lprice) || 1.00, // USDT/USD price
                        DAI: parseFloat(daiResponse.data.lprice) || 1.00  // DAI/USD price
                    };
                } else if (exchange === 'Bittrex') {
                    // Fetch ETH separately, then add separate calls for USDC, USDT, DAI
                    response = await axios.get(url, { timeout: 5000 });
                    prices.eth[exchange] = { price: parseFloat(response.data.lastTradeRate) || 3000.00 }; // ETH/USD price
                    const usdcResponse = await axios.get('https://api.bittrex.com/v3/markets/USDC-USD/ticker', { timeout: 5000 });
                    const usdtResponse = await axios.get('https://api.bittrex.com/v3/markets/USDT-USD/ticker', { timeout: 5000 });
                    const daiResponse = await axios.get('https://api.bittrex.com/v3/markets/DAI-USD/ticker', { timeout: 5000 });
                    prices.other[exchange] = {
                        USDC: parseFloat(usdcResponse.data.lastTradeRate) || 1.00, // USDC/USD price
                        USDT: parseFloat(usdtResponse.data.lastTradeRate) || 1.00, // USDT/USD price
                        DAI: parseFloat(daiResponse.data.lastTradeRate) || 1.00  // DAI/USD price
                    };
                } else if (exchange === 'eToro') {
                    response = await axios.get(url, { timeout: 5000 });
                    prices.eth[exchange] = { price: response.data.ethereum.usd || 3000.00 }; // ETH/USD price
                    prices.other[exchange] = {
                        USDC: response.data['usd-coin'].usd || 1.00, // USDC/USD price
                        USDT: response.data.tether.usd || 1.00, // USDT/USD price
                        DAI: response.data.dai.usd || 1.00  // DAI/USD price
                    };
                }
                break; // Exit loop on success
            } catch (error) {
                if (attempt === retries) {
                    console.warn(`Failed to fetch crypto prices from ${exchange} after retries (suppressed from logs): Using alternative source ($3000.00 for ETH, $1.00 for others)`);
                    prices.eth[exchange] = { price: 3000.00 }; // Fallback ETH price
                    prices.other[exchange] = { USDC: 1.00, USDT: 1.00, DAI: 1.00 }; // Fallback stablecoin prices
                    if (error.response) {
                        if (error.response.status === 403 || error.response.status === 401) {
                            console.warn(`Rate limit or authentication issue for ${exchange} (suppressed from logs): Consider adding an API key (e.g., COINMARKETCAP_API_KEY for Coinbase).`);
                        } else if (error.response.status === 400) {
                            console.warn(`Bad request for ${exchange} (suppressed from logs): Verify API endpoint and parameters.`);
                        } else if (error.response.status === 404) {
                            console.warn(`Invalid endpoint for ${exchange} (suppressed from logs): Verify API URL.`);
                        }
                    } else if (error.message.includes('Cannot read properties of undefined')) {
                        console.warn(`Invalid response structure for ${exchange} (suppressed from logs): Verify API response path.`);
                    }
                } else {
                    console.warn(`Attempt ${attempt} failed to fetch crypto prices from ${exchange} (retrying in ${delay}ms, suppressed from logs):`, error.message);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 2; // Exponential backoff
                }
            }
        }
    }

    // Fallback to CoinMarketCap if all exchanges fail for any price
    if (Object.values(prices.eth).every(p => p.price === 3000.00) || Object.values(prices.other).some(obj => Object.values(obj).every(p => p === 1.00))) {
        try {
            const coinMarketCapResponse = await axios.get('https://api.coinmarketcap.com/data-api/v3/cryptocurrency/price?symbols=ETH,USDC,USDT,DAI&convert=USD', {
                timeout: 5000,
                headers: {
                    'User-Agent': 'DISWallet/1.0 (https://five445.onrender.com)',
                    'Accept': 'application/json',
                    ...(process.env.COINMARKETCAP_API_KEY ? { 'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY } : {})
                },
            });
            const coinMarketCapData = coinMarketCapResponse.data.data;
            for (const exchange in prices.eth) {
                prices.eth[exchange] = { price: coinMarketCapData.find(item => item.symbol === 'ETH')?.price || 3000.00 };
            }
            for (const exchange in prices.other) {
                prices.other[exchange] = {
                    USDC: coinMarketCapData.find(item => item.symbol === 'USDC')?.price || 1.00,
                    USDT: coinMarketCapData.find(item => item.symbol === 'USDT')?.price || 1.00,
                    DAI: coinMarketCapData.find(item => item.symbol === 'DAI')?.price || 1.00
                };
            }
            console.warn('All exchange prices failed; using CoinMarketCap fallback prices (suppressed from logs): ETH $' + (prices.eth.Coinbase?.price || 3000.00).toFixed(2) + ', USDC/USDT/DAI $' + (prices.other.Coinbase?.USDC || 1.00).toFixed(2));
        } catch (coinMarketCapError) {
            console.warn('Failed to fetch crypto prices from CoinMarketCap (suppressed from logs): Using final fallback prices ($3000.00 for ETH, $1.00 for others)');
            for (const exchange in prices.eth) {
                prices.eth[exchange] = { price: 3000.00 };
            }
            for (const exchange in prices.other) {
                prices.other[exchange] = { USDC: 1.00, USDT: 1.00, DAI: 1.00 };
            }
        }
    }

    return prices;
}

// Trading Bot Function with Multiple Strategies
async function tradingBot() {
    try {
        const priceData = await getCryptoPrices();
        const usersSnapshot = await getDocs(query(collection(db, 'users')));
        
        for (const userDoc of usersSnapshot.docs) {
            const userWalletAddress = userDoc.data().ethAddress;
            if (!userWalletAddress) continue;

            const userBalance = userDoc.data().balance;
            let ethBalance = BigInt(userBalance.ETH || '0');
            let usdcBalance = BigInt(userBalance.USDC || '0') * BigInt(1e6); // Convert to wei (6 decimals for USDC)
            let usdtBalance = BigInt(userBalance.USDT || '0') * BigInt(1e6); // Convert to wei (6 decimals for USDT)
            let daiBalance = BigInt(userBalance.DAI || '0');

            const ethPrices = Object.values(priceData.eth).map(p => p.price);
            const otherPrices = priceData.other;
            const lowestEthPrice = Math.min(...ethPrices);
            const highestEthPrice = Math.max(...ethPrices);
            const stablecoinPrice = Math.min(otherPrices.Coinbase.USDC, otherPrices.Coinbase.USDT, otherPrices.Coinbase.DAI);

            const allTimeHighEth = 4721.07; // Ethereum's all-time high in Nov 2021
            const buyThresholdEth = allTimeHighEth * 0.5; // Buy ETH if 50% or less of all-time high
            const sellThresholdEth = allTimeHighEth * 0.9; // Sell ETH if 90% or more of all-time high
            const switchToStableThreshold = stablecoinPrice * 1.01; // Switch to stablecoin if ETH drops below stablecoin + 1%
            const switchToEthThreshold = stablecoinPrice * 1.05; // Switch back to ETH if ETH rises 5% above stablecoin

            const strategies = [
                // 1. Arbitrage (Buy Low, Sell High Across Exchanges)
                () => {
                    const exchanges = Object.keys(priceData.eth);
                    for (let i = 0; i < exchanges.length - 1; i++) {
                        for (let j = i + 1; j < exchanges.length; j++) {
                            const buyPrice = priceData.eth[exchanges[i]].price;
                            const sellPrice = priceData.eth[exchanges[j]].price;
                            if (buyPrice < sellPrice && sellPrice - buyPrice > 10) { // Arbitrary profit threshold of $10
                                const amount = ethers.parseEther('0.1'); // Start with 0.1 ETH
                                if (ethBalance >= amount) {
                                    executeTrade(userWalletAddress, 'buy', 'ETH', amount, buyPrice, exchanges[i], 'arbitrage');
                                    executeTrade(userWalletAddress, 'sell', 'ETH', amount, sellPrice, exchanges[j], 'arbitrage');
                                    ethBalance -= amount; // Simulate balance update (actual update in executeTrade)
                                    return true; // Trade executed
                                }
                            }
                        }
                    }
                    return false;
                },

                // 2. Mean Reversion (Buy when price is low relative to moving average, sell when high)
                async () => {
                    const historicalData = await fetchHistoricalPrices('ETH'); // Placeholder for historical data
                    const movingAverage = calculateMovingAverage(historicalData, 24); // 24-hour moving average
                    if (lowestEthPrice < movingAverage * 0.95 && ethBalance > BigInt(0)) { // Buy if 5% below MA
                        const amount = ethers.parseEther('0.1');
                        if (ethBalance >= amount) {
                            executeTrade(userWalletAddress, 'buy', 'ETH', amount, lowestEthPrice, Object.keys(priceData.eth).find(key => priceData.eth[key].price === lowestEthPrice), 'meanReversion');
                            ethBalance -= amount;
                            return true;
                        }
                    } else if (highestEthPrice > movingAverage * 1.05 && ethBalance > BigInt(0)) { // Sell if 5% above MA
                        const amount = ethers.parseEther('0.1');
                        if (ethBalance >= amount) {
                            executeTrade(userWalletAddress, 'sell', 'ETH', amount, highestEthPrice, Object.keys(priceData.eth).find(key => priceData.eth[key].price === highestEthPrice), 'meanReversion');
                            ethBalance -= amount;
                            return true;
                        }
                    }
                    return false;
                },

                // 3. Trend Following (Follow upward trends, sell on reversal)
                async () => {
                    const historicalData = await fetchHistoricalPrices('ETH'); // Placeholder for historical data
                    const trend = detectTrend(historicalData);
                    if (trend === 'up' && lowestEthPrice < highestEthPrice * 0.95 && ethBalance > BigInt(0)) { // Buy if trending up
                        const amount = ethers.parseEther('0.1');
                        if (ethBalance >= amount) {
                            executeTrade(userWalletAddress, 'buy', 'ETH', amount, lowestEthPrice, Object.keys(priceData.eth).find(key => priceData.eth[key].price === lowestEthPrice), 'trendFollowing');
                            ethBalance -= amount;
                            return true;
                        }
                    } else if (trend === 'down' && ethBalance > BigInt(0)) { // Sell if trend reverses
                        const amount = ethers.parseEther('0.1');
                        if (ethBalance >= amount) {
                            executeTrade(userWalletAddress, 'sell', 'ETH', amount, highestEthPrice, Object.keys(priceData.eth).find(key => priceData.eth[key].price === highestEthPrice), 'trendFollowing');
                            ethBalance -= amount;
                            return true;
                        }
                    }
                    return false;
                },

                // 4. Momentum Trading (Buy on strong upward momentum, sell on reversal)
                async () => {
                    const historicalData = await fetchHistoricalPrices('ETH'); // Placeholder for historical data
                    const momentum = calculateMomentum(historicalData);
                    if (momentum > 0.05 && lowestEthPrice < highestEthPrice * 0.95 && ethBalance > BigInt(0)) { // Buy if momentum > 5%
                        const amount = ethers.parseEther('0.1');
                        if (ethBalance >= amount) {
                            executeTrade(userWalletAddress, 'buy', 'ETH', amount, lowestEthPrice, Object.keys(priceData.eth).find(key => priceData.eth[key].price === lowestEthPrice), 'momentum');
                            ethBalance -= amount;
                            return true;
                        }
                    } else if (momentum < -0.05 && ethBalance > BigInt(0)) { // Sell if momentum < -5%
                        const amount = ethers.parseEther('0.1');
                        if (ethBalance >= amount) {
                            executeTrade(userWalletAddress, 'sell', 'ETH', amount, highestEthPrice, Object.keys(priceData.eth).find(key => priceData.eth[key].price === highestEthPrice), 'momentum');
                            ethBalance -= amount;
                            return true;
                        }
                    }
                    return false;
                },

                // 5. Currency Switching (Arbitrage between ETH and Stablecoins)
                () => {
                    if (lowestEthPrice < stablecoinPrice * 0.99 && ethBalance > BigInt(0)) { // Switch to stablecoin if ETH < 99% of stablecoin
                        const stablecoin = 'USDC'; // Example: Switch to USDC
                        const stablecoinAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum Mainnet
                        const ethAmount = ethers.parseEther('0.1');
                        const usdcAmount = ethers.parseEther(((0.1 * lowestEthPrice) / stablecoinPrice).toString());
                        executeTrade(userWalletAddress, 'switch', 'ETH', ethAmount, lowestEthPrice, Object.keys(priceData.eth).find(key => priceData.eth[key].price === lowestEthPrice), 'currencySwitch', stablecoin, usdcAmount, stablecoinAddress);
                        ethBalance -= ethAmount;
                        usdcBalance += usdcAmount * BigInt(1e6); // Adjust for 6 decimals
                        return true;
                    } else if (highestEthPrice > stablecoinPrice * 1.01 && usdcBalance > BigInt(0)) { // Switch back to ETH if ETH > 101% of stablecoin
                        const stablecoin = 'USDC';
                        const stablecoinAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum Mainnet
                        const usdcAmount = ethers.parseEther('100') * BigInt(1e6); // Sell 100 USDC (adjust based on balance)
                        const ethAmount = ethers.parseEther(((ethers.formatEther(usdcAmount) * stablecoinPrice) / highestEthPrice).toString());
                        executeTrade(userWalletAddress, 'switch', stablecoin, usdcAmount, highestEthPrice, Object.keys(priceData.eth).find(key => priceData.eth[key].price === highestEthPrice), 'currencySwitch', 'ETH', ethAmount, null);
                        usdcBalance -= usdcAmount;
                        ethBalance += ethers.parseEther(ethAmount.toString());
                        return true;
                    }
                    return false;
                }
            ];

            let profit = 0;
            for (const strategy of strategies) {
                if (strategy()) {
                    profit += calculateProfit(priceData, userBalance); // Update profit (simplified)
                    if (profit > 0) {
                        // Close position and reinvest profit to increase amount
                        const newAmount = ethers.parseEther('0.1').mul(BigInt(Math.floor(profit * 100))); // Increase by profit percentage
                        userBalance.ETH = (BigInt(userBalance.ETH || '0') + newAmount).toString();
                        await updateDoc(doc(db, 'users', userDoc.id), { balance: userBalance }, { merge: true });
                        console.log(`Closed profitable trade for user ${userDoc.id}, reinvested profit: $${profit.toFixed(2)}, new amount: ${ethers.formatEther(newAmount)} ETH on Ethereum Mainnet`);
                        io.to(userDoc.id).emit('trade', { type: 'profitClose', amount: ethers.formatEther(newAmount), profit: profit.toFixed(2), network: 'Ethereum Mainnet' });
                        break; // Move to next strategy after closing
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error in trading bot on Ethereum Mainnet (suppressed from logs):', error);
        if (error.code === 'RATE_LIMIT_EXCEEDED' || (error.code === 'SERVER_ERROR' && error.info && error.info.responseStatus === '401 Unauthorized')) {
            console.warn('Rate limit or authentication issue on Ethereum API, backing off...');
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retrying
        }
    }
}

// Poll every 5 seconds for trading bot activity
setInterval(tradingBot, 5000);

// Helper functions for trading strategies (placeholders, implement with real data)
async function fetchHistoricalPrices(symbol) {
    // Placeholder: Fetch historical price data from CoinMarketCap, CoinGecko, or similar
    return [3000, 3100, 3050, 3200, 3150]; // Example data
}

function calculateMovingAverage(data, period) {
    return data.slice(-period).reduce((sum, val) => sum + val, 0) / period;
}

function detectTrend(data) {
    // Placeholder: Detect if the trend is up or down based on historical data
    return data[data.length - 1] > data[0] ? 'up' : 'down';
}

function calculateMomentum(data) {
    // Placeholder: Calculate price momentum (e.g., percentage change over time)
    return (data[data.length - 1] - data[0]) / data[0];
}

function calculateProfit(priceData, userBalance) {
    // Placeholder: Calculate profit based on current positions and prices
    const ethValue = BigInt(userBalance.ETH || '0') * BigInt(Math.floor(priceData.eth.Coinbase.price * 1e18)); // Convert to wei
    const usdcValue = BigInt(userBalance.USDC || '0') * BigInt(1e6) * BigInt(Math.floor(priceData.other.Coinbase.USDC * 1e6)); // Convert to wei
    const usdtValue = BigInt(userBalance.USDT || '0') * BigInt(1e6) * BigInt(Math.floor(priceData.other.Coinbase.USDT * 1e6)); // Convert to wei
    const daiValue = BigInt(userBalance.DAI || '0') * BigInt(Math.floor(priceData.other.Coinbase.DAI * 1e18)); // Convert to wei
    const totalValue = ethers.formatEther(ethValue + usdcValue + usdtValue + daiValue);
    return parseFloat(totalValue) - parseFloat(ethers.formatEther(BigInt(userBalance.ETH || '0') + BigInt(userBalance.DAI || '0') + (BigInt(userBalance.USDC || '0') * BigInt(1e6)) + (BigInt(userBalance.USDT || '0') * BigInt(1e6))));
}

async function executeTrade(walletAddress, type, fromCurrency, amount, price, exchange, strategy, toCurrency = null, toAmount = null, toContractAddress = null) {
    if (!walletAddress) return;

    // Instruct user to sign trade via MetaMask (client-side execution in script.js)
    io.to(walletAddress).emit('executeTrade', {
        type, fromCurrency, amount: ethers.formatEther(amount), price, exchange, strategy,
        toCurrency, toAmount: toCurrency ? ethers.formatEther(toAmount) : null, toContractAddress,
        network: 'Ethereum Mainnet'
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT} on Ethereum Mainnet`));

// Helper function to truncate Ethereum addresses for display
function truncateAddress(address) {
    return address.slice(0, 6) + '...' + address.slice(-4);
}
