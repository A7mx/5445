require('dotenv').config();
const express = require('express');
const DiscordOAuth2 = require('discord-oauth2');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, updateDoc, arrayUnion, serverTimestamp, collection, query, where, getDocs } = require('firebase/firestore');
const bodyParser = require('body-parser');
const path = require('path');
const socketIo = require('socket.io');
const http = require('http');
const crypto = require('crypto');

const requiredEnv = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'FIREBASE_API_KEY', 'ENCRYPTION_KEY', 'OWNER_USDT_WALLET'];
requiredEnv.forEach(key => {
    if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
});

const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
const IV_LENGTH = 16;

function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text.toString(), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    const [ivHex, encryptedHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

const appFirebase = initializeApp(firebaseConfig);
const db = getFirestore(appFirebase);

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const oauth = new DiscordOAuth2();

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

function generateToken() {
    return crypto.randomBytes(16).toString('hex');
}

function generateWalletId() {
    return `WAL-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
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
    console.log('Redirecting to Discord OAuth:', url);
    res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    console.log('Received OAuth callback with code:', code);

    if (!code) {
        console.error('No code provided in callback');
        return res.status(400).send('No authorization code provided');
    }

    try {
        console.log('Attempting to exchange code for token...');
        const tokenData = await oauth.tokenRequest({
            clientId: process.env.DISCORD_CLIENT_ID,
            clientSecret: process.env.DISCORD_CLIENT_SECRET,
            code,
            scope: ['identify', 'email'],
            grantType: 'authorization_code',
            redirectUri: process.env.DISCORD_REDIRECT_URI,
        });
        console.log('OAuth token received:', { access_token: tokenData.access_token, expires_in: tokenData.expires_in });

        console.log('Fetching user data with access token...');
        const user = await oauth.getUser(tokenData.access_token);
        console.log('Fetched Discord user:', { id: user.id, username: user.username, avatar: user.avatar });

        const userDocRef = doc(db, 'users', user.id);
        console.log('Checking Firestore for user:', user.id);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists()) {
            console.log('User does not exist, creating new user...');
            await setDoc(userDocRef, {
                username: user.username,
                avatar: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`,
                walletId: generateWalletId(),
                balance: encrypt('0'),
                friends: [],
                pendingFriends: []
            });
            console.log('Created user:', user.username);
        } else {
            console.log('User exists:', userDoc.data());
        }

        const sessionToken = generateToken();
        console.log('Generating session token:', sessionToken);
        await setDoc(doc(db, 'sessions', sessionToken), {
            userId: user.id,
            createdAt: serverTimestamp()
        });
        console.log('Session token saved to Firestore');

        const redirectUrl = `/dashboard.html?token=${sessionToken}`;
        console.log('Redirecting to:', redirectUrl);
        res.redirect(redirectUrl);
    } catch (error) {
        console.error('Error in OAuth callback:', error.message);
        if (error.response) {
            console.error('Error response data:', error.response.data);
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
            balance: parseFloat(decrypt(data.balance)),
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
    const ownerWallet = process.env.OWNER_USDT_WALLET;
    res.json({ wallet: ownerWallet, qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${ownerWallet}` });
});

app.post('/api/deposit', authenticateToken, async (req, res) => {
    const { amount, walletId } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid deposit amount' });
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        const userDoc = await getDoc(userDocRef);
        const currentBalance = parseFloat(decrypt(userDoc.data().balance));
        const newBalance = currentBalance + amount;
        await updateDoc(userDocRef, { balance: encrypt(newBalance.toString()) });
        res.json({ success: true, message: `Deposit of ${amount} USDT requested. Please send to owner wallet and await confirmation.` });
    } catch (error) {
        res.status(500).json({ error: 'Deposit error' });
    }
});

app.post('/api/transfer', authenticateToken, async (req, res) => {
    const { toWalletId, amount } = req.body;
    if (!toWalletId || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid transfer request' });
    try {
        const senderDocRef = doc(db, 'users', req.user.userId);
        const senderDoc = await getDoc(senderDocRef);
        const senderBalance = parseFloat(decrypt(senderDoc.data().balance));
        if (senderBalance < amount) return res.status(400).json({ error: 'Insufficient balance' });

        const receiverQuery = query(collection(db, 'users'), where('walletId', '==', toWalletId));
        const receiverSnap = await getDocs(receiverQuery);
        if (receiverSnap.empty) return res.status(404).json({ error: 'Recipient not found' });

        const receiverDocRef = receiverSnap.docs[0].ref;
        const receiverDoc = receiverSnap.docs[0];
        const receiverBalance = parseFloat(decrypt(receiverDoc.data().balance));

        const newSenderBalance = senderBalance - amount;
        const newReceiverBalance = receiverBalance + amount;

        await updateDoc(senderDocRef, { balance: encrypt(newSenderBalance.toString()) });
        await updateDoc(receiverDocRef, { balance: encrypt(newReceiverBalance.toString()) });

        io.to(req.user.userId).emit('transfer', { fromWalletId: senderDoc.data().walletId, toWalletId, amount, type: 'peer' });
        io.to(receiverDoc.id).emit('transfer', { fromWalletId: senderDoc.data().walletId, toWalletId, amount, type: 'peer' });

        res.json({ success: true, message: `Transferred ${amount} USDT to ${toWalletId}` });
    } catch (error) {
        console.error('Transfer error:', error);
        res.status(500).json({ error: 'Transfer error' });
    }
});

app.post('/api/withdraw', authenticateToken, async (req, res) => {
    const { amount, withdrawalWalletId } = req.body;
    if (!amount || amount <= 0 || !withdrawalWalletId) return res.status(400).json({ error: 'Invalid withdrawal request' });
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        const userDoc = await getDoc(userDocRef);
        const currentBalance = parseFloat(decrypt(userDoc.data().balance));
        if (currentBalance < amount) return res.status(400).json({ error: 'Insufficient balance' });

        const fee = amount * 0.05;
        const amountAfterFee = amount - fee;
        const newBalance = currentBalance - amount;
        await updateDoc(userDocRef, { balance: encrypt(newBalance.toString()) });

        await setDoc(doc(collection(db, 'transactions')), {
            fromWalletId: userDoc.data().walletId,
            toWalletId: withdrawalWalletId,
            amount: amountAfterFee,
            fee,
            type: 'withdrawal',
            timestamp: serverTimestamp()
        });

        res.json({ success: true, message: `Withdrawal of ${amountAfterFee} USDT (after 5% fee) to ${withdrawalWalletId} requested. Processing soon.` });
    } catch (error) {
        console.error('Withdrawal error:', error);
        res.status(500).json({ error: 'Withdrawal error' });
    }
});

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
        res.status(500).json({ error: 'Server error' });
    }
});

io.on('connection', socket => {
    console.log('Socket connected:', socket.id);
    socket.on('join', userId => socket.join(userId));
    socket.on('chat', ({ toId, message }) => io.to(toId).emit('chat', { from: req.user.userId, message }));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
