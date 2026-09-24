// api/send-item-notification.js
//
// Vercel serverless function. Called right after someone adds an item to
// their own wishlist, so the OTHER members of that group -- the people
// who might actually buy it -- get a push notification about it (if
// they've turned that on in Settings). The person who added the item
// never notifies themselves.
//
// This needs the project's service_role key (same as delete-account.js)
// to read push_subscriptions across users and to look up group
// membership -- a signed-in person's own anon-key session can only ever
// see their own subscription row, by design (see supabase-schema.sql).
//
// Like the other functions here, this talks to Supabase's REST API with
// plain fetch calls instead of the @supabase/supabase-js library. The
// one real dependency this file needs is "web-push", which handles the
// VAPID signing and payload encryption the Push API requires -- that's
// not something worth hand-rolling, so this is the one function in this
// project with an npm dependency (see package.json).
//
// Expects:  POST { group_id: string, item_name: string }
//           header  Authorization: Bearer <the signed-in user's own access token>
// Returns:  { ok: true, notified: number }   or   { error: string }
//
// Failures here are deliberately non-fatal to the person adding the
// item -- app.js calls this "fire and forget" after the item is already
// saved, so a problem sending notifications never blocks or errors out
// the add-item flow itself.

import webpush from "web-push";

const SUPABASE_URL = "https://fobobmhfuevqdgvvyxxm.supabase.co";

// The family admin's address, reused from app.js's ADMIN_EMAIL -- VAPID
// requires a contact so a push service can reach the sender if something
// about these notifications needs attention.
const VAPID_CONTACT = "mailto:sam.matthew.starner@gmail.com";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  if (!serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
    res.status(500).json({
      error:
        "The server is missing SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, or VAPID_PRIVATE_KEY.",
    });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  const { group_id, item_name } = req.body || {};
  if (!group_id || typeof group_id !== "string") {
    res.status(400).json({ error: "Missing 'group_id' in request body" });
    return;
  }

  webpush.setVapidDetails(VAPID_CONTACT, vapidPublicKey, vapidPrivateKey);

  const restHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  try {
    // Who is this? (Same pattern as delete-account.js -- never trust a
    // user id sent from the browser, only the one this lookup returns.)
    const whoRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: serviceRoleKey },
    });
    if (!whoRes.ok) {
      res.status(401).json({ error: "Not signed in (or your session expired)." });
      return;
    }
    const who = await whoRes.json();
    if (!who || !who.id) {
      res.status(401).json({ error: "Couldn't identify your account." });
      return;
    }

    // Make sure the caller is actually in this group -- otherwise a
    // group_id could be used to fish for who else is a member.
    const membershipRes = await fetch(
      `${SUPABASE_URL}/rest/v1/group_members?group_id=eq.${group_id}&user_id=eq.${who.id}&select=id`,
      { headers: restHeaders }
    );
    const membership = membershipRes.ok ? await membershipRes.json() : [];
    if (!membership.length) {
      res.status(403).json({ error: "You're not a member of that group." });
      return;
    }

    // The actor's display name, for the notification text.
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${who.id}&select=first_name,last_name`,
      { headers: restHeaders }
    );
    const profileRows = profileRes.ok ? await profileRes.json() : [];
    const profile = profileRows[0] || {};
    const actorName =
      [profile.first_name, profile.last_name].filter(Boolean).join(" ") || "Someone";

    // Everyone else in the group.
    const othersRes = await fetch(
      `${SUPABASE_URL}/rest/v1/group_members?group_id=eq.${group_id}&user_id=neq.${who.id}&select=user_id`,
      { headers: restHeaders }
    );
    const others = othersRes.ok ? await othersRes.json() : [];
    if (!others.length) {
      res.status(200).json({ ok: true, notified: 0 });
      return;
    }
    const otherIds = others.map((m) => m.user_id);

    // Their saved push subscriptions, if any.
    const idsFilter = otherIds.join(",");
    const subsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/push_subscriptions?user_id=in.(${idsFilter})&select=id,endpoint,p256dh,auth_key`,
      { headers: restHeaders }
    );
    const subs = subsRes.ok ? await subsRes.json() : [];
    if (!subs.length) {
      res.status(200).json({ ok: true, notified: 0 });
      return;
    }

    const itemName = typeof item_name === "string" && item_name.trim() ? item_name.trim() : "an item";
    const payload = JSON.stringify({
      title: "New wishlist item",
      body: `${actorName} added "${itemName}" to their wishlist.`,
      url: "/",
    });

    let notified = 0;
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth_key },
            },
            payload
          );
          notified += 1;
        } catch (err) {
          // 404/410 means the browser un-registered this subscription
          // (uninstalled, cleared site data, etc.) -- clean up the
          // now-dead row so this doesn't keep failing every time.
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {
            await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${sub.id}`, {
              method: "DELETE",
              headers: restHeaders,
            }).catch(() => {});
          }
        }
      })
    );

    res.status(200).json({ ok: true, notified });
  } catch (err) {
    res.status(500).json({ error: "Failed to send notifications: " + err.message });
  }
}
