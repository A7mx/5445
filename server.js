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

// Validate environment variables
const requiredEnv = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'FIREBASE_API_KEY', 'ENCRYPTION_KEY'];
requiredEnv.forEach(key => {
    if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
});

// Encryption setup
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32 bytes key from .env
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

// Initialize Firebase
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

// Initialize Express and Socket.io
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
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const sessionDoc = await getDoc(doc(db, 'sessions', token));
        if (!sessionDoc.exists()) return res.status(403).json({ error: 'Invalid token' });
        req.user = { userId: sessionDoc.data().userId };
        next();
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: 'Server error' });
    }
}

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/auth/discord', (req, res) => {
    const url = oauth.generateAuthUrl({
        clientId: process.env.DISCORD_CLIENT_ID,
        scope: ['identify', 'email'],
        redirectUri: process.env.DISCORD_REDIRECT_URI,
    });
    res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const tokenData = await oauth.tokenRequest({
            clientId: process.env.DISCORD_CLIENT_ID,
            clientSecret: process.env.DISCORD_CLIENT_SECRET,
            code,
            scope: ['identify', 'email'],
            grantType: 'authorization_code',
            redirectUri: process.env.DISCORD_REDIRECT_URI,
        });

        const user = await oauth.getUser(tokenData.access_token);
        const userDocRef = doc(db, 'users', user.id);
        const userDoc = await getDoc(userDocRef);
        if (!userDoc.exists()) {
            await setDoc(userDocRef, {
                username: user.username,
                avatar: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`,
                walletId: generateWalletId(),
                balance: encrypt('0'), // Encrypted balance
                friends: [],
                pendingFriends: []
            });
        }

        const sessionToken = generateToken();
        await setDoc(doc(db, 'sessions', sessionToken), {
            userId: user.id,
            createdAt: serverTimestamp()
        });

        res.redirect(`/dashboard.html?token=${sessionToken}`);
    } catch (error) {
        console.error('OAuth error:', error);
        res.status(500).send('Authentication failed');
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
    // Your USDT wallet address (e.g., TRC-20 or ERC-20)
    const ownerWallet = 'YOUR_USDT_WALLET_ADDRESS_HERE'; // Replace with your actual USDT wallet
    res.json({ wallet: ownerWallet, qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${ownerWallet}` });
});

app.post('/api/deposit', authenticateToken, async (req, res) => {
    const { amount, walletId } = req.body;
    if (!amount || amount <= 0 || walletId !== userData.walletId) return res.status(400).json({ error: 'Invalid deposit request' });
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

app.post('/api/withdraw', authenticateToken, async (req, res) => {
    const { amount, withdrawalWalletId } = req.body;
    if (!amount || amount <= 0 || !withdrawalWalletId) return res.status(400).json({ error: 'Invalid withdrawal request' });
    try {
        const userDocRef = doc(db, 'users', req.user.userId);
        const userDoc = await getDoc(userDocRef);
        const currentBalance = parseFloat(decrypt(userDoc.data().balance));
        if (currentBalance < amount) return res.status(400).json({ error: 'Insufficient balance' });
        const newBalance = currentBalance - amount;
        await updateDoc(userDocRef, { balance: encrypt(newBalance.toString()) });
        // Here you’d typically initiate a USDT transfer to withdrawalWalletId (manual or via API)
        res.json({ success: true, message: `Withdrawal of ${amount} USDT to ${withdrawalWalletId} requested. Processing soon.` });
    } catch (error) {
        res.status(500).json({ error: 'Withdrawal error' });
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

// Placeholder endpoints (to be expanded later)
app.post('/api/wallet-id', authenticateToken, async (req, res) => {
    const userDoc = await getDoc(doc(db, 'users', req.user.userId));
    res.json({ qrCode: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${userDoc.data().walletId}` });
});
app.post('/api/add-friend', authenticateToken, (req, res) => res.json({ success: true, message: 'Friend request sent (placeholder)' }));
app.post('/api/accept-friend', authenticateToken, (req, res) => res.json({ success: true, message: 'Friend accepted (placeholder)' }));
app.post('/api/ignore-friend', authenticateToken, (req, res) => res.json({ success: true, message: 'Friend ignored (placeholder)' }));
app.get('/api/chat/:friendId', authenticateToken, (req, res) => res.json({ success: true, messages: [] }));
app.post('/api/transactions', authenticateToken, (req, res) => res.json({ success: true, transactions: [] }));

io.on('connection', socket => {
    socket.on('join', userId => socket.join(userId));
    socket.on('chat', ({ toId, message }) => io.to(toId).emit('chat', { from: socket.auth.userId, message }));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
