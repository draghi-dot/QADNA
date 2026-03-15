import { onRequest } from 'firebase-functions/v2/https'
import { app } from './server/index.js'

export const api = onRequest(
  {
    timeoutSeconds: 540,
    memory: '2GiB',
    cpu: 2,
    concurrency: 80,
    invoker: 'public',
  },
  app
)
