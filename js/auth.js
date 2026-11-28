// Authentication and session management (Supabase Auth). Gameplay never depends on this module:
// every failure here is contained and reported as a state, and IndexedDB is never touched.
import { loadSupabaseClient } from './supabaseClient.js';

export const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthError extends Error {
  constructor(code, message) { super(message); this.name = 'AuthError'; this.code = code; }
}

// Turns library/network errors into a code plus a calm, useful message.
export function classify(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (err instanceof AuthError) return { code: err.code, message: err.message };
  if (/failed to fetch|networkerror|network request failed|load failed|fetch failed/.test(msg) || (err && err.name === 'AuthRetryableFetchError'))
    return { code: 'offline', message: 'No connection right now. Your progress is safe on this device. Try again when you are online.' };
  if (/invalid login credentials/.test(msg)) return { code: 'credentials', message: 'That email and password do not match.' };
  if (/email not confirmed/.test(msg)) return { code: 'unconfirmed', message: 'Please confirm your email first. Check your inbox for the link.' };
  if (/already registered|already been registered|user already/.test(msg)) return { code: 'exists', message: 'An account with that email may already exist. Try signing in or resetting your password.' };
  if (/rate limit|too many|over_email_send_rate_limit/.test(msg) || (err && err.status === 429)) return { code: 'rate_limit', message: 'Too many attempts. Please wait a few minutes and try again.' };
  if (/password/.test(msg) && /(weak|short|least|characters)/.test(msg)) return { code: 'weak_password', message: `Choose a stronger password (at least ${MIN_PASSWORD} characters).` };
  return { code: 'other', message: 'Something went wrong. Please try again.' };
}
const fail = (err) => { const c = classify(err); return new AuthError(c.code, c.message); };

export function createAuth({ load = loadSupabaseClient, now = () => Date.now(), redirectTo = '' } = {}) {
  let client = null, manualSignOut = false;
  let state = { status: 'loading', user: null, expired: false, message: '' };
  const listeners = new Set();
  const set = (patch) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn(state)); };
  const userOf = (s) => (s && s.user ? { id: s.user.id, email: s.user.email } : null);
  const isExpired = (s) => !!s && typeof s.expires_at === 'number' && s.expires_at * 1000 <= now();

  function apply(event, session) {
    if (event === 'PASSWORD_RECOVERY') return set({ status: 'recovery', user: userOf(session), expired: false, message: '' });
    if (state.status === 'recovery' && session && event !== 'SIGNED_OUT') return; // finish the recovery first
    if (event === 'SIGNED_OUT' || !session) {
      const unexpected = !manualSignOut && state.status === 'signed_in';
      manualSignOut = false;
      return set({ status: 'signed_out', user: null, expired: false,
        message: unexpected ? 'Your session ended. Sign in again to resume syncing. Your progress is still on this device.' : '' });
    }
    set({ status: 'signed_in', user: userOf(session), expired: isExpired(session), message: '' });
  }

  const needClient = () => {
    if (!client) throw new AuthError('unavailable', 'Account features are unavailable right now. Everything else works normally.');
    return client;
  };
  const checkEmail = (email) => { if (!EMAIL_RE.test(email || '')) throw new AuthError('validation', 'Enter a valid email address.'); };
  const checkPassword = (pw) => { if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw new AuthError('validation', `Use a password with at least ${MIN_PASSWORD} characters.`); };

  return {
    getState: () => state,
    getClient: () => client,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async init() {
      try { client = await load(); }
      catch { set({ status: 'unavailable', message: 'Account features are unavailable right now (you may be offline). Everything else works normally.' }); return state; }
      client.auth.onAuthStateChange((event, session) => apply(event, session));
      try { const { data } = await client.auth.getSession(); apply('INITIAL_SESSION', data && data.session); }
      catch { apply('INITIAL_SESSION', null); }
      return state;
    },

    // Re-checks expiry (call when the app regains focus or connectivity).
    async refreshState() {
      if (!client) return state;
      try { const { data } = await client.auth.getSession(); apply('REFRESH_CHECK', data && data.session); } catch { /* stay as is */ }
      return state;
    },

    async signUp(email, password) {
      email = (email || '').trim(); checkEmail(email); checkPassword(password);
      const { data, error } = await needClient().auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } }).catch((e) => ({ error: e }));
      if (error) throw fail(error);
      if (!data || !data.session) return { status: 'confirm_email' };
      apply('SIGNED_IN', data.session);
      return { status: 'signed_in' };
    },

    async signIn(email, password) {
      email = (email || '').trim(); checkEmail(email);
      if (!password) throw new AuthError('validation', 'Enter your password.');
      const { data, error } = await needClient().auth.signInWithPassword({ email, password }).catch((e) => ({ error: e }));
      if (error) throw fail(error);
      apply('SIGNED_IN', data && data.session);
      return { status: 'signed_in' };
    },

    // Local sign-out: works offline, never deletes or changes local game data.
    async signOut() {
      manualSignOut = true;
      try { if (client) await client.auth.signOut({ scope: 'local' }); } catch { /* signing out must always succeed locally */ }
      apply('SIGNED_OUT', null);
    },

    // Always reports success for unknown emails (no account enumeration); only connectivity/rate problems surface.
    async requestPasswordReset(email) {
      email = (email || '').trim(); checkEmail(email);
      const { error } = await needClient().auth.resetPasswordForEmail(email, { redirectTo }).catch((e) => ({ error: e }));
      if (error) { const c = classify(error); if (c.code === 'offline' || c.code === 'rate_limit') throw new AuthError(c.code, c.message); }
      return { status: 'sent' };
    },

    async updatePassword(newPassword) {
      checkPassword(newPassword);
      const { data, error } = await needClient().auth.updateUser({ password: newPassword }).catch((e) => ({ error: e }));
      if (error) throw fail(error);
      const { data: s } = await client.auth.getSession();
      state = { ...state, status: 'signed_in' }; // recovery is finished
      apply('USER_UPDATED', (s && s.session) || (data && data.user ? { user: data.user } : null));
      return { status: 'updated' };
    },

    // For the sync engine: proves there is a live, unexpired session or throws. Never used by gameplay.
    async requireUser() {
      const c = needClient();
      let session = null;
      try { const { data } = await c.auth.getSession(); session = data && data.session; } catch { /* treated as no session */ }
      if (!session) throw new AuthError('unauthorized', 'Sign in to use cloud features.');
      if (isExpired(session)) throw new AuthError('expired', 'Your session has expired. Reconnect and sign in again to resume syncing.');
      return userOf(session);
    },
  };
}
