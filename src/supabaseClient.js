import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Thiếu biến môi trường Supabase. Hãy tạo file .env ở root project với VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  // Phiên sống trong sessionStorage → tự mất khi ĐÓNG trình duyệt/tab (bảo mật: ai mở lại
  // phải đăng nhập lại). F5/reload trong cùng tab vẫn giữ phiên.
  auth: {
    storage: typeof window !== 'undefined' ? window.sessionStorage : undefined,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

/**
 * Gọi Edge Function `auth-login` để đăng nhập (đếm khóa ở server).
 * Dùng anon key vì chưa có JWT. Trả `{ ok, status, data, error }`.
 */
export async function callAuthLogin(username, password) {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/auth-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({ action: 'login', username, password }),
    })
    const json = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data: json, error: json?.error }
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || 'Network error' }
  }
}

/**
 * Gọi Edge Function `admin-users` với JWT của user hiện tại.
 * Trả `{ ok, data, error, status }`. Không throw — luôn resolve.
 */
export async function callAdminUsers(body) {
  const { data: sess } = await supabase.auth.getSession()
  const token = sess?.session?.access_token
  if (!token) return { ok: false, error: 'Chưa đăng nhập', status: 401 }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/admin-users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    return { ok: res.ok, data: json, error: json?.error, status: res.status }
  } catch (err) {
    return { ok: false, error: err?.message || 'Network error', status: 0 }
  }
}

/**
 * Gọi Edge Function `mfa-recovery` để dùng recovery code thay TOTP.
 */
export async function callMfaRecovery(code) {
  const { data: sess } = await supabase.auth.getSession()
  const token = sess?.session?.access_token
  if (!token) return { ok: false, error: 'Chưa đăng nhập', status: 401 }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/mfa-recovery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code }),
    })
    const json = await res.json().catch(() => ({}))
    return { ok: res.ok, data: json, error: json?.error, status: res.status }
  } catch (err) {
    return { ok: false, error: err?.message || 'Network error', status: 0 }
  }
}