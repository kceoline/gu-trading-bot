export const {
  RABBIT_URL,
  TRADING,
} = process.env;

export const MAX_REQUESTS = Number(process.env.MAX_REQUESTS || '30');
export const REQUESTS_DURATION_MS = Number(process.env.REQUESTS_DURATION_MS || '10000');
export const RABBIT_PREFETCH = Number(process.env.RABBIT_PREFETCH || '1');