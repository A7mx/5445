require("dotenv").config();
const express = require("express");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const { initializeApp } = require("firebase/app");
const { getFirestore, doc, getDoc, setDoc, updateDoc, arrayUnion, arrayRemove, collection, where, query, getDocs, serverTimestamp, orderBy, limit } = require("firebase/firestore");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const socketIo = require("socket.io");
const path = require("path");
const QRCode = require("qrcode");
const app = express();

// Firebase Config
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID,
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

passport.use(
  new DiscordStrategy(
    {
      clientID: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      callbackURL: process.env.DISCORD_REDIRECT_URI,
      scope: ["identify"],
    },
    (accessToken, refreshToken, profile, done) => {
      return done(null, profile);
    }
  )
);
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.use(require("express-session")({ secret: "DISWallet", resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const algorithm = "aes-256-cbc";
const key = Buffer.from(process.env.ENCRYPTION_KEY, "utf8").slice(0, 32);

const encrypt = (text) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
};

const decrypt = (encryptedData) => {
  const [ivHex, encrypted] = encryptedData.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};

function generateSecureWalletId() {
  const randomBytes = crypto.randomBytes(32); // 256 bits
  const hex = randomBytes.toString("hex"); // 64 characters
  const base64 = Buffer.from(hex).toString("base64"); // Additional obfuscation
  return `${hex}_${base64}`.slice(0, 64); // Limit to 64 chars for practicality
}

const OWNER_WALLET_ID = process.env.OWNER_WALLET_ID || generateSecureWalletId();

// Routes
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>DISWallet - Secure Crypto Wallet</title>
      <link rel="stylesheet" href="/styles/landing.css">
      <link href="https://fonts.googleapis.com/css2?family=Orbitron&family=Roboto:wght@400;700&display=swap" rel="stylesheet">
    </head>
    <body>
      <header>
        <h1>DISWallet</h1>
        <nav>
          <a href="#features">Features</a>
          <a href="#security">Security</a>
          <a href="/auth/discord" class="login-link">Login with Discord</a>
        </nav>
      </header>
      <section class="hero">
        <img src="/images/crypto-wallet-hero.jpg" alt="Crypto Wallet Hero" class="hero-image">
        <h2>Secure, Fast, and Easy Crypto Management</h2>
        <p>Deposit, transfer, and withdraw your digital assets with DISWallet.</p>
        <a href="/auth/discord" class="cta-button">Get Started</a>
      </section>
      <section id="features">
        <h2>Features</h2>
        <div class="feature-grid">
          <div class="feature-card">
            <h3>Deposit via Wallet ID</h3>
            <p>Scan or enter your unique wallet ID to deposit DIS securely.</p>
          </div>
          <div class="feature-card">
            <h3>Instant Transfers</h3>
            <p>Send DIS to friends or other wallets instantly using wallet IDs.</p>
          </div>
          <div class="feature-card">
            <h3>Withdraw with Fee</h3>
            <p>Withdraw your funds with a low 5% fee using your wallet ID.</p>
          </div>
        </div>
      </section>
      <section id="security">
        <h2>Why Trust DISWallet?</h2>
        <p>We prioritize your security with advanced encryption and Discord authentication.</p>
        <img src="/images/security-badge.png" alt="Security Badge" class="security-badge">
      </section>
      <footer>
        <p>© 2025 DISWallet. All rights reserved. | <a href="/terms">Terms</a> | <a href="/privacy">Privacy</a></p>
        <img src="/images/trust-badges.png" alt="Trust Badges" class="trust-badges">
      </footer>
    </body>
    </html>
  `);
});

app.get("/auth/discord", passport.authenticate("discord"));

app.get(
  "/auth/discord/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  async (req, res) => {
    const userRef = doc(db, "users", req.user.id);
    const userDoc = await getDoc(userRef);
    if (!userDoc.exists()) {
      await setDoc(userRef, {
        balance: encrypt("1000"),
        walletId: generateSecureWalletId(),
        friends: [],
        pendingFriends: [],
        username: req.user.username,
        avatar: req.user.avatar,
      });
    } else {
      await updateDoc(userRef, {
        username: req.user.username,
        avatar: req.user.avatar,
      });
    }
    res.redirect("/dashboard");
  }
);

app.get("/dashboard", (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/auth/discord");
  const filePath = path.join(__dirname, "public", "dashboard.html");
  res.sendFile(filePath, (err) => {
    if (err) res.status(500).send("Internal Server Error");
  });
});

app.get("/auth/discord/logout", (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).send("Logout failed");
    res.redirect("/");
  });
});

app.get("/api/user", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: "Unauthorized" });
  try {
    const userRef = doc(db, "users", req.user.id);
    const userDoc = await getDoc(userRef);
    if (!userDoc.exists()) {
      await setDoc(userRef, { balance: encrypt("1000"), walletId: generateSecureWalletId(), friends: [], pendingFriends: [], username: req.user.username || "Unknown", avatar: req.user.avatar || null });
    }
    const data = userDoc.data() || { balance: encrypt("1000"), walletId: generateSecureWalletId(), friends: [], pendingFriends: [], username: req.user.username || "Unknown", avatar: req.user.avatar || null };

    const friends = Array.isArray(data.friends) ? data.friends : [];
    const pendingFriends = Array.isArray(data.pendingFriends) ? data.pendingFriends : [];

    const friendsData = [];
    for (const friendId of friends) {
      if (!friendId) continue;
      const friendRef = doc(db, "users", friendId);
      const friendDoc = await getDoc(friendRef);
      if (friendDoc.exists()) {
        const friendData = friendDoc.data();
        friendsData.push({ id: friendId, username: friendData.username || "Unknown", avatar: friendData.avatar || null, walletId: friendData.walletId || "Unknown" });
      }
    }

    const pendingFriendsData = [];
    for (const friendId of pendingFriends) {
      if (!friendId) continue;
      const friendRef = doc(db, "users", friendId);
      const friendDoc = await getDoc(friendRef);
      if (friendDoc.exists()) {
        const friendData = friendDoc.data();
        pendingFriendsData.push({ id: friendId, username: friendData.username || "Unknown", avatar: friendData.avatar || null, walletId: friendData.walletId || "Unknown" });
      }
    }

    res.json({ success: true, id: req.user.id, username: data.username, avatar: data.avatar, balance: decrypt(data.balance), walletId: data.walletId, friends: friendsData, pendingFriends: pendingFriendsData });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch user data: " + error.message });
  }
});

app.get("/api/chat/:friendId", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: "Unauthorized" });
  try {
    const userId = req.user.id;
    const chatRef = collection(db, "chats");
    const chatQuery = query(chatRef, where("userIds", "array-contains", userId), orderBy("timestamp", "desc"), limit(50));
    const chatDocs = await getDocs(chatQuery);
    const messages = chatDocs.docs.map((doc) => doc.data()).filter((msg) => msg.userIds.includes(req.params.friendId)).sort((a, b) => a.timestamp?.seconds - b.timestamp?.seconds || 0);
    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.post("/api/add-friend", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: "Unauthorized" });
  const friendId = req.body.friendId;
  try {
    const friendRef = doc(db, "users", friendId);
    const friendDoc = await getDoc(friendRef);
    if (!friendDoc.exists()) {
      await setDoc(friendRef, { balance: encrypt("1000"), walletId: generateSecureWalletId(), friends: [], pendingFriends: [req.user.id], username: "Unknown", avatar: null });
    } else {
      await updateDoc(friendRef, { pendingFriends: arrayUnion(req.user.id) });
    }
    res.json({ success: true, message: "Friend request sent" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.post("/api/accept-friend", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: "Unauthorized" });
  const friendId = req.body.friendId;
  try {
    const userRef = doc(db, "users", req.user.id);
    await updateDoc(userRef, { friends: arrayUnion(friendId), pendingFriends: arrayRemove(friendId) });
    const friendRef = doc(db, "users", friendId);
    await updateDoc(friendRef, { friends: arrayUnion(req.user.id) });
    res.json({ success: true, message: "Friend accepted" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.post("/api/ignore-friend", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: "Unauthorized" });
  const friendId = req.body.friendId;
  try {
    const userRef = doc(db, "users", req.user.id);
    await updateDoc(userRef, { pendingFriends: arrayRemove(friendId) });
    res.json({ success: true, message: "Friend request ignored" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.post("/api/transfer", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: "Unauthorized" });
  const { toWalletId, amount } = req.body;
  try {
    const userRef = doc(db, "users", req.user.id);
    const userDoc = await getDoc(userRef);
    if (!userDoc.exists()) return res.status(404).json({ success: false, message: "Sender account not found" });

    const userData = userDoc.data();
    if (userData.walletId === toWalletId) return res.status(400).json({ success: false, message: "Cannot transfer money to your own wallet" });

    const OWNER_WALLET_ID = process.env.OWNER_WALLET_ID || generateSecureWalletId();
    if (toWalletId === OWNER_WALLET_ID) {
      let userBalance = parseInt(decrypt(userData.balance));
      if (userBalance < amount) return res.status(400).json({ success: false, message: "Insufficient funds" });

      await updateDoc(userRef, { balance: encrypt((userBalance - amount).toString()) });
      await setDoc(doc(db, "users", "owner"), { balance: encrypt((parseInt(decrypt((await getDoc(doc(db, "users", "owner"))).data()?.balance || "0")) + amount).toString()), walletId: OWNER_WALLET_ID }, { merge: true });
      await setDoc(doc(db, "transactions", crypto.randomBytes(8).toString("hex")), { fromWalletId: userData.walletId, toWalletId: OWNER_WALLET_ID, amount, timestamp: serverTimestamp(), type: "owner_transfer" });
      io.emit("transfer", { type: "owner", fromWalletId: userData.walletId, toWalletId: OWNER_WALLET_ID, amount });
      return res.json({ success: true, message: `Transferred ${amount} DIS to owner wallet successfully` });
    }

    const recipientQuery = query(collection(db, "users"), where("walletId", "==", toWalletId));
    const recipientDocs = await getDocs(recipientQuery);
    if (recipientDocs.empty) return res.status(404).json({ success: false, message: "Recipient wallet not found" });

    const recipientDoc = recipientDocs.docs[0];
    const recipientData = recipientDoc.data();

    let userBalance = parseInt(decrypt(userData.balance));
    let recipientBalance = parseInt(decrypt(recipientData.balance));
    if (userBalance < amount) return res.status(400).json({ success: false, message: "Insufficient funds" });

    await updateDoc(userRef, { balance: encrypt((userBalance - amount).toString()) });
    await updateDoc(doc(db, "users", recipientDoc.id), { balance: encrypt((recipientBalance + amount).toString()) });
    await setDoc(doc(db, "transactions", crypto.randomBytes(8).toString("hex")), { fromWalletId: userData.walletId, toWalletId: toWalletId, amount, timestamp: serverTimestamp() });
    io.emit("transfer", { type: "peer", fromWalletId: userData.walletId, toWalletId, amount });
    res.json({ success: true, message: `Transferred ${amount} DIS successfully` });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.post("/api/deposit", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: "Unauthorized" });
  const { amount, walletId } = req.body;
  try {
    const userRef = doc(db, "users", req.user.id);
    const userDoc = await getDoc(userRef);
    if (!userDoc.exists()) return res.status(404).json({ success: false, message: "User account not found" });

    const data = userDoc.data();
    if (data.walletId !== walletId) return res.status(400).json({ success: false, message: "Invalid wallet ID" });

    let currentBalance = parseInt(decrypt(data.balance));
    await updateDoc(userRef, { balance: encrypt((currentBalance + amount).toString()) });
    io.emit("transfer", { type: "deposit", walletId, amount });
    res.json({ success: true, message: `Deposited ${amount} DIS successfully` });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.get("/api/wallet-id", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: "Unauthorized" });
  try {
    const userRef = doc(db, "users", req.user.id);
    const userDoc = await getDoc(userRef);
    if (!userDoc.exists()) {
      await setDoc(userRef, { balance: encrypt("1000"), walletId: generateSecureWalletId(), friends: [], pendingFriends: [], username: req.user.username || "Unknown", avatar: req.user.avatar || null });
    }
    const data = userDoc.data() || { walletId: generateSecureWalletId() };
    const qrCode = await QRCode.toDataURL(data.walletId);
    res.json({ success: true, walletId: data.walletId, qrCode });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.post("/api/withdraw", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: "Unauthorized" });
  const { amount, withdrawalWalletId } = req.body;
  try {
    const userRef = doc(db, "users", req.user.id);
    const userDoc = await getDoc(userRef);
    if (!userDoc.exists()) return res.status(404).json({ success: false, message: "User account not found" });

    let userBalance = parseInt(decrypt(userDoc.data().balance));
    const fee = amount * 0.05; // 5% withdrawal fee
    const totalDeduction = amount + fee;

    if (userBalance < totalDeduction) return res.status(400).json({ success: false, message: "Insufficient funds including 5% withdrawal fee" });

    await updateDoc(userRef, { balance: encrypt((userBalance - totalDeduction).toString()) });

    const ownerRef = doc(db, "users", "owner");
    const ownerDoc = await getDoc(ownerRef);
    let ownerBalance = parseInt(decrypt(ownerDoc.data()?.balance || "0"));
    await updateDoc(ownerRef, { balance: encrypt((ownerBalance + fee).toString()) }, { merge: true });

    const qrCode = await QRCode.toDataURL(withdrawalWalletId);
    await setDoc(doc(db, "transactions", crypto.randomBytes(8).toString("hex")), { fromWalletId: userDoc.data().walletId, toWalletId: withdrawalWalletId, amount, fee, timestamp: serverTimestamp(), type: "withdrawal" });
    io.emit("transfer", { type: "withdrawal", fromWalletId: userDoc.data().walletId, toWalletId: withdrawalWalletId, amount, fee });
    res.json({ success: true, message: `Withdrawn ${amount} DIS successfully (5% fee: ${fee} DIS)`, qrCode });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.get("/api/transactions", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: "Unauthorized" });
  try {
    const userRef = doc(db, "users", req.user.id);
    const userDoc = await getDoc(userRef);
    if (!userDoc.exists()) return res.status(404).json({ success: false, message: "User not found" });
    const walletId = userDoc.data().walletId;
    const transQuery = query(collection(db, "transactions"), where("fromWalletId", "==", walletId));
    const transDocs = await getDocs(transQuery);
    const transactions = transDocs.docs.map((doc) => doc.data());
    res.json({ success: true, transactions });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.get("/api/chat/:friendId", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ success: false, message: "Unauthorized" });
  try {
    const userId = req.user.id;
    const chatRef = collection(db, "chats");
    const chatQuery = query(chatRef, where("userIds", "array-contains", userId), orderBy("timestamp", "desc"), limit(50));
    const chatDocs = await getDocs(chatQuery);
    const messages = chatDocs.docs.map((doc) => doc.data()).filter((msg) => msg.userIds.includes(req.params.friendId)).sort((a, b) => a.timestamp?.seconds - b.timestamp?.seconds || 0);
    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {});
const io = socketIo(server);

io.on("connection", (socket) => {
  socket.on("join", (userId) => {
    socket.join(userId);
    fetchChatHistoryForFriends(userId);
  });
  socket.on("chat", async ({ toId, message }) => {
    const fromId = socket.handshake.session.passport.user.id;
    const chatRef = doc(collection(db, "chats"), `${fromId}_${toId}_${Date.now()}`);
    await setDoc(chatRef, { userIds: [fromId, toId].sort(), message, from: fromId, timestamp: serverTimestamp() });
    io.to(toId).emit("chat", { from: fromId, message });
    io.to(fromId).emit("chat", { from: fromId, message });
  });
});

async function fetchChatHistoryForFriends(userId) {
  try {
    const userRef = doc(db, "users", userId);
    const userDoc = await getDoc(userRef);
    if (userDoc.exists()) {
      const data = userDoc.data();
      const friends = Array.isArray(data.friends) ? data.friends : [];
      for (const friendId of friends) {
        if (!friendId) continue;
        const chatQuery = query(collection(db, "chats"), where("userIds", "array-contains", userId), orderBy("timestamp", "desc"), limit(50));
        const chatDocs = await getDocs(chatQuery);
        chatDocs.forEach((doc) => {
          const message = doc.data();
          if (message.userIds.includes(friendId)) io.to(userId).emit("chat", { from: message.from, message: message.message });
        });
      }
    }
  } catch (error) {}
}
