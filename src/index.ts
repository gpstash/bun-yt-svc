import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => {
  return c.text('Hello Hono!');
})

export default {
  fetch: app.fetch,
  port: Number(process.env.APP_PORT) ?? 1331,
};
