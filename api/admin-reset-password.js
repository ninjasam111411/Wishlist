// api/admin-reset-password.js
//
// Vercel serverless function. Lets the one designated admin account set
// a new password for any other account directly -- this stands in for
// "forgot password", which this project can't yet deliver by email (see
// git history: Supabase's shared/free mailer wasn't delivering at all).
//
// Like the other functions here, this uses plain fetch calls to
// Supabase's REST API instead of the @supabase/supabase-js library, so
// the project still needs no npm dependencies / build step.
//
// Expects: POST { target_user_id: string, new_password: string }
//          header  Authorization: Bearer <the signed-in caller's own
//          access token>
// Returns: { ok: true }  or  { error: string }
//
// Security note: the ADMIN_EMAIL check below is the real gate -- the
// matching check in app.js only controls whether the Admin button shows
// up in the UI. Anyone who isn't sam.matthew.starner@gmail.com gets a
// 403 here no matter what they send, and the target account is always
// whatever id is passed in -- this function doesn't care whether that
// account belongs to a group the admin is even in.

const SUPABASE_URL = "https://fobobmhfuevqdgvvyxxm.supabase.co";
const ADMIN_EMAIL = "sam.matthew.starner@gmail.com";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    res.status(500).json({
      error: "The server is missing a SUPABASE_SERVICE_ROLE_KEY environment variable.",
    });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  const { target_user_id: targetUserId, new_password: newPassword } = req.body || {};
  if (!targetUserId || !newPassword) {
    res.status(400).json({ error: "Missing target_user_id or new_password." });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters." });
    return;
  }

  try {
    const whoRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: serviceRoleKey,
      },
    });
    if (!whoRes.ok) {
      res.status(401).json({ error: "Not signed in (or your session expired) -- please sign in again." });
      return;
    }
    const who = await whoRes.json();
    if (!who || !who.email || who.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      res.status(403).json({ error: "Only the admin account can do this." });
      return;
    }

    const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${targetUserId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: newPassword }),
    });
    if (!updateRes.ok) {
      const errData = await updateRes.json().catch(() => ({}));
      res.status(500).json({
        error: errData.msg || errData.error_description || errData.error || "Couldn't update that account's password.",
      });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update password: " + err.message });
  }
}
