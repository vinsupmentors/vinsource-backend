import Redis from 'ioredis';
import { config } from './env';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  // Redis is optional in development — give up after a few attempts instead
  // of retrying forever. Returning null/undefined tells ioredis to stop.
  retryStrategy: (times) => {
    if (times > 3) return null;
    return Math.min(times * 50, 2000);
  },
  lazyConnect: true,
});

let loggedUnavailable = false;
redis.on('connect', () => {
  loggedUnavailable = false;
  console.log('✅ Redis connected');
});
redis.on('error', (err) => {
  // After retries are exhausted, ioredis keeps emitting 'error' on every
  // subsequent command that touches it — log once instead of spamming.
  if (!loggedUnavailable) {
    console.error('❌ Redis error:', err.message);
    loggedUnavailable = true;
  }
});

export default redis;
