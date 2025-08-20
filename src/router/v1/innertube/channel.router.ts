import { Hono } from "hono";
import { AppSchema } from "@/app";
import { createLogger } from "@/lib/logger.lib";
import type { Context } from "hono";
import { mapErrorToHttp } from "@/lib/hono.util";

export const v1InnertubeChannelRouter = new Hono<AppSchema>();
const logger = createLogger('router:v1:innertube:channel');
logger.debug('Initializing /v1/innertube/channel router');

v1InnertubeChannelRouter.get('/', async (c: Context<AppSchema>) => {
  const navigationEndpoint = c.get('navigationEndpoint');

  try {
    const channelId = navigationEndpoint?.payload?.browseId;
    if (!channelId) return c.json({ error: 'Channel ID not found' }, 400);
    const channel = await c.get('innertubeSvc').getInnertube().getChannel(channelId);
    return c.json(channel);
  } catch (err) {
    const { status, ...body } = mapErrorToHttp(err);
    return c.json(body, status as any);
  }
});
