require("dotenv").config();
const express = require("express");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const { initializeApp } = require("firebase/app");
const { getFirestore, doc, getDoc, setDoc, updateDoc, arrayUnion, arrayRemove, collection, where, query, getDocs, serverTimestamp } = require("firebase/firestore");
const crypto = require("crypto");
const socketIo = require("socket.io");
const path = require("path");
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

// Routes
app.get("/", (req, res) => {
  console.log("Root route accessed");
  res.send("Welcome to DISWallet - <a href='/auth/discord'>Login</a>");
});

app.get("/auth/discord", passport.authenticate("discord"));

app.get(
  "/auth/discord/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => {
    console.log("Callback triggered, user:", req.user.id);
    res.redirect("/dashboard");
  }
);

app.get("/dashboard", (req, res) => {
  console.log("Dashboard route accessed");
  if (!req.isAuthenticated()) {
    console.log("User not authenticated, redirecting to /auth/discord");
    return res.redirect("/auth/discord");
  }
  const filePath = path.join(__dirname, "public", "dashboard.html");
  console.log("Serving file from:", filePath);
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error("Failed to send file:", err);
      res.status(500).send("Internal Server Error");
    }
  });
});

app.get("/auth/discord/logout", (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).send("Logout failed");
    res.redirect("/");
  });
});

app.get("/api/user", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");
  const userRef = doc(db, "users", req.user.id);
  const userDoc = await getDoc(userRef);
  if (!userDoc.exists()) {
    await setDoc(userRef, { balance: encrypt("1000"), friends: [], pendingFriends: [] });
  }
  const data = userDoc.data() || { balance: encrypt("1000"), friends: [], pendingFriends: [] };
  console.log("User data fetched:", { id: req.user.id, balance: decrypt(data.balance), friends: data.friends, pendingFriends: data.pendingFriends });
  res.json({
    id: req.user.id,
    username: req.user.username,
    avatar: req.user.avatar,
    balance: decrypt(data.balance),
    friends: data.friends,
    pendingFriends: data.pendingFriends,
  });
});

app.post("/api/add-friend", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");
  const friendId = req.body.friendId;
  console.log(`Friend request from ${req.user.id} to ${friendId}`);
  const friendRef = doc(db, "users", friendId);
  const friendDoc = await getDoc(friendRef);
  if (!friendDoc.exists()) {
    await setDoc(friendRef, { balance: encrypt("1000"), friends: [], pendingFriends: [req.user.id] });
  } else {
    await updateDoc(friendRef, { pendingFriends: arrayUnion(req.user.id) });
  }
  res.send("Friend request sent");
});

app.post("/api/accept-friend", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");
  const friendId = req.body.friendId;
  console.log(`Accepting friend ${friendId} for ${req.user.id}`);
  const userRef = doc(db, "users", req.user.id);
  await updateDoc(userRef, {
    friends: arrayUnion(friendId),
    pendingFriends: arrayRemove(friendId),
  });
  const friendRef = doc(db, "users", friendId);
  await updateDoc(friendRef, { friends: arrayUnion(req.user.id) });
  res.send("Friend accepted");
});

app.post("/api/ignore-friend", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");
  const friendId = req.body.friendId;
  console.log(`Ignoring friend ${friendId} for ${req.user.id}`);
  const userRef = doc(db, "users", req.user.id);
  await updateDoc(userRef, { pendingFriends: arrayRemove(friendId) });
  res.send("Friend request ignored");
});

app.post("/api/transfer", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");
  const { toId, amount } = req.body;
  console.log(`Transfer request: ${amount} from ${req.user.id} to ${toId}`);
  const userRef = doc(db, "users", req.user.id);
  const toRef = doc(db, "users", toId);
  const userDoc = await getDoc(userRef);
  const toDoc = await getDoc(toRef);

  let userBalance = parseInt(decrypt(userDoc.data().balance));
  let toBalance = toDoc.exists() ? parseInt(decrypt(toDoc.data().balance)) : 0;
  console.log(`Balances - From: ${userBalance}, To: ${toBalance}`);
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
  console.log(`Transfer completed: ${transId}`);
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
  console.log(`Transactions fetched for ${req.user.id}:`, transactions);
  res.json(transactions);
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Server running on port ${port}`));
const io = socketIo(server);

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);
  socket.on("join", (userId) => {
    socket.join(userId);
    console.log(`User ${userId} joined room`);
  });
  socket.on("chat", async ({ toId, message }) => {
    const fromId = socket.handshake.session.passport.user.id;
    console.log(`Chat from ${fromId} to ${toId}: ${message}`);
    io.to(toId).emit("chat", { from: fromId, message });
    io.to(fromId).emit("chat", { from: fromId, message });
  });
  socket.on("disconnect", () => console.log("Socket disconnected:", socket.id));
});
