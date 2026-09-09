const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits
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

// ===== Définition des commandes slash =====
const commands = [
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Expulse un membre du serveur")
    .addUserOption(option =>
      option.setName("membre").setDescription("Le membre à expulser").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("raison").setDescription("Raison de l'expulsion").setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Bannit un membre du serveur")
    .addUserOption(option =>
      option.setName("membre").setDescription("Le membre à bannir").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("raison").setDescription("Raison du bannissement").setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Supprime un nombre de messages dans le salon")
    .addIntegerOption(option =>
      option.setName("nombre").setDescription("Nombre de messages à supprimer (1-100)").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
].map(command => command.toJSON());

// Connexion du bot
client.once("ready", async () => {
  console.log(`✅ ${client.user.tag} est connecté !`);

  try {
    await client.application.commands.set(commands);
    console.log("✅ Commandes slash enregistrées !");
  } catch (error) {
    console.error("Erreur lors de l'enregistrement des commandes :", error);
  }
});

// ===== Gestion des commandes slash =====
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member, options } = interaction;

  if (commandName === "kick") {
    const target = options.getUser("membre");
    const raison = options.getString("raison") || "Aucune raison fournie";
    const targetMember = await guild.members.fetch(target.id).catch(() => null);

    if (!targetMember) {
      return interaction.reply({ content: "Membre introuvable.", ephemeral: true });
    }
    if (!targetMember.kickable) {
      return interaction.reply({ content: "Je ne peux pas expulser ce membre.", ephemeral: true });
    }

    await targetMember.kick(raison);
    await interaction.reply(`👢 **${target.tag}** a été expulsé. Raison : ${raison}`);
    sendLog(guild, "👢 Membre expulsé", `**${target.tag}** expulsé par **${member.user.tag}**\nRaison : ${raison}`);
  }

  if (commandName === "ban") {
    const target = options.getUser("membre");
    const raison = options.getString("raison") || "Aucune raison fournie";
    const targetMember = await guild.members.fetch(target.id).catch(() => null);

    if (targetMember && !targetMember.bannable) {
      return interaction.reply({ content: "Je ne peux pas bannir ce membre.", ephemeral: true });
    }

    await guild.members.ban(target.id, { reason: raison });
    await interaction.reply(`🔨 **${target.tag}** a été banni. Raison : ${raison}`);
    sendLog(guild, "🔨 Membre banni", `**${target.tag}** banni par **${member.user.tag}**\nRaison : ${raison}`);
  }

  if (commandName === "clear") {
    const nombre = options.getInteger("nombre");

    if (nombre < 1 || nombre > 100) {
      return interaction.reply({ content: "Choisis un nombre entre 1 et 100.", ephemeral: true });
    }

    const deleted = await interaction.channel.bulkDelete(nombre, true).catch(() => null);
    if (!deleted) {
      return interaction.reply({ content: "Impossible de supprimer ces messages (trop vieux de 14 jours ?).", ephemeral: true });
    }

    await interaction.reply({ content: `🧹 ${deleted.size} messages supprimés.`, ephemeral: true });
    sendLog(guild, "🧹 Messages supprimés", `**${deleted.size}** messages supprimés par **${member.user.tag}** dans ${interaction.channel}`);
  }
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

// Ban (via l'interface Discord directement, pas la commande)
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
