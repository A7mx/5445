const socket = io();

fetch("/api/user")
  .then((res) => res.json())
  .then((data) => {
    document.getElementById("avatar").src = `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png`;
    document.getElementById("username").textContent = data.username;
    document.getElementById("discord-id").textContent = `ID: ${data.id}`;
    document.getElementById("balance-amount").textContent = `${data.balance} DIS`;
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
  alert("Deposit feature coming soon!"); // Placeholder for deposit logic
}

function showSection(sectionId) {
  document.querySelectorAll(".card").forEach((card) => card.classList.remove("active"));
  document.getElementById(sectionId).classList.add("active");
  document.querySelectorAll(".sidebar nav ul li").forEach((li) => li.classList.remove("active"));
  document.querySelector(`.sidebar nav ul li[onclick="showSection('${sectionId}')"]`).classList.add("active");
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
  chatBox.innerHTML += `<p>${from}: ${message}</p>`;
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
    .then((data) => alert(`Transfer successful! Transaction ID: ${data.transId}`));
}

function searchTransactions() {
  fetch("/api/transactions")
    .then((res) => res.json())
    .then((trans) => {
      const transList = document.getElementById("trans-list");
      transList.innerHTML = trans
        .map((t) => `<p>To: ${t.to}, Amount: ${t.amount}, Time: ${new Date(t.timestamp.seconds * 1000)}`)
        .join("");
    });
}

// Show Add Friend section by default
showSection("add-friend");