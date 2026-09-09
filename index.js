const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder
} = require("discord.js");

const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot en ligne !'));
app.listen(process.env.PORT || 3000, () => console.log('Serveur HTTP demarre'));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration
  ],
  partials: [Partials.Message, Partials.Channel]
});

const LOG_CHANNEL_NAME = "📋・logs";

function getLogChannel(guild) {
  return guild.channels.cache.find(
    channel =>
      channel.name === LOG_CHANNEL_NAME &&
      channel.isTextBased()
  );
}

async function sendLog(guild, title, description) {
  const channel = getLogChannel(guild);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();

  await channel.send({ embeds: [embed] }).catch(() => {});
}

// Connexion du bot
client.once("ready", () => {
  console.log(`✅ ${client.user.tag} est connecté !`);
});

// Membre rejoint
client.on("guildMemberAdd", member => {
  sendLog(
    member.guild,
    "👋 Membre arrivé",
    `**${member.user.tag}** vient de rejoindre le serveur.`
  );
});

// Membre quitte
client.on("guildMemberRemove", member => {
  sendLog(
    member.guild,
    "👋 Membre parti",
    `**${member.user.tag}** a quitté le serveur.`
  );
});

// Message supprimé
client.on("messageDelete", message => {
  if (!message.guild || message.author?.bot) return;

  sendLog(
    message.guild,
    "🗑️ Message supprimé",
    `**Auteur :** ${message.author?.tag || "Inconnu"}\n` +
    `**Salon :** ${message.channel}\n` +
    `**Message :** ${message.content || "Contenu indisponible"}`
  );
});

// Message modifié
client.on("messageUpdate", (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return;

  sendLog(
    newMessage.guild,
    "✏️ Message modifié",
    `**Auteur :** ${newMessage.author?.tag || "Inconnu"}\n` +
    `**Salon :** ${newMessage.channel}\n\n` +
    `**Avant :** ${oldMessage.content || "Vide"}\n` +
    `**Après :** ${newMessage.content || "Vide"}`
  );
});

// Ban
client.on("guildBanAdd", ban => {
  sendLog(
    ban.guild,
    "🔨 Membre banni",
    `**${ban.user.tag}** a été banni du serveur.`
  );
});

// Déban
client.on("guildBanRemove", ban => {
  sendLog(
    ban.guild,
    "🔓 Membre débanni",
    `**${ban.user.tag}** a été débanni du serveur.`
  );
});

// Erreurs
client.on("error", error => {
  console.error("Erreur Discord :", error);
});

client.login(process.env.DISCORD_TOKEN);
