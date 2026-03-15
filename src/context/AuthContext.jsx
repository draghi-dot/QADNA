import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { auth, googleProvider, db } from '../firebase'
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [hasPaid, setHasPaid] = useState(false)
  const [authLoading, setAuthLoading] = useState(true)
  const [profileOpen, setProfileOpen] = useState(false)

  const openProfile = () => setProfileOpen(true)
  const closeProfile = () => setProfileOpen(false)

  const checkPayment = useCallback(async (firebaseUser) => {
    if (!firebaseUser) { setHasPaid(false); return }
    try {
      const ref = doc(db, 'users', firebaseUser.uid)
      const snap = await getDoc(ref)

      if (!snap.exists()) {
        // First sign-in — create the user document as unpaid
        await setDoc(ref, {
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName || '',
          hasPaid: false,
          createdAt: new Date().toISOString(),
        })
        setHasPaid(false)
      } else {
        setHasPaid(snap.data()?.hasPaid === true)
      }
    } catch {
      // Network error (ad blocker, offline) — don't reset paid status
      // so paid users aren't locked out by transient failures
    }
  }, [])

  useEffect(() => {
    return onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser)
      await checkPayment(firebaseUser)
      setAuthLoading(false)
    })
  }, [checkPayment])

  // Re-check payment when user returns to the tab (after Stripe redirect)
  useEffect(() => {
    const handleFocus = () => { if (user) checkPayment(user) }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [user, checkPayment])

  const login = () => signInWithPopup(auth, googleProvider)
  const logout = () => { signOut(auth); setHasPaid(false) }
  const refreshPayment = () => checkPayment(user)

  return (
    <AuthContext.Provider value={{
      user,
      hasPaid,
      authLoading,
      login,
      logout,
      refreshPayment,
      profileOpen,
      openProfile,
      closeProfile,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
