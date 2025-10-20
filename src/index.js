require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} = require('discord.js');
const EventManager = require('./eventManager');
const ReactionRoleManager = require('./reactionRoleManager');
const { extractId, formatDuration } = require('./utils/parsers');
const { splitArgs } = require('./utils/args');

const configPath = path.join(__dirname, '..', 'config', 'config.json');
const defaultConfig = { prefix: '!', defaultReportChannelId: '' };
const config = fs.existsSync(configPath)
  ? { ...defaultConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
  : defaultConfig;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
});

const eventManager = new EventManager(client);
const reactionRoleManager = new ReactionRoleManager(client);

async function bootstrap() {
  await eventManager.init();
  await reactionRoleManager.init();
}

client.once('ready', async () => {
  console.log(`Bot conectado como ${client.user.tag}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  eventManager.handleVoiceUpdate(oldState, newState);
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!message.content.startsWith(config.prefix)) return;

  const withoutPrefix = message.content.slice(config.prefix.length).trim();
  const [command, ...rest] = splitArgs(withoutPrefix);
  if (!command) return;

  try {
    switch (command.toLowerCase()) {
      case 'event':
        await handleEventCommand(message, rest);
        break;
      case 'reaction-role':
        await handleReactionRoleCommand(message, rest);
        break;
      case 'warn':
        await handleWarnCommand(message, rest);
        break;
      default:
        await message.reply('Comando não reconhecido.');
    }
  } catch (error) {
    console.error(error);
    await message.reply(`❌ Ocorreu um erro: ${error.message}`);
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Não foi possível carregar a reação adicionada.', error);
      return;
    }
  }
  await reactionRoleManager.handleReactionAdd(reaction, user);
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Não foi possível carregar a reação removida.', error);
      return;
    }
  }
  await reactionRoleManager.handleReactionRemove(reaction, user);
});

async function handleEventCommand(message, args) {
  const subcommand = args.shift();
  if (!subcommand) {
    await message.reply('Use `event start`, `event stop` ou `event list`.');
    return;
  }

  switch (subcommand.toLowerCase()) {
    case 'start':
      await startEvent(message, args);
      break;
    case 'stop':
      await stopEvent(message, args);
      break;
    case 'list':
      await listEvents(message);
      break;
    default:
      await message.reply('Subcomando de evento desconhecido.');
  }
}

async function startEvent(message, args) {
  if (args.length < 3) {
    await message.reply('Uso: `event start "Nome do Evento" <cargo> <canal...>`');
    return;
  }

  const eventName = args.shift().trim();
  const roleId = extractId(args.shift());
  const requestedChannelIds = args.map((value) => extractId(value)).filter(Boolean);

  const channelIds = [];
  for (const channelId of requestedChannelIds) {
    const channel = message.guild.channels.cache.get(channelId) || await message.guild.channels.fetch(channelId).catch(() => null);
    if (channel && channel.isVoiceBased()) {
      channelIds.push(channelId);
    }
  }

  if (!roleId || channelIds.length === 0) {
    await message.reply('Informe um cargo válido e pelo menos um canal de voz.');
    return;
  }

  const event = await eventManager.startEvent(message.guild, eventName, roleId, channelIds, message.author.id);
  await message.reply(`✅ Evento "${event.name}" iniciado para o cargo <@&${roleId}>.`);
}

async function stopEvent(message, args) {
  if (args.length < 1) {
    await message.reply('Uso: `event stop "Nome do Evento"`');
    return;
  }

  const eventName = args.join(' ');
  const { summary, present, absent } = await eventManager.endEvent(message.guild, eventName);

  const embed = new EmbedBuilder()
    .setTitle(`Relatório do evento: ${summary.eventName}`)
    .setDescription(`Início: <t:${Math.floor(new Date(summary.startedAt).getTime() / 1000)}:f>\nFim: <t:${Math.floor(new Date(summary.endedAt).getTime() / 1000)}:f>`)
    .addFields(
      {
        name: `Presentes (${present.length})`,
        value: present.length > 0
          ? present
              .map((entry) => `• ${entry.displayName} — ${formatDuration(entry.totalMs)}`)
              .join('\n')
          : 'Nenhum membro com o cargo participou.',
      },
      {
        name: `Faltas (${absent.length})`,
        value: absent.length > 0
          ? absent.map((entry) => `• ${entry.displayName}`).join('\n')
          : 'Todos os membros com o cargo participaram.',
      },
    )
    .setTimestamp(new Date(summary.endedAt));

  const targetChannelId = config.defaultReportChannelId || message.channelId;
  const targetChannel = message.guild.channels.cache.get(targetChannelId) || message.channel;
  await targetChannel.send({ embeds: [embed] });
}

async function listEvents(message) {
  const events = eventManager.listActive().filter((event) => event.guildId === message.guild.id);
  if (events.length === 0) {
    await message.reply('Não há eventos ativos neste servidor.');
    return;
  }

  const lines = events.map((event) => {
    const started = Math.floor(new Date(event.startedAt).getTime() / 1000);
    const channels = event.channelIds.map((id) => `<#${id}>`).join(', ');
    return `• **${event.name}** — Cargo: <@&${event.roleId}> — Canais: ${channels} — Iniciado em <t:${started}:f>`;
  });

  await message.reply(lines.join('\n'));
}

async function handleReactionRoleCommand(message, args) {
  const subcommand = args.shift();
  if (!subcommand) {
    await message.reply('Use `reaction-role create` ou `reaction-role remove`.');
    return;
  }

  switch (subcommand.toLowerCase()) {
    case 'create':
      await createReactionRole(message, args);
      break;
    case 'remove':
      await removeReactionRole(message, args);
      break;
    default:
      await message.reply('Subcomando de reação desconhecido.');
  }
}

async function createReactionRole(message, args) {
  if (args.length < 4) {
    await message.reply('Uso: `reaction-role create <canal> <emoji> <cargo> "Mensagem"`');
    return;
  }

  const channelId = extractId(args.shift());
  const emoji = args.shift();
  const roleId = extractId(args.shift());
  const messageContent = args.join(' ');

  if (!channelId || !emoji || !roleId) {
    await message.reply('Confira se canal, emoji e cargo foram informados corretamente.');
    return;
  }

  const channel = await message.guild.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    await message.reply('O canal informado não é um canal de texto.');
    return;
  }

  await reactionRoleManager.createReactionRole({
    channel,
    emoji,
    roleId,
    messageContent,
  });

  await message.reply('Mensagem de reação criada com sucesso.');
}

async function removeReactionRole(message, args) {
  if (args.length < 1) {
    await message.reply('Uso: `reaction-role remove <messageId>`');
    return;
  }

  const messageId = args[0];
  await reactionRoleManager.removeReactionRole(messageId);
  await message.reply('Reação de cargo removida.');
}

async function handleWarnCommand(message, args) {
  if (args.length < 2) {
    await message.reply('Uso: `warn <canal> "Mensagem"`');
    return;
  }

  const channelId = extractId(args.shift());
  const content = args.join(' ');
  const channel = await message.guild.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    await message.reply('Informe um canal de texto válido.');
    return;
  }

  await channel.send({ content });
  if (channel.id !== message.channel.id) {
    await message.reply('Aviso enviado.');
  }
}

bootstrap()
  .then(() => {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      throw new Error('Defina a variável de ambiente DISCORD_TOKEN com o token do bot.');
    }
    return client.login(token);
  })
  .catch((error) => {
    console.error('Falha ao inicializar o bot.', error);
    process.exit(1);
  });
