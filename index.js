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
  ChannelType,
  AttachmentBuilder,
  AuditLogEvent
} = require("discord.js");

const { createTranscript } = require("discord-html-transcripts");

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
const TICKET_LOG_CHANNEL_NAME = "🚫-logs-tickets";
const MODERATION_LOG_CHANNEL_NAME = "🚫-logs-moderation";

function getLogChannel(guild, channelName = LOG_CHANNEL_NAME) {
  return guild.channels.cache.find(
    channel =>
      channel.name === channelName &&
      channel.isTextBased()
  );
}

async function sendLog(guild, title, description, channelName = LOG_CHANNEL_NAME, fields = []) {
  const channel = getLogChannel(guild, channelName);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setTimestamp();

  if (description) embed.setDescription(description);
  if (fields.length) embed.addFields(fields);

  await channel.send({ embeds: [embed] }).catch(() => {});
}

// ===== Configuration des tickets =====
// Chaque categorie liste explicitement les roles qui doivent avoir acces
const TICKET_CATEGORIES = [
  { value: "administration", label: "Administration", emoji: "🛡️", roles: ["Administrateur"] },
  { value: "aide_generale", label: "Aide générale", emoji: "❓", roles: ["Administrateur", "Moderateur Discord", "Helper"] },
  { value: "moderation_discord", label: "Modération Discord", emoji: "⚔️", roles: ["Administrateur", "Gestionnaire.Mods discord", "Moderateur Discord"] },
  { value: "moderation_twitch", label: "Modération Twitch", emoji: "🟣", roles: ["Administrateur", "Gestionnaire Twitch", "Moderateur Twitch"] },
  { value: "moderation_youtube", label: "Modération YouTube", emoji: "🔴", roles: ["Administrateur", "Moderateur YouTube"] },
  { value: "animation", label: "Animation", emoji: "🎉", roles: ["Administrateur", "Moderateur Animation"] },
  { value: "bug_technique", label: "Bug ou problème technique", emoji: "🛠️", roles: ["Administrateur"] },
  { value: "candidature", label: "Candidature", emoji: "📋", hasSubcategories: true },
  { value: "abus_staff", label: "Signaler un abus d'un Staff", emoji: "🚨", roles: ["Administrateur"] },
  { value: "autre", label: "Autre demande", emoji: "✏️", roles: ["Administrateur", "Moderateur Discord", "Helper"] }
];

// Sous-categories utilisees uniquement quand hasSubcategories est vrai
const CANDIDATURE_SUBCATEGORIES = [
  { value: "candidature_discord", label: "Staff Discord", emoji: "⚔️", description: "Modération / Staff sur le serveur Discord", roles: ["Administrateur", "Gestionnaire.Mods discord"] },
  { value: "candidature_twitch", label: "Twitch", emoji: "🟣", description: "Modération pendant les lives Twitch", roles: ["Administrateur", "Gestionnaire Twitch"] },
  { value: "candidature_youtube", label: "YouTube / TikTok", emoji: "🔴", description: "Modération YouTube / TikTok", roles: ["Administrateur"] },
  { value: "candidature_animation", label: "Animation", emoji: "🎭", description: "Animateur sur le serveur", roles: ["Administrateur", "Gestionnaire.Mods discord"] }
];

function getRolesForCategory(guild, category) {
  const roles = [];
  for (const roleName of category.roles) {
    const role = guild.roles.cache.find(r => r.name === roleName);
    if (role) roles.push(role);
  }
  return roles;
}

function buildTicketPanel() {
  // Bannière ZenyXx jointe (fichier à la racine du projet)
  const banniere = new AttachmentBuilder("./zenyxx_banner.png");

  const embed = new EmbedBuilder()
    .setTitle("🎫 Support — Ouvrir un ticket")
    .setDescription(
      "Sélectionnez le type de demande ci-dessous pour ouvrir un ticket :\n\n" +
      TICKET_CATEGORIES.map(c => `${c.emoji} — **${c.label}**`).join("\n")
    )
    .setImage("attachment://zenyxx_banner.png")
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

  return { embeds: [embed], components: [row], files: [banniere] };
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
    for (const guild of client.guilds.cache.values()) {
      await guild.commands.set(commands);
    }
    console.log("✅ Commandes slash enregistrées (par serveur, instantané) !");
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
      sendLog(guild, "👢 Membre expulsé", null, MODERATION_LOG_CHANNEL_NAME, [
        { name: "Sanctionné", value: `${target.tag} (${target.id})`, inline: true },
        { name: "Modérateur", value: `${member.user.tag}`, inline: true },
        { name: "Raison", value: raison, inline: false }
      ]);
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
      sendLog(guild, "🔨 Membre banni", null, MODERATION_LOG_CHANNEL_NAME, [
        { name: "Sanctionné", value: `${target.tag} (${target.id})`, inline: true },
        { name: "Modérateur", value: `${member.user.tag}`, inline: true },
        { name: "Raison", value: raison, inline: false }
      ]);
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

async function createTicketChannel(interaction, guild, categoryLike) {
  const existing = guild.channels.cache.find(
    c => c.name === `ticket-${categoryLike.value}-${interaction.user.username}`.toLowerCase()
  );
  if (existing) {
    return interaction.editReply({ content: `Tu as déjà un ticket ouvert : ${existing}` });
  }

  const staffRoles = getRolesForCategory(guild, categoryLike);

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
    name: `ticket-${categoryLike.value}-${interaction.user.username}`.toLowerCase(),
    type: ChannelType.GuildText,
    permissionOverwrites
  }).catch(() => null);

  if (!ticketChannel) {
    return interaction.editReply({ content: "❌ Impossible de créer le ticket. Vérifie mes permissions." });
  }

  const welcomeEmbed = new EmbedBuilder()
    .setTitle(`${categoryLike.emoji} Ticket — ${categoryLike.label}`)
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

  const SILENT_ROLES = ["Administrateur", "Gestionnaire.Mods discord"];
  const pingCandidates = staffRoles.filter(r => !SILENT_ROLES.includes(r.name));
  const mentionRoles = (pingCandidates.length > 0 ? pingCandidates : staffRoles)
    .map(r => `<@&${r.id}>`).join(" ");

  await ticketChannel.send({
    content: `${interaction.user} ${mentionRoles}`,
    embeds: [welcomeEmbed],
    components: [row]
  });

  await interaction.editReply({ content: `✅ Ton ticket a été créé : ${ticketChannel}` });

  sendLog(guild, "🎫 Ticket créé", `**${interaction.user.tag}** a ouvert un ticket : **${categoryLike.label}**\nSalon : ${ticketChannel}`, TICKET_LOG_CHANNEL_NAME);
}

