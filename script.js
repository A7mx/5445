const socket = io();

let userData = {};
let currentChatId = null;

function refreshUserData() {
  fetch("/api/user")
    .then((res) => res.json())
    .then((data) => {
      if (!data.success) throw new Error(data.message || "Failed to fetch user data");
      userData = data;
      console.log("Client received user data:", data);
      document.getElementById("avatar").src = userData.avatar ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` : "https://cdn.discordapp.com/embed/avatars/0.png";
      document.getElementById("username").textContent = userData.username || "Unknown";
      document.getElementById("discord-id").textContent = `ID: ${userData.id}`;
      document.getElementById("balance-amount").textContent = `${userData.balance} DIS`;
      document.getElementById("wallet-id").textContent = userData.walletId;
      socket.emit("join", userData.id);
      updateFriendsList();
      updateQRCode();
      showSuccess("Dashboard updated successfully.");
    })
    .catch((error) => showError("Error fetching user data: " + error.message));
}

function updateFriendsList() {
  const friendsList = document.getElementById("friends-list");
  const pendingList = document.getElementById("pending-list");
  friendsList.innerHTML = "";
  pendingList.innerHTML = "";

  userData.friends.forEach((friend) => {
    const friendItem = document.createElement("div");
    friendItem.className = "friend-item";
    friendItem.innerHTML = `
      <img src="${friend.avatar ? `https://cdn.discordapp.com/avatars/${friend.id}/${friend.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png'}" alt="${friend.username}'s Avatar" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'" title="Click to chat with ${friend.username}">
      <span>${friend.username} (Wallet: ${friend.walletId})</span>
    `;
    friendItem.onclick = () => startChat(friend.id, friend.username);
    friendsList.appendChild(friendItem);
  });

  userData.pendingFriends.forEach((friend) => {
    const pendingItem = document.createElement("div");
    pendingItem.className = "pending-item";
    pendingItem.innerHTML = `
      <img src="${friend.avatar ? `https://cdn.discordapp.com/avatars/${friend.id}/${friend.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png'}" alt="${friend.username}'s Avatar" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'" title="Pending friend request from ${friend.username}">
      <span>${friend.username} (Wallet: ${friend.walletId})</span>
      <button class="accept" onclick="acceptFriend('${friend.id}')">Accept</button>
      <button class="ignore" onclick="ignoreFriend('${friend.id}')">Ignore</button>
    `;
    pendingList.appendChild(pendingItem);
  });
}

function updateQRCode() {
  fetch("/api/wallet-id")
    .then((res) => res.json())
    .then((data) => {
      if (!data.success) throw new Error(data.message || "Failed to fetch QR code");
      document.getElementById("qr-code").src = data.qrCode;
      document.getElementById("withdraw-qr").src = ""; // Clear withdrawal QR until needed
    })
    .catch((error) => showError("Error fetching QR code: " + error.message));
}

refreshUserData();

function toggleUserInfo() {
  const userInfo = document.getElementById("user-info");
  userInfo.classList.toggle("hidden");
}

function toggleDeposit() {
  const depositOption = document.getElementById("deposit-option");
  depositOption.classList.toggle("hidden");
}

function deposit() {
  showSection("deposit");
  showSuccess("Navigate to the Deposit section to add funds.");
}

function depositFunds() {
  const amount = parseFloat(document.getElementById("deposit-amount").value);
  if (isNaN(amount) || amount <= 0) {
    showError("Please enter a valid deposit amount.");
    return;
  }
  fetch("/api/deposit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount, walletId: userData.walletId }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        showSuccess(data.message);
        refreshUserData();
        document.getElementById("deposit-amount").value = "";
      } else {
        showError(data.message);
      }
    })
    .catch((error) => showError("Deposit failed: " + error.message));
}

function showSection(sectionId) {
  document.querySelectorAll(".card").forEach((card) => card.classList.remove("active"));
  document.getElementById(sectionId).classList.add("active");
  document.querySelectorAll(".sidebar nav ul li").forEach((li) => li.classList.remove("active"));
  document.querySelector(`.sidebar nav ul li[onclick="showSection('${sectionId}')"]`).classList.add("active");
}

function transferFunds() {
  const toWalletId = document.getElementById("transfer-to-wallet").value;
  const amount = parseFloat(document.getElementById("transfer-amount").value);
  if (isNaN(amount) || amount <= 0) {
    showError("Please enter a valid transfer amount.");
    return;
  }
  if (!toWalletId) {
    showError("Please enter a recipient wallet ID.");
    return;
  }
  if (toWalletId === userData.walletId) {
    showError("You cannot transfer money to your own wallet!");
    return;
  }
  fetch("/api/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toWalletId, amount }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        showSuccess(data.message);
        refreshUserData();
        document.getElementById("transfer-to-wallet").value = "";
        document.getElementById("transfer-amount").value = "";
      } else {
        showError(data.message);
      }
    })
    .catch((error) => showError("Transfer failed: " + error.message));
}

function withdrawFunds() {
  const amount = parseFloat(document.getElementById("withdraw-amount").value);
  const withdrawalWallet = document.getElementById("withdrawal-wallet").value;
  if (isNaN(amount) || amount <= 0) {
    showError("Please enter a valid withdrawal amount.");
    return;
  }
  if (!withdrawalWallet) {
    showError("Please enter a withdrawal wallet ID.");
    return;
  }
  fetch("/api/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount, withdrawalWalletId: withdrawalWallet }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        showSuccess(data.message);
        document.getElementById("withdraw-amount").value = "";
        document.getElementById("withdrawal-wallet").value = "";
        document.getElementById("withdraw-qr").src = data.qrCode;
      } else {
        showError(data.message);
      }
      refreshUserData();
    })
    .catch((error) => showError("Withdrawal failed: " + error.message));
}

function addFriend() {
  const friendId = document.getElementById("friend-id").value;
  fetch("/api/add-friend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ friendId }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        showSuccess(data.message);
        document.getElementById("friend-id").value = "";
        refreshUserData();
      } else {
        showError(data.message);
      }
    })
    .catch((error) => showError("Friend request failed: " + error.message));
}

function acceptFriend(friendId) {
  fetch("/api/accept-friend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ friendId }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        showSuccess(data.message);
        refreshUserData();
      } else {
        showError(data.message);
      }
    })
    .catch((error) => showError("Accept friend failed: " + error.message));
}

function ignoreFriend(friendId) {
  fetch("/api/ignore-friend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ friendId }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        showSuccess(data.message);
        refreshUserData();
      } else {
        showError(data.message);
      }
    })
    .catch((error) => showError("Ignore friend failed: " + error.message));
}

function startChat(friendId, friendUsername) {
  currentChatId = friendId;
  const chatPanel = document.getElementById("chat-panel");
  document.getElementById("chat-with").textContent = friendUsername;
  fetchChatHistory(friendId);
  chatPanel.classList.remove("hidden");
  chatPanel.classList.add("open");
}

function closeChat() {
  const chatPanel = document.getElementById("chat-panel");
  chatPanel.classList.remove("open");
  chatPanel.classList.add("hidden");
  currentChatId = null;
}

function fetchChatHistory(friendId) {
  fetch(`/api/chat/${friendId}`)
    .then((res) => res.json())
    .then((data) => {
      if (!data.success) throw new Error(data.message || "Failed to fetch chat history");
      const chatBox = document.getElementById("chat-box");
      const noMessages = document.getElementById("no-messages");
      if (data.messages.length > 0) {
        chatBox.innerHTML = data.messages.map(msg => `<p>${msg.from === userData.id ? "You" : msg.from}: ${msg.message}</p>`).join("");
        if (noMessages) noMessages.remove();
      } else {
        chatBox.innerHTML = `
          <div id="no-messages">
            <span style="font-size: 24px;">📩</span>
            <p>No messages</p>
            <p>Messages from your friend will be shown here</p>
          </div>
        `;
      }
      chatBox.scrollTop = chatBox.scrollHeight;
    })
    .catch((error) => showError("Error fetching chat history: " + error.message));
}

function sendChat() {
  if (!currentChatId) return;
  const message = document.getElementById("chat-input").value;
  if (message) {
    socket.emit("chat", { toId: currentChatId, message });
    document.getElementById("chat-input").value = "";
    showSuccess("Message sent successfully.");
  }
}

socket.on("chat", ({ from, message }) => {
  if (from === currentChatId || from === userData.id) {
    const chatBox = document.getElementById("chat-box");
    const noMessages = document.getElementById("no-messages");
    if (noMessages) noMessages.remove();
    chatBox.innerHTML += `<p>${from === userData.id ? "You" : from}: ${message}</p>`;
    chatBox.scrollTop = chatBox.scrollHeight;
    showSuccess("New message received.");
  }
});

function searchTransactions() {
  fetch("/api/transactions")
    .then((res) => res.json())
    .then((data) => {
      if (!data.success) throw new Error(data.message || "Failed to fetch transactions");
      const transList = document.getElementById("trans-list");
      transList.innerHTML = data.transactions
        .map((t) => `<p>From Wallet: ${t.fromWalletId}, To Wallet: ${t.toWalletId}, Amount: ${t.amount} DIS, Time: ${new Date(t.timestamp.seconds * 1000)}${t.type === "owner_transfer" ? " (To Owner)" : ""}</p>`)
        .join("");
      showSuccess("Transactions loaded successfully.");
    })
    .catch((error) => showError("Error fetching transactions: " + error.message));
}

function showSuccess(message) {
  alert(message); // For simplicity; use a modal or toast for production
}

function showError(message) {
  alert(message); // For simplicity; use a modal or toast for production
}

showSection("deposit");
