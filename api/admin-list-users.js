// api/admin-list-users.js
//
// Vercel serverless function. Lists every account's id/name/email so the
// family admin can pick one to reset a password for (see
// api/admin-reset-password.js and the Admin screen in app.js).
//
// This project has no reliable outbound email (see git history --
// Supabase's shared/free mailer wasn't delivering), so self-serve
// "forgot password" isn't workable here. Instead, one designated account
// (ADMIN_EMAIL below) can reset anyone's password directly from within
// the app. That only works if it can first see who's out there to pick
// from -- which is what this function is for.
//
// Like the other functions here, this uses plain fetch calls to
// Supabase's REST API instead of the @supabase/supabase-js library, so
// the project still needs no npm dependencies / build step.
//
// Expects: GET with header  Authorization: Bearer <the signed-in
//          caller's own access token>
// Returns: { users: [{ id, first_name, last_name, email }, ...] }
//          or { error: string }
//
// Security note: the ADMIN_EMAIL check below is the real gate -- the
// matching check in app.js only controls whether the Admin button shows
// up in the UI. Anyone who isn't sam.matthew.starner@gmail.com gets a
// 403 here no matter what they send.

const SUPABASE_URL = "https://fobobmhfuevqdgvvyxxm.supabase.co";
const ADMIN_EMAIL = "sam.matthew.starner@gmail.com";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Use GET" });
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

    const listRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=id,first_name,last_name,email&order=first_name.asc.nullslast,last_name.asc.nullslast`,
      {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
        },
      }
    );
    if (!listRes.ok) {
      const errData = await listRes.json().catch(() => ({}));
      res.status(500).json({
        error: errData.message || errData.error || "Couldn't load accounts.",
      });
      return;
    }
    const users = await listRes.json();
    res.status(200).json({ users });
  } catch (err) {
    res.status(500).json({ error: "Failed to load accounts: " + err.message });
  }
}
