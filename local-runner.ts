import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 18080);
const server = createApp();
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`forge listening on ${port}\n`);
});
