# Discord Event Bot

Bot de Discord em JavaScript para rastrear presença em eventos, administrar cargos via reação e enviar avisos automatizados.

## Recursos principais

- Rastreamento de tempo em canais de voz para membros de um cargo específico.
- Criação de múltiplos eventos simultâneos, cada um com salas monitoradas.
- Relatórios automáticos ao encerrar o evento, permitindo escolher o cargo para verificar presentes e ausentes.
- Mensagens com reação para autoatribuição de cargo.
- Envio de avisos para canais de texto escolhidos.

## Como começar

1. Copie `config/config.example.json` para `config/config.json` e ajuste as opções necessárias (por padrão, apenas o prefixo dos comandos).
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
