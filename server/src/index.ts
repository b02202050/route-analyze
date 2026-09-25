import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { GenerateRequest } from '../../shared/types';
import { brouterCheck, RouterError } from './brouter';
import { config } from './config';
import { generateRoutes, UserError } from './generator';
import { geocode } from './geocode';

const b = config.serviceBounds;
const latLng = z.object({
  lat: z.number().min(b.minLat).max(b.maxLat),
  lng: z.number().min(b.minLng).max(b.maxLng),
  label: z.string().max(200).optional(),
});
const pref = z.union([z.literal(1), z.literal(0), z.literal(-1)]);

const generateSchema = z.object({
  start: latLng,
  end: latLng.nullable(),
  loop: z.boolean(),
  waypoints: z.array(latLng).max(20),
  prefs: z.object({
    avoidSignals: z.boolean(),
    sidewalk: pref,
    cycleway: pref,
    road: pref,
  }),
  distance: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('shortest') }),
    z.object({ mode: z.literal('target'), km: z.number().min(0.5).max(100) }),
  ]),
  climb: z.object({ targetM: z.number().min(0).max(5000) }).optional(),
  count: z.number().int().min(1).max(5).optional(),
  seed: z.number().int().min(0).max(0xffffffff).optional(),
  exclude: z.array(z.array(z.tuple([z.number(), z.number()])).max(5000)).max(5).optional(),
});

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 5 * 1024 * 1024 });

app.get('/api/health', async () => {
  const error = await brouterCheck();
  return { ok: error === null, brouter: error ?? 'ok' };
});

app.post('/api/routes', async (req, reply) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    const outOfBounds = parsed.error.issues.some((i) => i.path.includes('lat') || i.path.includes('lng'));
    return reply.code(400).send({
      error: outOfBounds ? '地點超出服務範圍（目前支援台灣本島）' : '參數格式錯誤',
      details: parsed.error.issues,
    });
  }
  try {
    const result = await generateRoutes(parsed.data as GenerateRequest);
    req.log.info({ seed: result.seed, ...result.stats }, 'routes generated');
    return result;
  } catch (err) {
    if (err instanceof UserError) return reply.code(422).send({ error: err.message });
    if (err instanceof RouterError) {
      req.log.warn(err);
      return reply.code(502).send({ error: `路線引擎錯誤：${err.message}` });
    }
    throw err;
  }
});

app.get<{ Querystring: { q?: string } }>('/api/geocode', async (req, reply) => {
  const q = (req.query.q ?? '').slice(0, 200);
  try {
    return { results: await geocode(q) };
  } catch (err) {
    req.log.warn(err);
    return reply.code(502).send({ error: '地點搜尋暫時無法使用' });
  }
});

// 正式模式：由同一個 server 提供前端靜態檔
if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

await app.listen({ port: config.port, host: config.host });
const brouterError = await brouterCheck();
if (brouterError) app.log.error(`BRouter 自我檢查失敗（${config.brouterUrl}）：${brouterError}`);
else app.log.info(`BRouter: ${config.brouterUrl}（測試路線規劃成功）`);
