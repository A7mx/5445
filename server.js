require("dotenv").config();
const express = require("express");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const { initializeApp } = require("firebase/app");
const { getFirestore, doc, getDoc, setDoc, updateDoc, arrayUnion, collection, where, query, getDocs, serverTimestamp } = require("firebase/firestore");
const crypto = require("crypto");
const socketIo = require("socket.io");
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

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// Passport Discord OAuth2
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
app.use(express.static("public"));

// Encryption with IV
const algorithm = "aes-256-cbc";
const key = Buffer.from(process.env.ENCRYPTION_KEY, "utf8").slice(0, 32); // Ensure key is 32 bytes

const encrypt = (text) => {
  const iv = crypto.randomBytes(16); // Generate a random IV
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`; // Store IV with encrypted data
};

const decrypt = (encryptedData) => {
  const [ivHex, encrypted] = encryptedData.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};

// Routes
app.get("/auth/discord", passport.authenticate("discord"));
app.get(
  "/auth/discord/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => {
    res.redirect("/dashboard");
  }
);

app.get("/dashboard", (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/auth/discord");
  res.sendFile(__dirname + "/public/dashboard.html");
});

// API Endpoints
// Inside server.js, update the /api/user endpoint
app.get("/api/user", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");
  const userRef = doc(db, "users", req.user.id);
  const userDoc = await getDoc(userRef);
  if (!userDoc.exists()) {
    await setDoc(userRef, { balance: encrypt("1000"), friends: [] });
  }
  const data = userDoc.data() || { balance: encrypt("1000"), friends: [] };
  res.json({
    id: req.user.id,
    username: req.user.username,
    avatar: req.user.avatar, // Add avatar hash
    balance: decrypt(data.balance),
  });
});

// Add logout route
app.get("/auth/discord/logout", (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).send("Logout failed");
    res.redirect("/");
  });
});

app.post("/api/add-friend", express.json(), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");
  const friendId = req.body.friendId;
  const userRef = doc(db, "users", req.user.id);
  await updateDoc(userRef, { friends: arrayUnion(friendId) });
  res.send("Friend added");
});

app.post("/api/transfer", express.json(), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");
  const { toId, amount } = req.body;
  const userRef = doc(db, "users", req.user.id);
  const toRef = doc(db, "users", toId);
  const userDoc = await getDoc(userRef);
  const toDoc = await getDoc(toRef);

  let userBalance = parseInt(decrypt(userDoc.data().balance));
  let toBalance = toDoc.exists() ? parseInt(decrypt(toDoc.data().balance)) : 0;
  if (userBalance < amount) return res.status(400).send("Insufficient funds");

  const transId = crypto.randomBytes(8).toString("hex");
  await updateDoc(userRef, { balance: encrypt((userBalance - amount).toString()) });
  await setDoc(toRef, { balance: encrypt((toBalance + amount).toString()) }, { merge: true });
  await setDoc(doc(db, "transactions", transId), {
    from: req.user.id,
    to: toId,
    amount,
    timestamp: serverTimestamp(),
  });
  res.json({ transId });
});

app.get("/api/transactions", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");
  const transQuery = query(
    collection(db, "transactions"),
    where("from", "==", req.user.id)
  );
  const transDocs = await getDocs(transQuery);
  const transactions = transDocs.docs.map((doc) => doc.data());
  res.json(transactions);
});

// Start Server
const server = app.listen(process.env.PORT, () => console.log(`Server running on port ${process.env.PORT}`));
const io = socketIo(server);

// Real-Time Chat
io.on("connection", (socket) => {
  socket.on("join", (userId) => socket.join(userId));
  socket.on("chat", async ({ toId, message }) => {
    const fromId = socket.handshake.session.passport.user.id;
    io.to(toId).emit("chat", { from: fromId, message });
    io.to(fromId).emit("chat", { from: fromId, message });
  });
});