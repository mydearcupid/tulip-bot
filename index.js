require("dotenv").config();
const fs = require("fs-extra");
const express = require("express");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

const config = require("./config.json");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// =====================
// DISCORD CLIENT
// =====================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// =====================
// DATA FILES
// =====================

const xpFile = "./xp.json";
const currencyFile = "./currency.json";

if (!fs.existsSync(xpFile)) fs.writeJsonSync(xpFile, {});
if (!fs.existsSync(currencyFile)) fs.writeJsonSync(currencyFile, {});

let xpData = fs.readJsonSync(xpFile);
let currencyData = fs.readJsonSync(currencyFile);

let xpCooldown = {};
let messageTracker = {};
let dailyTracker = {};
let activeTrivia = null;
let triviaStart = null;

// =====================
// TRIVIA QUESTIONS (100+)
// =====================

const triviaQuestions = [];

for (let i = 1; i <= 120; i++) {
  let difficulty;
  let reward;

  if (i <= 40) {
    difficulty = "easy";
    reward = 15;
  } else if (i <= 90) {
    difficulty = "medium";
    reward = 30;
  } else {
    difficulty = "hard";
    reward = 60;
  }

  triviaQuestions.push({
    q: `Question ${i}: What is ${i} + ${i}?`,
    a: String(i + i),
    r: reward,
    d: difficulty
  });
}

// =====================
// HELPER FUNCTIONS
// =====================

function saveData() {
  fs.writeJsonSync(xpFile, xpData, { spaces: 2 });
  fs.writeJsonSync(currencyFile, currencyData, { spaces: 2 });
}

function getLevel(xp) {
  return Math.floor(0.1 * Math.sqrt(xp));
}

function weightedTrivia() {
  const roll = Math.random();
  if (roll < 0.6) return triviaQuestions.filter(q => q.d === "easy");
  if (roll < 0.9) return triviaQuestions.filter(q => q.d === "medium");
  return triviaQuestions.filter(q => q.d === "hard");
}

// ==========================
// DASHBOARD ROUTES
// ==========================

// This handles visiting the root URL
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/dashboard.html");
});

app.get("/api/config", (req, res) => {
  if (req.query.key !== config.secretKey)
    return res.status(403).json({ error: "Invalid key" });

  res.json(config);
});

app.post("/api/config", (req, res) => {
  if (req.body.key !== config.secretKey)
    return res.status(403).json({ error: "Invalid key" });

  Object.assign(config, req.body);
  fs.writeJsonSync("./config.json", config, { spaces: 2 });

  res.json({ success: true });
});

// =====================
// DISCORD EVENTS
// =====================

client.once("ready", () => {
  console.log(`Tulip online as ${client.user.tag}`);
});

// Autorole
client.on("guildMemberAdd", member => {
  if (!config.autoroleId) return;
  const role = member.guild.roles.cache.get(config.autoroleId);
  if (role) member.roles.add(role).catch(console.error);
});

// =====================
// MESSAGE HANDLER
// =====================

client.on("messageCreate", async message => {
  if (message.author.bot) return;

  const userId = message.author.id;
  const now = Date.now();

  if (!xpData[userId]) xpData[userId] = { xp: 0, level: 0 };
  if (!currencyData[userId]) currencyData[userId] = { leaves: 0 };

  // =====================
  // CHAT TRACKER
  // =====================

  if (!messageTracker[userId]) messageTracker[userId] = [];
  messageTracker[userId] = messageTracker[userId].filter(t => now - t < 60000);
  messageTracker[userId].push(now);

  // =====================
  // XP COOLDOWN (30 sec)
  // =====================

  if (!xpCooldown[userId] || now - xpCooldown[userId] > config.xpCooldownMs) {
    xpData[userId].xp += Math.floor(Math.random() * 10) + 5;
    xpCooldown[userId] = now;

    const newLevel = getLevel(xpData[userId].xp);

    if (newLevel > xpData[userId].level) {
      xpData[userId].level = newLevel;
      const msg = await message.channel.send(
        `🌿 ${message.author} reached level ${newLevel}`
      );
      setTimeout(() => msg.delete().catch(() => {}), 10000);
    }
  }

  // =====================
  // DAILY COMMAND
  // =====================

  if (message.content === "!daily") {
    if (messageTracker[userId].length < config.dailyChatRequirement) {
      return message.reply(
        `You must chat ${config.dailyChatRequirement} times first.`
      );
    }

    const reward = Math.floor(Math.random() * config.dailyRewardMax) + 1;
    currencyData[userId].leaves += reward;

    message.reply(`🍃 You received ${reward} ${config.currencyName}.`);
  }

  // =====================
  // LEADERBOARD
  // =====================

  if (message.content === "!leaderboard") {
    const top = Object.entries(currencyData)
      .sort((a, b) => b[1].leaves - a[1].leaves)
      .slice(0, 10);

    let output = "🍃 Leaf Leaderboard\n";
    for (let i = 0; i < top.length; i++) {
      const user = await client.users.fetch(top[i][0]);
      output += `${i + 1}. ${user.username} - ${top[i][1].leaves}\n`;
    }

    message.channel.send(output);
  }

  // =====================
  // TRIVIA DROP
  // =====================

  if (!activeTrivia && Math.random() < config.triviaChance) {
    const pool = weightedTrivia();
    activeTrivia = pool[Math.floor(Math.random() * pool.length)];
    triviaStart = Date.now();

    message.channel.send(`🌿 Trivia\n${activeTrivia.q}`);
  }

  // Trivia Answer
  if (
    activeTrivia &&
    message.content.toLowerCase().trim() === activeTrivia.a
  ) {
    const seconds = (Date.now() - triviaStart) / 1000;
    let reward = activeTrivia.r;

    if (seconds <= 5) reward *= 2;

    currencyData[userId].leaves += reward;
    message.channel.send(
      `🍃 ${message.author} earned ${reward} ${config.currencyName}`
    );

    activeTrivia = null;
    triviaStart = null;
  }

  saveData();
});

// =====================
// START SERVERS
// =====================

app.listen(PORT, () =>
  console.log(`Dashboard running on port ${PORT}`)
);

client.login(process.env.TOKEN);
