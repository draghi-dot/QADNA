/**
 * Dev utility — manually set a user's paid status in Firestore.
 *
 * Usage:
 *   node server/scripts/set-user-paid.mjs <userId> <true|false>
 *
 * Example:
 *   node server/scripts/set-user-paid.mjs abc123uid true
 *   node server/scripts/set-user-paid.mjs abc123uid false
 */

import admin from 'firebase-admin'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const keyPath = path.join(__dirname, '..', 'serviceAccountKey.json')

const [,, userId, paidArg] = process.argv

if (!userId || paidArg === undefined) {
  console.error('Usage: node server/scripts/set-user-paid.mjs <userId> <true|false>')
  process.exit(1)
}

const hasPaid = paidArg === 'true'

try {
  const serviceAccount = JSON.parse(readFileSync(keyPath, 'utf8'))
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
  const db = admin.firestore()

  await db.collection('users').doc(userId).set({
    hasPaid,
    updatedAt: new Date().toISOString(),
    ...(hasPaid ? { paidAt: new Date().toISOString() } : { paidAt: null }),
  }, { merge: true })

  console.log(`✓ User ${userId} → hasPaid: ${hasPaid}`)
  process.exit(0)
} catch (err) {
  console.error('Error:', err.message)
  process.exit(1)
}
