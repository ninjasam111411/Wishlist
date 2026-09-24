// api/delete-account.js
//
// Vercel serverless function. A signed-in person can't delete their own
// Supabase account from the browser -- that needs the project's
// service_role key, which must never reach the browser. This function
// holds that key (in the SUPABASE_SERVICE_ROLE_KEY environment variable
// on Vercel, added the same way GEMINI_API_KEY was) and, after checking
// the caller's own access token, deletes exactly that one account.
//
// Deleting the auth.users row cascades through the database on its own
// (see supabase-schema.sql): the profiles row, this person's
// group_members rows, and their wishlist_items rows all go with it;
// groups they created stay (ownership just clears), and any item they'd
// marked bought for someone else stays marked bought (just with no name
// attached anymore) -- there's nothing extra this function needs to
// clean up itself.
//
// Like the other functions here, this uses plain fetch calls to
// Supabase's REST API instead of the @supabase/supabase-js library, so
// the project still needs no npm dependencies / build step.
//
// Expects: POST with header  Authorization: Bearer <the signed-in
//          user's own access token>
// Returns: { ok: true }   or   { error: string }

const SUPABASE_URL = "https://fobobmhfuevqdgvvyxxm.supabase.co";

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

  try {
    // Who does this access token actually belong to? This is what stops
    // anyone from deleting an account other than their own -- the
    // deletion below always targets the id THIS lookup returns, never
    // an id sent from the browser.
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
    if (!who || !who.id) {
      res.status(401).json({ error: "Couldn't identify your account." });
      return;
    }

    const deleteRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${who.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
    });
    if (!deleteRes.ok) {
      const errData = await deleteRes.json().catch(() => ({}));
      res.status(500).json({
        error: errData.msg || errData.error_description || errData.error || "Couldn't delete the account.",
      });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete account: " + err.message });
  }
}