// --- Menu déroulant de sélection de ticket ---
if (interaction.isStringSelectMenu() && interaction.customId === "ticket_category_select") {
  const categoryValue = interaction.values[0];
  const category = TICKET_CATEGORIES.find(c => c.value === categoryValue);
  if (!category) return;

  if (category.hasSubcategories) {
    const subEmbed = new EmbedBuilder()
      .setTitle("📋 Candidature")
      .setDescription(
        "Pour quel secteur souhaitez-vous postuler ?\n\n" +
        CANDIDATURE_SUBCATEGORIES.map(s => `${s.emoji} — **${s.label}**`).join("\n") +
        "\n\nSélectionnez une option ci-dessous pour ouvrir votre ticket de candidature."
      )
      .setColor(0x5865F2);

    const subMenu = new StringSelectMenuBuilder()
      .setCustomId("candidature_subcategory_select")
      .setPlaceholder("Sélectionnez le secteur visé")
      .addOptions(
        CANDIDATURE_SUBCATEGORIES.map(s => ({
          label: s.label,
          value: s.value,
          emoji: s.emoji,
          description: s.description
        }))
      );

    const row = new ActionRowBuilder().addComponents(subMenu);

    return interaction.reply({
      embeds: [subEmbed],
      components: [row],
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });
  await createTicketChannel(interaction, guild, category);
  return;
}

// --- Menu déroulant de sous-catégorie (Candidature) ---
if (interaction.isStringSelectMenu() && interaction.customId === "candidature_subcategory_select") {
  const subValue = interaction.values[0];
  const subCategory = CANDIDATURE_SUBCATEGORIES.find(s => s.value === subValue);
  if (!subCategory) return;

  await interaction.deferReply({ ephemeral: true });
  await createTicketChannel(interaction, guild, subCategory);
  return;
}

  // --- Bouton fermer le ticket ---
  if (interaction.isButton() && interaction.customId === "close_ticket") {
    await interaction.reply({ content: "🔒 Ce ticket sera fermé dans 5 secondes..." });

    const ticketLogChannel = getLogChannel(guild, TICKET_LOG_CHANNEL_NAME);

    if (ticketLogChannel) {
      try {
        const transcript = await createTranscript(interaction.channel, {
          limit: -1,
          returnType: "attachment",
          filename: `transcript-${interaction.channel.name}.html`,
          saveImages: true,
          poweredBy: false
        });

        const closeEmbed = new EmbedBuilder()
          .setTitle("🔒 Ticket fermé")
          .setDescription(`Ticket **${interaction.channel.name}** fermé par **${member.user.tag}**`)
          .setTimestamp();

        await ticketLogChannel.send({ embeds: [closeEmbed], files: [transcript] });
      } catch (error) {
        console.error("Erreur lors de la génération du transcript :", error);
        sendLog(guild, "🔒 Ticket fermé", `Ticket **${interaction.channel.name}** fermé par **${member.user.tag}**\n(⚠️ transcript non généré, voir les logs du bot)`, TICKET_LOG_CHANNEL_NAME);
      }
    }

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
client.on("guildBanAdd", async ban => {
  let executorTag = "Inconnu (banni hors du bot)";
  let raison = ban.reason || "Aucune raison fournie";

  try {
    const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 5 });
    const entry = logs.entries.find(e => e.target?.id === ban.user.id);
    if (entry) {
      executorTag = entry.executor?.tag || executorTag;
      raison = entry.reason || raison;
    }
  } catch (error) {
    console.error("Impossible de lire les logs d'audit (ban) :", error);
  }

  sendLog(ban.guild, "🔨 Membre banni", null, MODERATION_LOG_CHANNEL_NAME, [
    { name: "Sanctionné", value: `${ban.user.tag} (${ban.user.id})`, inline: true },
    { name: "Modérateur", value: executorTag, inline: true },
    { name: "Raison", value: raison, inline: false }
  ]);
});

// Déban
client.on("guildBanRemove", async ban => {
  let executorTag = "Inconnu (débanni hors du bot)";

  try {
    const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanRemove, limit: 5 });
    const entry = logs.entries.find(e => e.target?.id === ban.user.id);
    if (entry) {
      executorTag = entry.executor?.tag || executorTag;
    }
  } catch (error) {
    console.error("Impossible de lire les logs d'audit (déban) :", error);
  }

  sendLog(ban.guild, "🔓 Membre débanni", null, MODERATION_LOG_CHANNEL_NAME, [
    { name: "Débanni", value: `${ban.user.tag} (${ban.user.id})`, inline: true },
    { name: "Modérateur", value: executorTag, inline: true }
  ]);
});

// Erreurs
client.on("error", error => {
  console.error("Erreur Discord :", error);
});

client.login(process.env.DISCORD_TOKEN);
