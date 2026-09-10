const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType
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

// ===== Configuration des tickets =====
const ROLE_NAMES = {
  admin: "Administrateur",
  gestionnaire: "Gestionnaire",
  moderateur: "Moderateur",
  helper: "Helper"
};

// Chaque niveau donne acces aux niveaux en dessous de lui (cascade)
const LEVEL_HIERARCHY = {
  admin: ["admin"],
  gestionnaire: ["admin", "gestionnaire"],
  moderateur: ["admin", "gestionnaire", "moderateur"],
  helper: ["admin", "gestionnaire", "moderateur", "helper"]
};

const TICKET_CATEGORIES = [
  { value: "administration", label: "Administration", emoji: "🛡️", level: "admin" },
  { value: "aide_generale", label: "Aide générale", emoji: "❓", level: "helper" },
  { value: "moderation_discord", label: "Modération Discord", emoji: "⚔️", level: "moderateur" },
  { value: "moderation_twitch", label: "Modération Twitch", emoji: "🟣", level: "moderateur" },
  { value: "moderation_youtube", label: "Modération YouTube", emoji: "🔴", level: "moderateur" },
  { value: "animation", label: "Animation", emoji: "🎉", level: "gestionnaire" },
  { value: "bug_technique", label: "Bug ou problème technique", emoji: "🛠️", level: "helper" },
  { value: "candidature", label: "Candidature", emoji: "📋", level: "gestionnaire" },
  { value: "abus_staff", label: "Signaler un abus d'un Staff", emoji: "🚨", level: "admin" },
  { value: "autre", label: "Autre demande", emoji: "✏️", level: "helper" }
];

function getRolesForLevel(guild, level) {
  const requiredLevels = LEVEL_HIERARCHY[level] || [];
  const roles = [];

  for (const lvl of requiredLevels) {
    const roleName = ROLE_NAMES[lvl];
    const role = guild.roles.cache.find(r => r.name === roleName);
    if (role) roles.push(role);
  }

  return roles;
}

function buildTicketPanel() {
  const embed = new EmbedBuilder()
    .setTitle("🎫 Support — Ouvrir un ticket")
    .setDescription(
      "Sélectionnez le type de demande ci-dessous pour ouvrir un ticket :\n\n" +
      TICKET_CATEGORIES.map(c => `${c.emoji} — **${c.label}**`).join("\n")
    )
    .setColor(0x5865F2);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("ticket_category_select")
    .setPlaceholder("Sélectionnez le type de ticket")
    .addOptions(
      TICKET_CATEGORIES.map(c => ({
        label: c.label,
        value: c.value,
        emoji: c.emoji
      }))
    );

  const row = new ActionRowBuilder().addComponents(selectMenu);

  return { embeds: [embed], components: [row] };
}

// ===== Commandes slash =====
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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("Affiche le panneau de création de tickets dans ce salon")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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

// ===== Gestion des interactions =====
client.on("interactionCreate", async interaction => {
  const { guild, member } = interaction;

  // --- Commandes slash ---
  if (interaction.isChatInputCommand()) {
    const { commandName, options } = interaction;

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

    if (commandName === "ticket-panel") {
      await interaction.channel.send(buildTicketPanel());
      await interaction.reply({ content: "✅ Panneau de tickets envoyé.", ephemeral: true });
    }

    return;
  }

  // --- Menu déroulant de sélection de ticket ---
  if (interaction.isStringSelectMenu() && interaction.customId === "ticket_category_select") {
    const categoryValue = interaction.values[0];
    const category = TICKET_CATEGORIES.find(c => c.value === categoryValue);
    if (!category) return;

    await interaction.deferReply({ ephemeral: true });

    const existing = guild.channels.cache.find(
      c => c.name === `ticket-${category.value}-${interaction.user.username}`.toLowerCase()
    );
    if (existing) {
      return interaction.editReply({ content: `Tu as déjà un ticket ouvert : ${existing}` });
    }

    const staffRoles = getRolesForLevel(guild, category.level);

    const permissionOverwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      },
      ...staffRoles.map(role => ({
        id: role.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      }))
    ];

    const ticketChannel = await guild.channels.create({
      name: `ticket-${category.value}-${interaction.user.username}`.toLowerCase(),
      type: ChannelType.GuildText,
      permissionOverwrites
    }).catch(() => null);

    if (!ticketChannel) {
      return interaction.editReply({ content: "❌ Impossible de créer le ticket. Vérifie mes permissions." });
    }

    const welcomeEmbed = new EmbedBuilder()
      .setTitle(`${category.emoji} Ticket — ${category.label}`)
      .setDescription(
        `Bienvenue ${interaction.user}, ton ticket a été créé.\n\n` +
        `Merci de décrire ta demande en détail. Un membre du staff va te répondre bientôt.`
      )
      .setColor(0x5865F2)
      .setTimestamp();

    const closeButton = new ButtonBuilder()
      .setCustomId("close_ticket")
      .setLabel("Fermer le ticket")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🔒");

    const row = new ActionRowBuilder().addComponents(closeButton);

    const mentionRoles = staffRoles.map(r => `<@&${r.id}>`).join(" ");

    await ticketChannel.send({
      content: `${interaction.user} ${mentionRoles}`,
      embeds: [welcomeEmbed],
      components: [row]
    });

    await interaction.editReply({ content: `✅ Ton ticket a été créé : ${ticketChannel}` });

    sendLog(guild, "🎫 Ticket créé", `**${interaction.user.tag}** a ouvert un ticket : **${category.label}**\nSalon : ${ticketChannel}`);
    return;
  }

  // --- Bouton fermer le ticket ---
  if (interaction.isButton() && interaction.customId === "close_ticket") {
    await interaction.reply({ content: "🔒 Ce ticket sera fermé dans 5 secondes..." });

    sendLog(guild, "🔒 Ticket fermé", `Ticket **${interaction.channel.name}** fermé par **${member.user.tag}**`);

    setTimeout(() => {
      interaction.channel.delete().catch(() => {});
    }, 5000);

    return;
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

// Ban (via l'interface Discord directement)
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
