# Discord Event Bot

Bot de Discord em JavaScript para rastrear presença em eventos, administrar cargos via reação e enviar avisos automatizados.

## Recursos principais

- Rastreamento de tempo em canais de voz para membros de um cargo específico.
- Criação de múltiplos eventos simultâneos, cada um com salas monitoradas.
- Assistentes interativos diretos no chat para iniciar e encerrar eventos, criar mensagens de cargo por reação e enviar avisos.
- Relatórios automáticos ao encerrar o evento, entregues em documento enviado por mensagem direta ao administrador que encerrou o evento.
- Mensagens com reação para autoatribuição de cargo, com assistente guiado para configurar canal, mensagem e emoji.
- Envio de avisos para canais de texto escolhidos, com fluxo guiado para selecionar canal e conteúdo.
- Sistema de tickets para suporte: usuários abrem um canal privado e a equipe configurada atende e encerra com um clique.
- Painel fixo com botão "Abrir Ticket" para que membros iniciem o atendimento diretamente do canal desejado.

## Como começar

1. Copie `config/config.example.json` para `config/config.json` e ajuste as opções necessárias (por padrão, o prefixo dos comandos e o cargo que atenderá os tickets em `tickets.supportRoleId`; defina também `tickets.categoryId` se quiser agrupar os canais de suporte em uma categoria específica).
2. Crie um arquivo `.env` na raiz do projeto com o token do bot:

   ```env
   DISCORD_TOKEN=seu_token_aqui
   ```
3. Instale as dependências e inicialize o bot:

   ```bash
   npm install
   npm start
   ```

4. No Discord, use o comando `!help` (ou o prefixo configurado) para visualizar todos os comandos disponíveis diretamente no chat.

## Documentação detalhada

A explicação completa das funcionalidades e comandos está disponível em [`docs/BOT_DOCUMENTATION.md`](docs/BOT_DOCUMENTATION.md).

Para orientações de implantação, consulte:

- [Guia de deploy na RedHosting](docs/DEPLOY_REDHOSTING.md)
