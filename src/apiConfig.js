/**
 * API base URL.
 * - In development (Vite): empty string — the Vite proxy handles /api → localhost:3001
 * - In production: set VITE_API_URL to the Express server's public URL
 *   e.g. VITE_API_URL=https://your-server.com
 */
export const API_BASE = import.meta.env.VITE_API_URL || ''
