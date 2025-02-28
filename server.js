require('dotenv').config();
const express = require('express');
const DiscordOAuth2 = require('discord-oauth2');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, updateDoc, arrayUnion, serverTimestamp, collection, query, where, getDocs } = require('firebase/firestore');
const bodyParser = require('body-parser');
const path = require('path');
const socketIo = require('socket.io');
const http = require('http');
const { REST } = require('bybit-api'); // Correct import for Bybit V5 API

const requiredEnv = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'FIREBASE_API_KEY', 'BYBIT_API_KEY', 'BYBIT_API_SECRET'];
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
try {
    const appFirebase = initializeApp(firebaseConfig);
    db = getFirestore(appFirebase);
    console.log('Firestore initialized successfully');
} catch (error) {
    console.error('Failed to initialize Firestore:', error);
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const oauth = new DiscordOAuth2();

// Initialize Bybit API with your provided credentials
const bybit = new REST({
    key: process.env.BYBIT_API_KEY,  // pPxTQty9kwgZCcoeMR
    secret: process.env.BYBIT_API_SECRET,  // gc93wnh5zpayfGcwmwHPXhpYcQ4sWW3PU9gT
    testnet: false, // Use mainnet for production
    recv_window: 5000, // Default request timeout window (adjust if needed for rate limit issues)
});

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
                balance: 0,  // USDT balance in Firestore (plain number)
                friends: [],
                pendingFriends: [],
                tronAddress: ''  // Optional: store user's Tron address
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
        const response = {
            userId: userDoc.id,
            username: data.username,
            avatar: data.avatar,
            walletId: data.walletId,
            balance: data.balance || 0,  // USDT balance
            friends: friendsData.filter(f => f),
            pendingFriends: pendingFriendsData.filter(f => f)
        };
        console.log('Sending user data:', response);
        res.json(response);
    } catch (error) {
        console.error('API user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/owner-wallet', (req, res) => {
    const ownerWallet = 'TEq4NrK2Sov4fJetbcV577JvK5FkzhLVYw'; // Use your Bybit USDT (TRC-20) custodial wallet address
    console.log('Returning owner wallet:', ownerWallet);
    res.json({ wallet: ownerWallet, qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${ownerWallet}` });
});

app.post('/api/pending-deposit', authenticateToken, async (req, res) => {
    const { userId, amount, timestamp, status } = req.body;
    try {
        await setDoc(doc(collection(db, 'deposits'), `${userId}_${Date.now()}`), {
            userId,
            amount,
            timestamp,
            status
        });
        res.json({ success: true, message: 'Deposit request logged' });
    } catch (error) {
        console.error('Pending deposit error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

async function monitorUSDTDeposits() {
    try {
        // Use Bybit API to check deposits to TEq4NrK2Sov4fJetbcV577JvK5FkzhLVYw
        const walletBalance = await bybit.getWalletBalance({ coin: 'USDT' });
        const deposits = walletBalance.result.list.find(w => w.walletId === 'TEq4NrK2Sov4fJetbcV577JvK5FkzhLVYw' && w.coin === 'USDT');
        if (deposits && deposits.balance > 0) { // Simplified check; adjust based on Bybit API response
            const amount = parseFloat(deposits.balance) / 1e6; // Convert to USDT (TRC-20 has 6 decimals)
            const depositsQuery = query(collection(db, 'deposits'), where('status', '==', 'pending'));
            const depositsSnap = await getDocs(depositsQuery);
            for (const doc of depositsSnap.docs) {
                const deposit = doc.data();
                if (deposit.amount === amount && deposit.userId) {
                    const userDocRef = doc(db, 'users', deposit.userId);
                    const userDoc = await getDoc(userDocRef);
                    const currentBalance = userDoc.data().balance || 0;
                    await updateDoc(userDocRef, { balance: currentBalance + amount });
                    await updateDoc(doc.ref, { status: 'completed', timestamp: serverTimestamp() });
                    io.to(deposit.userId).emit('transfer', { walletId: userDoc.data().walletId, amount, type: 'deposit' });
                    break;
                }
            }
        }
    } catch (error) {
        console.error('Error monitoring USDT deposits via Bybit API:', error);
        if (error.response && error.response.status === 429) { // Rate limit handling
            console.warn('Rate limit exceeded on Bybit API, backing off...');
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retrying
        }
    }
}

// Check every 5 seconds (5000 milliseconds) to avoid Bybit rate limits
setInterval(monitorUSDTDeposits, 5000);

app.post('/api/deposit', authenticateToken, async (req, res) => {
    const { amount, walletId, verificationCode } = req.body;
    if (!amount || amount <= 0 || !walletId || amount < 6) return res.status(400).json({ error: 'Invalid deposit amount (minimum 6 USDT)' });
    try {
        // Verify 2FA (simplified, integrate with Firebase Auth or TOTP)
        const userDoc = await getDoc(doc(db, 'users', req.user.userId));
        if (!userDoc.data().twoFactorSecret || !verificationCode) {
            return res.status(401).json({ error: '2FA verification required' });
        }
        // Add actual 2FA verification logic here

        // Log pending deposit via Bybit
        await setDoc(doc(collection(db, 'deposits'), `${req.user.userId}_${Date.now()}`), {
            userId: req.user.userId,
            amount,
            timestamp: new Date().toISOString(),
            status: 'pending'
        });
        res.json({ success: true, message: `Deposit of ${amount} USDT requested. Please send to wallet: TEq4NrK2Sov4fJetbcV577JvK5FkzhLVYw on Bybit and await confirmation.` });
    } catch (error) {
        console.error('Deposit error:', error);
        res.status(500).json({ error: 'Deposit error' });
    }
});

app.post('/api/transfer', authenticateToken, async (req, res) => {
    const { toWalletId, amount } = req.body;
    if (!toWalletId || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid transfer request' });
    try {
        const senderDocRef = doc(db, 'users', req.user.userId);
        const senderDoc = await getDoc(senderDocRef);
        const senderBalance = senderDoc.data().balance || 0;
        if (senderBalance < amount) return res.status(400).json({ error: 'Insufficient balance' });

        const receiverQuery = query(collection(db, 'users'), where('walletId', '==', toWalletId));
        const receiverSnap = await getDocs(receiverQuery);
        if (receiverSnap.empty) return res.status(404).json({ error: 'Recipient not found' });

        const receiverDocRef = receiverSnap.docs[0].ref;
        const receiverDoc = receiverSnap.docs[0];
        const receiverBalance = receiverDoc.data().balance || 0;

        const newSenderBalance = senderBalance - amount;
        const newReceiverBalance = receiverBalance + amount;

        await updateDoc(senderDocRef, { balance: newSenderBalance });
        await updateDoc(receiverDocRef, { balance: newReceiverBalance });

        // Use Bybit API to transfer USDT (simplified; adjust based on Bybit API)
        // Note: Bybit doesn’t directly support peer-to-peer transfers to external wallets via API; you’d need to withdraw to the recipient’s Tron address
        await bybit.createWithdrawal({
            coin: 'USDT',
            chain: 'TRC20',
            address: await getTronAddressFromWalletId(toWalletId), // Helper function to map walletId to Tron address
            amount: amount,
            timestamp: Date.now(),
        });

        io.to(req.user.userId).emit('transfer', { fromWalletId: senderDoc.data().walletId, toWalletId, amount, type: 'peer' });
        io.to(receiverDoc.id).emit('transfer', { fromWalletId: senderDoc.data().walletId, toWalletId, amount, type: 'peer' });

        res.json({ success: true, message: `Transferred ${amount} USDT to ${toWalletId} via Bybit` });
    } catch (error) {
        console.error('Transfer error:', error);
        res.status(500).json({ error: 'Transfer error' });
    }
});

// Helper function to map DISWallet walletId to Tron address (placeholder; adjust based on your needs)
async function getTronAddressFromWalletId(walletId) {
    const usersQuery = query(collection(db, 'users'), where('walletId', '==', walletId));
    const usersSnap = await getDocs(usersQuery);
    if (!usersSnap.empty) {
        const userDoc = usersSnap.docs[0];
        return userDoc.data().tronAddress || 'TEq4NrK2Sov4fJetbcV577JvK5FkzhLVYw'; // Default or fetch actual address
    }
    throw new Error('Wallet ID not found');
}

app.post('/api/withdraw', authenticateToken, async (req, res) => {
    const { amount, withdrawalWalletId } = req.body; // withdrawalWalletId can be Tron address or PayPal email
    if (!amount || amount <= 0 || !withdrawalWalletId || amount < 6) return res.status(400).json({ error: 'Invalid withdrawal request (minimum 6 USDT)' });
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        const userDoc = await getDoc(userDocRef);
        const currentBalance = userDoc.data().balance || 0;
        if (currentBalance < amount) return res.status(400).json({ error: 'Insufficient balance' });

        const fee = amount * 0.05; // 5% fee
        const amountAfterFee = amount - fee;
        const newBalance = currentBalance - amount;

        await updateDoc(userDocRef, { balance: newBalance });

        // Handle withdrawal based on destination type via Bybit API
        if (withdrawalWalletId.startsWith('T') || withdrawalWalletId.startsWith('41')) { // Tron address
            await bybit.createWithdrawal({
                coin: 'USDT',
                chain: 'TRC20',
                address: withdrawalWalletId,
                amount: amountAfterFee,
                timestamp: Date.now(),
            });
            await setDoc(doc(collection(db, 'transactions')), {
                fromWalletId: userDoc.data().walletId,
                toWalletId: withdrawalWalletId,
                amount: amountAfterFee,
                fee,
                type: 'withdrawal',
                timestamp: serverTimestamp(),
                userId: req.user.userId
            });
            res.json({ success: true, message: `Withdrawal of ${amountAfterFee} USDT (after 5% fee) to Tron address ${withdrawalWalletId} requested via Bybit.`, qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${withdrawalWalletId}` });
        } else if (withdrawalWalletId.includes('@') || withdrawalWalletId.includes('.com')) { // PayPal email
            await handlePayPalWithdrawal(req.user.userId, amountAfterFee, withdrawalWalletId);
            await setDoc(doc(collection(db, 'transactions')), {
                fromWalletId: userDoc.data().walletId,
                toWalletId: withdrawalWalletId,
                amount: amountAfterFee,
                fee,
                type: 'withdrawal',
                timestamp: serverTimestamp(),
                userId: req.user.userId
            });
            res.json({ success: true, message: `Withdrawal of ${amountAfterFee} USDT (after 5% fee) to PayPal ${withdrawalWalletId} requested via Bybit. Please check your PayPal account for confirmation.` });
        } else {
            return res.status(400).json({ error: 'Invalid withdrawal destination (use Tron address or PayPal email)' });
        }
    } catch (error) {
        console.error('Withdrawal error:', error);
        res.status(500).json({ error: 'Withdrawal error' });
    }
});

