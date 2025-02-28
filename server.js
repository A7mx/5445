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
  console.log("Serving dashboard");

  const dashboardHTML = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>DISWallet</title>
      <link href="https://fonts.googleapis.com/css2?family=Orbitron&family=Roboto:wght@400;700&display=swap" rel="stylesheet">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: 'Roboto', sans-serif;
          background: linear-gradient(135deg, #1e3c72, #2a5298);
          color: #333;
          min-height: 100vh;
        }
        header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 15px 30px;
          background: #fff;
          box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
        }
        #logo {
          font-family: 'Orbitron', sans-serif;
          font-size: 32px;
          color: #2a5298;
        }
        #user-profile {
          display: flex;
          align-items: center;
          position: relative;
        }
        #balance {
          margin-right: 15px;
          cursor: pointer;
          position: relative;
        }
        #balance-amount {
          font-size: 16px;
          font-weight: 700;
          color: #2a5298;
          padding: 5px 10px;
          background: #e6f0fa;
          border-radius: 5px;
        }
        #deposit-option {
          position: absolute;
          top: 40px;
          right: 0;
          background: #fff;
          padding: 10px;
          border-radius: 8px;
          box-shadow: 0 4px 10px rgba(0, 0, 0, 0.2);
          z-index: 10;
        }
        #deposit-option.hidden {
          display: none;
        }
        #deposit-option button {
          background: #27ae60;
          color: #fff;
          border: none;
          padding: 8px 15px;
          border-radius: 5px;
          cursor: pointer;
          font-weight: 700;
        }
        #deposit-option button:hover {
          background: #219653;
        }
        #avatar {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          cursor: pointer;
          border: 2px solid #2a5298;
        }
        #user-info {
          position: absolute;
          top: 50px;
          right: 0;
          background: #fff;
          padding: 15px;
          border-radius: 8px;
          box-shadow: 0 4px 10px rgba(0, 0, 0, 0.2);
          z-index: 10;
        }
        #user-info.hidden {
          display: none;
        }
        #username, #discord-id {
          display: block;
          margin: 5px 0;
          font-size: 14px;
          color: #333;
        }
        #logout {
          background: #e74c3c;
          color: #fff;
          border: none;
          padding: 8px 15px;
          border-radius: 5px;
          cursor: pointer;
          font-weight: 700;
          margin-top: 10px;
        }
        #logout:hover {
          background: #c0392b;
        }
        .layout {
          display: flex;
          height: calc(100vh - 70px);
        }
        .sidebar {
          width: 250px;
          background: #fff;
          padding: 20px;
          box-shadow: 2px 0 10px rgba(0, 0, 0, 0.1);
        }
        .sidebar nav ul {
          list-style: none;
        }
        .sidebar nav ul li {
          padding: 15px;
          font-size: 16px;
          color: #2a5298;
          cursor: pointer;
          border-radius: 5px;
          margin-bottom: 10px;
          transition: background 0.3s;
        }
        .sidebar nav ul li:hover,
        .sidebar nav ul li.active {
          background: #2a5298;
          color: #fff;
        }
        .content {
          flex: 1;
          padding: 30px;
          overflow-y: auto;
        }
        .card {
          background: #fff;
          padding: 20px;
          border-radius: 10px;
          box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
          margin-bottom: 20px;
          display: none;
        }
        .card.active {
          display: block;
        }
        .card h2 {
          color: #2a5298;
          margin-bottom: 15px;
        }
        input,
        button {
          display: block;
          width: 100%;
          padding: 12px;
          margin: 10px 0;
          border-radius: 5px;
          font-size: 14px;
        }
        input {
          border: 1px solid #ccc;
        }
        button {
          background: #2a5298;
          color: #fff;
          border: none;
          cursor: pointer;
          font-weight: 700;
          transition: background 0.3s;
        }
        button:hover {
          background: #1e3c72;
        }
        #chat-box,
        #trans-list {
          border: 1px solid #ddd;
          padding: 10px;
          max-height: 300px;
          overflow-y: auto;
          background: #f9f9f9;
          border-radius: 5px;
        }
        #chat-box p,
        #trans-list p {
          margin: 5px 0;
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <header>
        <h1 id="logo">DISWallet</h1>
        <div id="user-profile">
          <div id="balance" onclick="toggleDeposit()">
            <span id="balance-amount"></span>
            <div id="deposit-option" class="hidden">
              <button onclick="deposit()">Deposit</button>
            </div>
          </div>
          <img id="avatar" src="" alt="Avatar" onclick="toggleUserInfo()">
          <div id="user-info" class="hidden">
            <span id="username"></span>
            <span id="discord-id"></span>
            <button id="logout" onclick="window.location.href='/auth/discord/logout'">LOGOUT</button>
          </div>
        </div>
      </header>
      <div class="layout">
        <aside class="sidebar">
          <nav>
            <ul>
              <li onclick="showSection('add-friend')">Add Friend</li>
              <li onclick="showSection('chat')">Chat</li>
              <li onclick="showSection('transfer')">Transfer</li>
              <li onclick="showSection('trans-search')">TransSearch</li>
            </ul>
          </nav>
        </aside>
        <main class="content">
          <section id="add-friend" class="card active">
            <h2>Add Friend</h2>
            <input id="friend-id" placeholder="Friend's Discord ID">
            <button onclick="addFriend()">Add Friend</button>
          </section>
          <section id="chat" class="card">
            <h2>Chat</h2>
            <input id="chat-to" placeholder="Recipient ID">
            <input id="chat-msg" placeholder="Type a message">
            <button onclick="sendChat()">Send</button>
            <div id="chat-box"></div>
          </section>
          <section id="transfer" class="card">
            <h2>Transfer</h2>
            <input id="transfer-to" placeholder="Recipient ID">
            <input id="transfer-amount" type="number" placeholder="Amount">
            <button onclick="transfer()">Transfer</button>
          </section>
          <section id="trans-search" class="card">
            <h2>TransSearch</h2>
            <button onclick="searchTransactions()">Search Transactions</button>
            <div id="trans-list"></div>
          </section>
        </main>
      </div>
      <script src="/socket.io/socket.io.js"></script>
      <script>
        const socket = io();

        fetch("/api/user")
          .then((res) => res.json())
          .then((data) => {
            document.getElementById("avatar").src = \`https://cdn.discordapp.com/avatars/\${data.id}/\${data.avatar}.png\`;
            document.getElementById("username").textContent = data.username;
            document.getElementById("discord-id").textContent = \`ID: \${data.id}\`;
            document.getElementById("balance-amount").textContent = \`\${data.balance} DIS\`;
            socket.emit("join", data.id);
          });

        function toggleUserInfo() {
          const userInfo = document.getElementById("user-info");
          userInfo.classList.toggle("hidden");
        }

        function toggleDeposit() {
          const depositOption = document.getElementById("deposit-option");
          depositOption.classList.toggle("hidden");
        }

        function deposit() {
          alert("Deposit feature coming soon!");
        }

        function showSection(sectionId) {
          document.querySelectorAll(".card").forEach((card) => card.classList.remove("active"));
          document.getElementById(sectionId).classList.add("active");
          document.querySelectorAll(".sidebar nav ul li").forEach((li) => li.classList.remove("active"));
          document.querySelector(\`.sidebar nav ul li[onclick="showSection('\${sectionId}')"]\`).classList.add("active");
        }

        function addFriend() {
          const friendId = document.getElementById("friend-id").value;
          fetch("/api/add-friend", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ friendId }),
          }).then(() => alert("Friend added!"));
        }

        function sendChat() {
          const toId = document.getElementById("chat-to").value;
          const message = document.getElementById("chat-msg").value;
          socket.emit("chat", { toId, message });
          document.getElementById("chat-msg").value = "";
        }

        socket.on("chat", ({ from, message }) => {
          const chatBox = document.getElementById("chat-box");
          chatBox.innerHTML += \`<p>\${from}: \${message}</p>\`;
          chatBox.scrollTop = chatBox.scrollHeight;
        });

        function transfer() {
          const toId = document.getElementById("transfer-to").value;
          const amount = document.getElementById("transfer-amount").value;
          fetch("/api/transfer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ toId, amount: parseInt(amount) }),
          })
            .then((res) => res.json())
            .then((data) => alert(\`Transfer successful! Transaction ID: \${data.transId}\`));
        }

        function searchTransactions() {
          fetch("/api/transactions")
            .then((res) => res.json())
            .then((trans) => {
              const transList = document.getElementById("trans-list");
              transList.innerHTML = trans
                .map((t) => \`<p>To: \${t.to}, Amount: \${t.amount}, Time: \${new Date(t.timestamp.seconds * 1000)}\`)
                .join("");
            });
        }

        showSection("add-friend");
      </script>
    </body>
    </html>
  `;
  res.send(dashboardHTML);
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
    await setDoc(userRef, { balance: encrypt("1000"), friends: [] });
  }
  const data = userDoc.data() || { balance: encrypt("1000"), friends: [] };
  res.json({
    id: req.user.id,
    username: req.user.username,
    avatar: req.user.avatar,
    balance: decrypt(data.balance),
  });
});

app.post("/api/add-friend", async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send("Unauthorized");
  const friendId = req.body.friendId;
  const userRef = doc(db, "users", req.user.id);
  await updateDoc(userRef, { friends: arrayUnion(friendId) });
  res.send("Friend added");
});

app.post("/api/transfer", async (req, res) => {
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

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Server running on port ${port}`));
const io = socketIo(server);

io.on("connection", (socket) => {
  socket.on("join", (userId) => socket.join(userId));
  socket.on("chat", async ({ toId, message }) => {
    const fromId = socket.handshake.session.passport.user.id;
    io.to(toId).emit("chat", { from: fromId, message });
    io.to(fromId).emit("chat", { from: fromId, message });
  });
});
