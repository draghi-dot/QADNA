/**
 * Firebase Admin SDK initialization.
 * - In Cloud Functions: uses Application Default Credentials (automatic)
 * - Locally: uses service account key from ./serviceAccountKey.json
 */

import admin from 'firebase-admin'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const IS_CLOUD_FUNCTION = !!process.env.FUNCTION_TARGET || !!process.env.K_SERVICE

let db = null
let firebaseReady = false

try {
  if (IS_CLOUD_FUNCTION) {
    // Cloud Functions have automatic credentials
    admin.initializeApp()
  } else {
    const keyPath = path.join(__dirname, 'serviceAccountKey.json')
    if (existsSync(keyPath)) {
      const serviceAccount = JSON.parse(readFileSync(keyPath, 'utf8'))
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      })
    } else {
      console.error('[Firebase] serviceAccountKey.json not found in server/ directory')
      console.error('[Firebase] Download from: Firebase Console → Project Settings → Service Accounts → Generate New Private Key')
    }
  }

  db = admin.firestore()
  firebaseReady = true
  console.log('[Firebase] Admin SDK initialized successfully')
} catch (err) {
  console.error('[Firebase] Failed to initialize:', err.message)
}

export { db, firebaseReady }