// Helper function for PayPal withdrawal (simplified, requires PayPal API integration)
async function handlePayPalWithdrawal(userId, amount, paypalEmail) {
    // Use PayPal API to convert USDT to USD and transfer to PayPal (requires PayPal Developer account and API keys)
    console.log(`Simulating PayPal withdrawal of ${amount} USDT to ${paypalEmail} for user ${userId} via Bybit`);
    // Placeholder: Implement actual PayPal API call here (e.g., using paypal-rest-sdk or paypal-checkout)
    // Note: Convert USDT to USD via Bybit or an exchange before transferring to PayPal
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

        res.json({ success: true, message: `Friend request sent to ${friendDoc.data().username}` });
    } catch (error) {
        console.error('Add friend error:', error);
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
        res.json({ success: true, message: 'Friend request accepted' });
    } catch (error) {
        console.error('Accept friend error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/ignore-friend', authenticateToken, async (req, res) => {
    const { friendId } = req.body;
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        await updateDoc(userDocRef, { pendingFriends: arrayRemove(friendId) });
        res.json({ success: true, message: 'Friend request ignored' });
    } catch (error) {
        console.error('Ignore friend error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/chat/:friendId', authenticateToken, async (req, res) => {
    res.json({ success: true, messages: [] }); // Placeholder
});

app.post('/api/transactions', authenticateToken, async (req, res) => {
    try {
        const userDoc = await getDoc(doc(db, 'users', req.user.userId));
        const q = query(collection(db, 'transactions'), where('fromWalletId', '==', userDoc.data().walletId));
        const snap = await getDocs(q);
        const transactions = snap.docs.map(doc => doc.data());
        res.json({ success: true, transactions });
    } catch (error) {
        console.error('Transactions error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
