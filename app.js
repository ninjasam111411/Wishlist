// ============================================================
// Wishlist — app logic.
// Real Supabase auth, groups, members, and wishlist items.
// (Theme/preferences/skeleton/drawer/modal UI below is unchanged
// from the original prototype; only the data layer is new.)
// ============================================================

const $ = (id) => document.getElementById(id);

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- App state ----------
let currentUser = null;         // { id, email, firstName, lastName }
let currentGroupId = null;      // uuid of the group currently open
let currentGroupName = "";
let currentGroupOwnerId = null; // uuid of the group's creator (owner)
let currentMembers = [];        // [{ user_id, nickname }]
let currentMemberId = null;     // whose wishlist is showing in group-screen

// The one account allowed to reset other people's passwords (see the
// Admin screen below) -- there's no email delivery reliable enough for
// self-serve "forgot password" on this project, so instead the family
// admin can just set someone's password directly from within the app.
// This client-side check only controls whether the Admin button/screen
// show up -- the actual enforcement happens server-side in the
// api/admin-* functions, which re-check the caller's token independently.
const ADMIN_EMAIL = "sam.matthew.starner@gmail.com";
function isAdmin() {
  return !!(currentUser && currentUser.email === ADMIN_EMAIL);
}

// The public half of the VAPID key pair used to sign push notifications.
// Safe to have here in the open -- like SUPABASE_ANON_KEY in config.js,
// it's designed to be public; the matching private key lives only in
// this project's Vercel environment variables, never in the browser.
const VAPID_PUBLIC_KEY =
  "BEnBVdOaCCun1iABZxTlL40m4G4r6VhoTtv4l0Ld2AADhhEk7WHKqenaq5xnWuY-eKQgQn2Js0yVC7peSAf0eRk";

// ============================================================
// Toast notifications -- a small in-app message that matches the rest
// of the design, used instead of the browser's plain alert() popup for
// errors and confirmations. Lives in a fixed, always-present container
// (see index.html) so it works no matter which screen/modal is open.
// ============================================================
function showToast(message, type) {
  const container = $("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast" + (type ? " toast-" + type : "");
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.textContent = message;
  container.appendChild(el);
  // Two rAFs so the browser commits the initial (pre-.show) state before
  // the class flips -- otherwise the transition sometimes gets skipped
  // and the toast just appears instantly instead of sliding/fading in.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));
  const remove = () => el.remove();
  setTimeout(() => {
    el.classList.remove("show");
    el.addEventListener("transitionend", remove, { once: true });
    setTimeout(remove, 400); // fallback in case the transition never fires (e.g. reduced-motion)
  }, 3800);
}

// ============================================================
// Confirm dialog -- a small modal that matches the rest of the design,
// used instead of the browser's plain confirm() popup for anything
// destructive (removing an item, leaving a group). Returns a Promise
// that resolves true/false, so call sites read almost the same as the
// old `if (!confirm(...)) return;` pattern, just with an `await`.
// ============================================================
let confirmResolve = null;
function confirmAction(message, opts) {
  opts = opts || {};
  $("confirm-modal-message").textContent = message;
  const confirmBtn = $("confirm-modal-confirm");
  confirmBtn.textContent = opts.confirmLabel || "Confirm";
  confirmBtn.className = "btn btn-small" + (opts.danger ? "" : " btn-primary");
  confirmBtn.style.background = opts.danger ? "var(--danger)" : "";
  confirmBtn.style.color = opts.danger ? "#fff" : "";
  $("confirm-backdrop").classList.remove("hidden");
  $("confirm-modal").classList.remove("hidden");
  // Default focus goes to Cancel, not the (often destructive) confirm
  // button -- so an accidental Enter/tap doesn't confirm something like
  // "remove this item" or "leave this group".
  $("confirm-modal-cancel").focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function closeConfirmModal(result) {
  $("confirm-backdrop").classList.add("hidden");
  $("confirm-modal").classList.add("hidden");
  if (confirmResolve) {
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve(result);
  }
}
$("confirm-modal-cancel").addEventListener("click", () => closeConfirmModal(false));
$("confirm-modal-confirm").addEventListener("click", () => closeConfirmModal(true));
$("confirm-backdrop").addEventListener("click", () => closeConfirmModal(false));

// ============================================================
// Button loading states -- disables a button and swaps in a small
// spinner while an async action runs, so a slow connection reads as
// "working" instead of "did my tap register at all?" (especially on
// phones, where this app mostly gets used).
// ============================================================
function setButtonLoading(btn, loading, loadingText) {
  if (!btn) return;
  if (loading) {
    if (btn.dataset.originalHtml === undefined) btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<span class="spinner"></span>${loadingText ? " " + escapeHtml(loadingText) : ""}`;
  } else {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    if (btn.dataset.originalHtml !== undefined) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml;
    }
  }
}
// A form's submit event carries the button that was actually pressed
// (e.submitter) in every current browser; this just falls back to the
// form's own submit button for anything that somehow doesn't set it.
function submitButtonFor(e) {
  return e.submitter || e.target.querySelector('button[type="submit"]');
}

// ---------- Theme: light / dark / system ----------
function applyTheme(choice) {
  if (choice === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", choice);
  }
  document.querySelectorAll("[data-theme-choice]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.themeChoice === choice);
  });
}
function setTheme(choice) {
  localStorage.setItem("wishlist-theme", choice);
  applyTheme(choice);
}
document.querySelectorAll("[data-theme-choice]").forEach(btn => {
  btn.addEventListener("click", () => setTheme(btn.dataset.themeChoice));
});
applyTheme(localStorage.getItem("wishlist-theme") || "system");

// ---------- Preferences: text size / compact view / confirm-before-remove ----------
const storedPrefs = JSON.parse(localStorage.getItem("wishlist-prefs") || "{}");
const prefs = Object.assign(
  { textSize: "normal", compactView: false, confirmRemove: true, notifyOnAdd: false },
  storedPrefs
);
// Back-compat: earlier versions stored a boolean "largeText" toggle instead
// of a "textSize" preset with several steps. Migrate it once so nobody's
// existing preference silently resets, then drop the old key for good.
if (!("textSize" in storedPrefs) && typeof storedPrefs.largeText === "boolean") {
  prefs.textSize = storedPrefs.largeText ? "large" : "normal";
}
delete prefs.largeText;
function applyPrefs() {
  document.documentElement.classList.remove("text-size-large", "text-size-xlarge", "text-size-huge");
  if (prefs.textSize && prefs.textSize !== "normal") {
    document.documentElement.classList.add("text-size-" + prefs.textSize);
  }
  document.documentElement.classList.toggle("compact-view", prefs.compactView);
}
function setPref(key, value) {
  prefs[key] = value;
  localStorage.setItem("wishlist-prefs", JSON.stringify(prefs));
  applyPrefs();
}
applyPrefs();

// ============================================================
// Push notifications -- the "Notify me when someone adds an item"
// switch in Settings. Two moving parts: this browser subscribing (via
// the Push API + our service worker, sw.js) so it CAN receive a push,
// and the app telling api/send-item-notification.js to actually send
// one after an item is added (see the add-item-submit handler below).
// ============================================================

// The Push API wants the VAPID public key as a raw byte array, not the
// base64url string it's written down as everywhere else.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

// Registered once, up front, so it's already active by the time someone
// turns the Settings switch on -- registering is cheap and idempotent
// (the browser no-ops if sw.js hasn't changed), unlike subscribing,
// which prompts for permission and should only happen on purpose.
let swRegistration = null;
async function registerServiceWorker() {
  if (!pushSupported()) return null;
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    return swRegistration;
  } catch (err) {
    // iOS Safari outside of an installed, Home-Screen app throws here --
    // that's expected (see maybeShowIosInstallBanner below), not a bug.
    return null;
  }
}
registerServiceWorker();

async function getExistingPushSubscription() {
  if (!pushSupported()) return null;
  const reg = swRegistration || (await navigator.serviceWorker.getRegistration());
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

// Turns the switch on: asks permission, subscribes this browser, and
// saves the subscription so the notify function can find it later.
// Returns true on success, false if anything stopped it (and reverts
// the checkbox + explains why via a toast).
async function enableNotifications(checkboxEl) {
  if (!pushSupported()) {
    showToast("Push notifications aren't supported in this browser.", "error");
    if (checkboxEl) checkboxEl.checked = false;
    return false;
  }

  try {
    const reg = swRegistration || (await registerServiceWorker());
    if (!reg) {
      showToast(
        "Notifications need this site added to your Home Screen first on iPhone (Share → Add to Home Screen), then try again from there.",
        "error"
      );
      if (checkboxEl) checkboxEl.checked = false;
      return false;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      showToast("Notifications are blocked -- you can allow them in your browser's site settings.", "error");
      if (checkboxEl) checkboxEl.checked = false;
      return false;
    }

    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const keys = subscription.toJSON().keys;
    const { error } = await sb.from("push_subscriptions").upsert(
      {
        user_id: currentUser.id,
        endpoint: subscription.endpoint,
        p256dh: keys.p256dh,
        auth_key: keys.auth,
      },
      { onConflict: "endpoint" }
    );
    if (error) {
      showToast("Couldn't save your notification settings: " + error.message, "error");
      if (checkboxEl) checkboxEl.checked = false;
      return false;
    }

    setPref("notifyOnAdd", true);
    showToast("You'll be notified when someone adds an item.");
    return true;
  } catch (err) {
    showToast("Couldn't turn on notifications: " + err.message, "error");
    if (checkboxEl) checkboxEl.checked = false;
    return false;
  }
}

// Turns the switch off: unsubscribes this browser and removes the saved
// subscription. Left quiet on failure (no error toast) -- worst case a
// stale subscription lingers server-side and gets cleaned up the next
// time a push to it bounces.
async function disableNotifications() {
  setPref("notifyOnAdd", false);
  try {
    const subscription = await getExistingPushSubscription();
    if (subscription) {
      await sb.from("push_subscriptions").delete().eq("endpoint", subscription.endpoint);
      await subscription.unsubscribe();
    }
  } catch (err) {
    // Nothing more useful to do here -- the pref is already off, which
    // is what the person asked for.
  }
}

// After someone adds an item, ask the server to notify their groupmates.
// Fire-and-forget: this never blocks or errors out the add-item flow
// itself, since the item is already saved by the time this runs.
async function notifyGroupOfNewItem(groupId, itemName) {
  try {
    const { data: sessionData } = await sb.auth.getSession();
    const token = sessionData && sessionData.session && sessionData.session.access_token;
    if (!token) return;
    await fetch("/api/send-item-notification", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ group_id: groupId, item_name: itemName }),
    });
  } catch (err) {
    // Best-effort -- the item itself is already added either way.
  }
}

// ---------- iPhone "add to Home Screen" nudge ----------
// On iOS, Safari only allows a website to receive push notifications
// once it's been added to the Home Screen and is running from there
// (not from an ordinary browser tab) -- that's an iOS restriction, not
// something this app can work around. This shows a small one-time tip
// explaining that, so "why doesn't the notifications switch work on my
// iPhone" has an answer nearby instead of just silently not working.
function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}
function maybeShowIosInstallBanner() {
  if (!isIos() || isStandalone()) return;
  if (localStorage.getItem("wishlist-ios-banner-dismissed")) return;
  if ($("ios-install-banner")) return; // already showing

  const banner = document.createElement("div");
  banner.id = "ios-install-banner";
  banner.className = "ios-install-banner";
  banner.innerHTML = `
    <span>📱 To get notifications on your iPhone, add Wishlist to your Home Screen first: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</span>
    <button type="button" aria-label="Dismiss">✕</button>
  `;
  banner.querySelector("button").addEventListener("click", () => {
    localStorage.setItem("wishlist-ios-banner-dismissed", "1");
    banner.remove();
  });
  document.body.appendChild(banner);
}

// ---------- Screen switching ----------
function goToScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
  // The drawer/settings/add-item overlays only make sense once you're
  // signed in and past the profile-completion gate -- close them on the
  // way to any other screen (start, auth, complete-profile).
  if (id !== "dashboard-screen" && id !== "group-screen" && id !== "admin-screen" && id !== "help-screen") {
    closeDrawer();
    $("settings-backdrop").classList.add("hidden");
    $("settings-modal").classList.add("hidden");
    $("add-item-backdrop").classList.add("hidden");
    $("add-item-modal").classList.add("hidden");
  }
}

// ---------- Escape key: close whatever overlay is currently open ----------
// Checked in front-to-back (topmost-first) order, since more than one
// can technically be open at once (e.g. the confirm dialog on top of
// settings) and Escape should only close the one on top.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("confirm-modal").classList.contains("hidden")) { closeConfirmModal(false); return; }
  if (!$("add-item-modal").classList.contains("hidden")) { closeAddItemModal(); return; }
  if (!$("settings-modal").classList.contains("hidden")) { closeSettingsModal(); return; }
  if ($("member-drawer").classList.contains("open")) { closeDrawer(); return; }
});

// ============================================================
// Auth screen (sign in / create account)
// ============================================================
function setAuthTab(tab) {
  document.querySelectorAll("#auth-tabs [data-auth-tab]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.authTab === tab);
  });
  $("signin-form").classList.toggle("hidden", tab !== "signin");
  $("signup-form").classList.toggle("hidden", tab !== "signup");
  $("auth-error").textContent = "";
}
document.querySelectorAll("#auth-tabs [data-auth-tab]").forEach(btn => {
  btn.addEventListener("click", () => setAuthTab(btn.dataset.authTab));
});

function openAuthScreen(tab) {
  goToScreen("auth-screen");
  setAuthTab(tab || "signin");
}
$("start-signin").addEventListener("click", () => openAuthScreen("signin"));
$("start-create").addEventListener("click", () => openAuthScreen("signup"));
$("auth-back").addEventListener("click", () => goToScreen("start-screen"));

$("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = submitButtonFor(e);
  const email = $("signin-email").value.trim();
  const password = $("signin-password").value;
  $("auth-error").textContent = "";
  setButtonLoading(btn, true, "Signing in…");
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      $("auth-error").textContent = error.message;
      return;
    }
    await onSignedIn(data.user);
  } finally {
    setButtonLoading(btn, false);
  }
});

$("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = submitButtonFor(e);
  const firstName = $("signup-first-name").value.trim();
  const lastName = $("signup-last-name").value.trim();
  const email = $("signup-email").value.trim();
  const password = $("signup-password").value;
  const confirm = $("signup-password-confirm").value;
  $("auth-error").textContent = "";
  if (!firstName || !lastName) {
    $("auth-error").textContent = "Enter your first and last name.";
    return;
  }
  if (password !== confirm) {
    $("auth-error").textContent = "Passwords don't match.";
    return;
  }
  setButtonLoading(btn, true, "Creating account…");
  try {
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { first_name: firstName, last_name: lastName } },
    });
    if (error) {
      $("auth-error").textContent = error.message;
      return;
    }
    if (data.user && !data.session) {
      // Email confirmation is turned on in this Supabase project.
      $("auth-error").style.color = "var(--evergreen)";
      $("auth-error").textContent = "Check your email to confirm your account, then sign in.";
      setAuthTab("signin");
      return;
    }
    await onSignedIn(data.user);
  } finally {
    setButtonLoading(btn, false);
  }
});

// Shows the signed-in account's name in the drawer (this replaced the
// old header name+"Log out" badge -- the drawer is now the one place
// that shows who you're signed in as).
function setAccountName(text) {
  $("drawer-account-name").textContent = text || "";
}

// Look up the signed-in user's name (for the drawer and defaults
// elsewhere) now that accounts have real first/last names.
async function loadCurrentUserProfile() {
  const { data } = await sb
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", currentUser.id)
    .maybeSingle();
  currentUser.firstName = data ? data.first_name : null;
  currentUser.lastName = data ? data.last_name : null;
  const fullName = [currentUser.firstName, currentUser.lastName].filter(Boolean).join(" ");
  setAccountName(fullName || currentUser.email);
  if ($("drawer-admin-btn")) {
    $("drawer-admin-btn").classList.toggle("hidden", !isAdmin());
  }
}

async function signOutEverywhere() {
  await sb.auth.signOut();
  currentUser = null;
  currentGroupId = null;
  goToScreen("start-screen");
}

// Any account missing a first/last name (made before named accounts
// existed, or added to a group by name without ever signing up itself)
// has to fill that in before it can use the rest of the app.
function hasCompleteProfile() {
  return !!(currentUser && currentUser.firstName && currentUser.lastName);
}

async function onSignedIn(user) {
  currentUser = { id: user.id, email: user.email };
  await loadCurrentUserProfile();
  if (!hasCompleteProfile()) {
    showCompleteProfileScreen();
    return;
  }
  await enterDashboard();
}

// Resume an existing session on page load (so people don't have to
// sign in again every visit), otherwise stay on the start screen.
(async () => {
  const { data } = await sb.auth.getSession();
  if (data.session && data.session.user) {
    currentUser = { id: data.session.user.id, email: data.session.user.email };
    await loadCurrentUserProfile();
    if (!hasCompleteProfile()) {
      showCompleteProfileScreen();
      return;
    }
    await enterDashboard();
  }
})();

// ---------- Complete-your-profile gate ----------
function showCompleteProfileScreen() {
  $("complete-profile-error").textContent = "";
  $("complete-profile-first-name").value = currentUser.firstName || "";
  $("complete-profile-last-name").value = currentUser.lastName || "";
  goToScreen("complete-profile-screen");
}

$("complete-profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = submitButtonFor(e);
  const firstName = $("complete-profile-first-name").value.trim();
  const lastName = $("complete-profile-last-name").value.trim();
  $("complete-profile-error").textContent = "";
  if (!firstName || !lastName) {
    $("complete-profile-error").textContent = "Enter your first and last name.";
    return;
  }
  setButtonLoading(btn, true, "Saving…");
  try {
    const { error } = await sb
      .from("profiles")
      .update({ first_name: firstName, last_name: lastName })
      .eq("id", currentUser.id);
    if (error) {
      $("complete-profile-error").textContent = "Couldn't save: " + error.message;
      return;
    }
    currentUser.firstName = firstName;
    currentUser.lastName = lastName;
    setAccountName([firstName, lastName].join(" "));
    await enterDashboard();
  } finally {
    setButtonLoading(btn, false);
  }
});

$("complete-profile-logout").addEventListener("click", signOutEverywhere);

// ============================================================
// Dashboard — your groups
// ============================================================
async function enterDashboard() {
  const grid = $("groups-grid");
  grid.innerHTML = skeletonGroupCards(3);
  await loadGroups();
  // Show the "How it works" tour automatically the first time this
  // browser ever reaches the dashboard, then never again on this device
  // (people can still reopen it anytime from the menu).
  if (!localStorage.getItem("wishlist-tutorial-seen")) {
    localStorage.setItem("wishlist-tutorial-seen", "1");
    goToScreen("help-screen");
  } else {
    goToScreen("dashboard-screen");
  }
  maybeShowIosInstallBanner();
}

async function loadGroups() {
  const grid = $("groups-grid");
  if (!currentUser) {
    grid.innerHTML = `<p class="empty-state">Sign in to see your real groups.</p>`;
    return;
  }

  const { data, error } = await sb
    .from("group_members")
    .select("nickname, groups ( id, name, invite_code, created_by )")
    .eq("user_id", currentUser.id);

  if (error) {
    grid.innerHTML = `<p class="empty-state">Couldn't load your groups: ${error.message}</p>`;
    return;
  }

  const groups = (data || []).map(row => row.groups).filter(Boolean);

  if (groups.length === 0) {
    grid.innerHTML = `<p class="empty-state">No groups yet — create one or join with an invite code above.</p>`;
    return;
  }

  grid.innerHTML = groups.map(g => `
    <div class="group-tag" data-group-id="${g.id}" data-group-name="${escapeHtml(g.name)}" data-invite-code="${g.invite_code}" data-owner-id="${g.created_by || ""}">
      <h3>${escapeHtml(g.name)}</h3>
      <div class="invite-code">Invite code: ${g.invite_code}</div>
    </div>
  `).join("");
  attachGroupCardHandlers();
}

function attachGroupCardHandlers() {
  document.querySelectorAll(".group-tag").forEach(card => {
    card.addEventListener("click", () => {
      openGroup(card.dataset.groupId, card.dataset.groupName, card.dataset.inviteCode, card.dataset.ownerId);
    });
  });
}

// "Create group" / "Join group" controls (the .new-group-row inputs/buttons in the dashboard)
const newGroupNameInput = document.querySelector('.new-group-row input[type="text"]');
const createGroupBtn = document.querySelector('.new-group-row .btn-primary');
const joinCodeInput = document.querySelectorAll('.new-group-row input[type="text"]')[1];
const joinGroupBtn = document.querySelector('.new-group-row .btn-gold');

if (createGroupBtn) {
  createGroupBtn.addEventListener("click", async () => {
    if (!currentUser) { showToast("Sign in first to create a group.", "error"); return; }
    const name = newGroupNameInput.value.trim();
    if (!name) { newGroupNameInput.focus(); return; }

    setButtonLoading(createGroupBtn, true, "Creating…");
    try {
      const { data: group, error } = await sb
        .from("groups")
        .insert({ name, created_by: currentUser.id })
        .select()
        .single();
      if (error) { showToast("Couldn't create group: " + error.message, "error"); return; }

      // No nickname override -- the display name falls back to the
      // member's real first/last name (set at sign-up).
      const { error: memberError } = await sb
        .from("group_members")
        .insert({ group_id: group.id, user_id: currentUser.id });
      if (memberError) { showToast("Group created, but couldn't add you to it: " + memberError.message, "error"); return; }

      newGroupNameInput.value = "";
      showToast(`"${name}" created.`, "success");
      await loadGroups();
    } finally {
      setButtonLoading(createGroupBtn, false);
    }
  });
  newGroupNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); createGroupBtn.click(); } });
}

if (joinGroupBtn) {
  joinGroupBtn.addEventListener("click", async () => {
    if (!currentUser) { showToast("Sign in first to join a group.", "error"); return; }
    const code = joinCodeInput.value.trim();
    if (!code) { joinCodeInput.focus(); return; }

    setButtonLoading(joinGroupBtn, true, "Joining…");
    try {
      const { data: group, error } = await sb
        .from("groups")
        .select("id, name")
        .eq("invite_code", code)
        .maybeSingle();
      if (error || !group) { showToast("No group found with that invite code.", "error"); return; }

      const { error: memberError } = await sb
        .from("group_members")
        .insert({ group_id: group.id, user_id: currentUser.id });
      if (memberError) { showToast("Couldn't join: " + memberError.message, "error"); return; }

      joinCodeInput.value = "";
      showToast(`Joined "${group.name}".`, "success");
      await loadGroups();
    } finally {
      setButtonLoading(joinGroupBtn, false);
    }
  });
  joinCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); joinGroupBtn.click(); } });
}

// ---------- Skeleton loaders ----------
function skeletonItemCards(count) {
  return Array.from({ length: count }).map(() => `
    <div class="skeleton-card">
      <div class="skeleton-block thumb"></div>
      <div class="skeleton-block line"></div>
      <div class="skeleton-block line short"></div>
      <div class="skeleton-block line tiny"></div>
    </div>
  `).join("");
}
function skeletonGroupCards(count) {
  return Array.from({ length: count }).map(() => `
    <div class="skeleton-group">
      <div class="skeleton-block line"></div>
      <div class="skeleton-block line tiny"></div>
    </div>
  `).join("");
}
// ============================================================
// Group screen — people list, then a person's wishlist
// ============================================================
function showMembersView() {
  $("group-members-view").classList.remove("hidden");
  $("group-wishlist-view").classList.add("hidden");
}
function showWishlistView() {
  $("group-members-view").classList.add("hidden");
  $("group-wishlist-view").classList.remove("hidden");
}

// Shows/hides the owner-only controls in the group screen (adding
// members by name, renaming the group, regenerating the invite code,
// and the danger zone) based on whether the signed-in user is the
// current owner of the open group. Called on entering a group, and
// again after a successful ownership transfer.
function updateGroupOwnerControlsVisibility() {
  const isOwner = !!(currentUser && currentGroupOwnerId === currentUser.id);
  $("owner-add-member").classList.toggle("hidden", !isOwner);
  $("owner-danger-zone").classList.toggle("hidden", !isOwner);
  $("group-rename-btn").classList.toggle("hidden", !isOwner);
  $("group-regen-invite-btn").classList.toggle("hidden", !isOwner);
  return isOwner;
}

async function openGroup(groupId, groupName, inviteCode, ownerId) {
  currentGroupId = groupId;
  currentGroupName = groupName;
  currentGroupOwnerId = ownerId || null;
  $("group-view-title").textContent = groupName;
  $("group-invite-code").textContent = inviteCode ? `Invite code: ${inviteCode}` : "";
  $("group-rename-row").classList.add("hidden");
  updateGroupOwnerControlsVisibility();
  $("member-search-input").value = "";
  $("member-search-results").innerHTML = "";
  goToScreen("group-screen");
  showMembersView();
  await loadMembers();
}

async function loadMembers() {
  const { data, error } = await sb
    .from("group_members")
    .select("user_id, nickname, profiles ( first_name, last_name, email )")
    .eq("group_id", currentGroupId);

  const list = $("member-list");
  if (error) {
    list.innerHTML = `<li class="empty-state">Couldn't load members: ${error.message}</li>`;
    return;
  }

  currentMembers = (data || []).map(row => {
    const p = row.profiles || {};
    const fullName = [p.first_name, p.last_name].filter(Boolean).join(" ");
    return {
      user_id: row.user_id,
      nickname: row.nickname || fullName || p.email || "Member",
    };
  }).sort((a, b) => a.nickname.localeCompare(b.nickname, undefined, { sensitivity: "base" }));

  // Owner-only per-member actions (make owner / remove) are rendered
  // next to every member row except the viewer's own -- transferring
  // ownership or removing yourself both have safer, dedicated flows
  // elsewhere (the danger zone, and "Leave this group" in Settings).
  const isOwnerViewing = !!(currentUser && currentGroupOwnerId === currentUser.id);

  list.innerHTML = currentMembers.map(m => {
    const isYou = m.user_id === currentUser.id;
    const isGroupOwner = m.user_id === currentGroupOwnerId;
    const tags = `${isYou ? ' <span class="you-tag">(you)</span>' : ""}${isGroupOwner ? ' <span class="you-tag">(owner)</span>' : ""}`;
    const ownerActions = (isOwnerViewing && !isYou) ? `
      <span class="member-owner-actions">
        <button type="button" class="btn-text btn-small" data-make-owner="${m.user_id}">Make owner</button>
        <button type="button" class="btn-text btn-small" data-remove-member="${m.user_id}" style="color:var(--danger);">Remove</button>
      </span>` : "";
    return `
    <li data-member="${m.user_id}">
      <span class="member-name">${escapeHtml(m.nickname)}${tags}</span>
      ${ownerActions}
    </li>
  `;
  }).join("");

  document.querySelectorAll("#member-list li").forEach(li => {
    li.addEventListener("click", () => selectMember(li.dataset.member));
  });

  document.querySelectorAll("#member-list [data-make-owner]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const targetId = btn.dataset.makeOwner;
      const member = currentMembers.find(m => m.user_id === targetId);
      const ok = await confirmAction(
        `Make ${member ? member.nickname : "this person"} the owner of this group? You'll no longer be the owner yourself.`,
        { confirmLabel: "Make owner", danger: true }
      );
      if (!ok) return;
      setButtonLoading(btn, true);
      try {
        const { error: transferError } = await sb.rpc("transfer_group_ownership", {
          target_group_id: currentGroupId,
          new_owner_id: targetId,
        });
        if (transferError) { showToast("Couldn't transfer ownership: " + transferError.message, "error"); return; }
        currentGroupOwnerId = targetId;
        updateGroupOwnerControlsVisibility();
        showToast("Ownership transferred.", "success");
        await loadMembers();
      } finally {
        setButtonLoading(btn, false);
      }
    });
  });

  document.querySelectorAll("#member-list [data-remove-member]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const targetId = btn.dataset.removeMember;
      const member = currentMembers.find(m => m.user_id === targetId);
      const ok = await confirmAction(
        `Remove ${member ? member.nickname : "this person"} from this group?`,
        { confirmLabel: "Remove", danger: true }
      );
      if (!ok) return;
      setButtonLoading(btn, true);
      try {
        const { error: removeError } = await sb.rpc("remove_group_member", {
          target_group_id: currentGroupId,
          target_user_id: targetId,
        });
        if (removeError) { showToast("Couldn't remove member: " + removeError.message, "error"); return; }
        showToast("Removed from group.", "success");
        await loadMembers();
      } finally {
        setButtonLoading(btn, false);
      }
    });
  });
}

function selectMember(memberUserId) {
  showWishlistView();
  loadWishlist(memberUserId);
}

$("back-to-members").addEventListener("click", showMembersView);

// ---------- Owner-assisted "add someone by name" ----------
if ($("member-search-btn")) {
  $("member-search-btn").addEventListener("click", searchMembersByName);
}
if ($("member-search-input")) {
  $("member-search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") searchMembersByName(); });
}

async function searchMembersByName() {
  const query = $("member-search-input").value.trim();
  const resultsList = $("member-search-results");
  if (!query) { resultsList.innerHTML = ""; return; }

  resultsList.innerHTML = `<li class="empty-state">Searching...</li>`;

  const { data, error } = await sb.rpc("search_profiles_by_name", { query });
  if (error) {
    resultsList.innerHTML = `<li class="empty-state">Couldn't search: ${error.message}</li>`;
    return;
  }

  const existingIds = new Set(currentMembers.map(m => m.user_id));
  const results = (data || []).filter(p => !existingIds.has(p.id));

  if (results.length === 0) {
    resultsList.innerHTML = `<li class="empty-state">No matches.</li>`;
    return;
  }

  resultsList.innerHTML = results.map(p => {
    const fullName = [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "Member";
    return `<li>${escapeHtml(fullName)} <button class="btn btn-ghost btn-small" data-add-id="${p.id}">Add</button></li>`;
  }).join("");

  resultsList.querySelectorAll("[data-add-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      setButtonLoading(btn, true);
      try {
        const { error: addError } = await sb.rpc("add_group_member_by_id", {
          target_group_id: currentGroupId,
          target_user_id: btn.dataset.addId,
        });
        if (addError) { showToast("Couldn't add: " + addError.message, "error"); return; }
        $("member-search-input").value = "";
        resultsList.innerHTML = "";
        await loadMembers();
      } finally {
        setButtonLoading(btn, false);
      }
    });
  });
}

async function loadWishlist(memberUserId) {
  currentMemberId = memberUserId;
  $("wishlist-items").innerHTML = skeletonItemCards(2);

  const member = currentMembers.find(m => m.user_id === memberUserId);
  $("wishlist-owner-heading").textContent =
    memberUserId === currentUser.id ? "Your wishlist" : `${member ? member.nickname : "Their"}'s wishlist`;

  // Read through wishlist_items_view (not the base table): it quietly
  // hides purchase status from the item's own owner, so the surprise
  // stays a surprise, while everyone else can see it.
  const { data, error } = await sb
    .from("wishlist_items_view")
    .select("*")
    .eq("group_id", currentGroupId)
    .eq("user_id", memberUserId)
    .order("created_at", { ascending: false });

  renderItems(memberUserId, error ? [] : (data || []), error);
}
function renderItems(memberUserId, items, error) {
  const container = $("wishlist-items");
  const isMine = memberUserId === currentUser.id;

  const addButtonHtml = isMine
    ? `<button class="btn btn-primary btn-small" id="inline-add-item-btn" style="margin-bottom:14px;">+ Add item</button>`
    : "";

  if (error) {
    container.innerHTML = `${addButtonHtml}<p class="empty-state">Couldn't load items: ${error.message}</p>`;
  } else if (items.length === 0) {
    container.innerHTML = `${addButtonHtml}<p class="empty-state">No items yet.</p>`;
  } else {
    container.innerHTML = addButtonHtml + items.map(item => {
      // Purchase status is only ever shown to people other than the
      // item's own owner -- wishlist_items_view already nulls these
      // fields out for the owner, but we gate on isMine too so the
      // surprise stays hidden even if that ever changes.
      let purchaseHtml = "";
      if (!isMine) {
        // Checked via purchased_at, not purchased_by: if the person who
        // bought it later deletes their account, purchased_by is cleared
        // (so nobody's credited for it anymore) but the item should
        // still show as bought, not flip back to "Mark as bought".
        if (item.purchased_at) {
          const isBuyer = item.purchased_by === currentUser.id;
          const buyerName = [item.purchased_by_first_name, item.purchased_by_last_name].filter(Boolean).join(" ");
          purchaseHtml = `
            <div class="item-actions">
              <span class="bought-tag">&#10003; Bought${isBuyer ? " by you" : (buyerName ? " by " + escapeHtml(buyerName) : "")}</span>
              ${isBuyer ? `<button class="btn btn-ghost btn-small" data-unmark-id="${item.id}">Undo</button>` : ""}
            </div>`;
        } else {
          purchaseHtml = `<div class="item-actions"><button class="btn btn-gold btn-small" data-mark-id="${item.id}">Mark as bought</button></div>`;
        }
      }

      return `
        <div class="item-tag" data-item-id="${item.id}">
          <img src="${item.image_url || placeholderImageFor(item.name)}" alt="${escapeHtml(item.name)}" />
          <h4>${escapeHtml(item.name)}</h4>
          ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
          ${item.link ? `<a href="${item.link}" target="_blank" rel="noopener">View item &rarr;</a>` : ""}
          ${isMine ? `<div class="item-actions"><button class="btn btn-ghost btn-small" data-remove-id="${item.id}">Remove</button></div>` : ""}
          ${purchaseHtml}
        </div>
      `;
    }).join("");
  }

  if (isMine) {
    const addBtn = $("inline-add-item-btn");
    if (addBtn) addBtn.addEventListener("click", openAddItemModal);
    container.querySelectorAll("[data-remove-id]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (prefs.confirmRemove) {
          const ok = await confirmAction("Remove this item from your wishlist?", { confirmLabel: "Remove", danger: true });
          if (!ok) return;
        }
        setButtonLoading(btn, true);
        try {
          const { error: delError } = await sb.from("wishlist_items").delete().eq("id", btn.dataset.removeId);
          if (delError) { showToast("Couldn't remove item: " + delError.message, "error"); return; }
          await loadWishlist(currentUser.id);
        } finally {
          setButtonLoading(btn, false);
        }
      });
    });
  } else {
    container.querySelectorAll("[data-mark-id]").forEach(btn => {
      btn.addEventListener("click", async () => {
        setButtonLoading(btn, true);
        try {
          const { error: markError } = await sb.rpc("mark_item_purchased", { target_item_id: btn.dataset.markId });
          if (markError) { showToast("Couldn't mark as bought: " + markError.message, "error"); return; }
          await loadWishlist(memberUserId);
        } finally {
          setButtonLoading(btn, false);
        }
      });
    });
    container.querySelectorAll("[data-unmark-id]").forEach(btn => {
      btn.addEventListener("click", async () => {
        setButtonLoading(btn, true);
        try {
          const { error: unmarkError } = await sb.rpc("unmark_item_purchased", { target_item_id: btn.dataset.unmarkId });
          if (unmarkError) { showToast("Couldn't undo: " + unmarkError.message, "error"); return; }
          await loadWishlist(memberUserId);
        } finally {
          setButtonLoading(btn, false);
        }
      });
    });
  }
}

function placeholderImageFor(name) {
  const initials = encodeURIComponent((name || "?").slice(0, 2).toUpperCase());
  return `https://placehold.co/300x300/D3EBFA/2F4A3D?text=${initials}`;
}
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

$("back-to-dashboard").addEventListener("click", async () => {
  goToScreen("dashboard-screen");
  await loadGroups();
});

// ---------- Owner-only group management: rename, regenerate invite code, delete ----------
if ($("group-rename-btn")) {
  $("group-rename-btn").addEventListener("click", () => {
    $("group-rename-input").value = currentGroupName || "";
    $("group-rename-row").classList.remove("hidden");
    $("group-rename-btn").classList.add("hidden");
    $("group-rename-input").focus();
  });
}
if ($("group-rename-cancel")) {
  $("group-rename-cancel").addEventListener("click", () => {
    $("group-rename-row").classList.add("hidden");
    $("group-rename-btn").classList.remove("hidden");
  });
}
if ($("group-rename-save")) {
  $("group-rename-save").addEventListener("click", async () => {
    const newName = $("group-rename-input").value.trim();
    if (!newName) { $("group-rename-input").focus(); return; }
    const btn = $("group-rename-save");
    setButtonLoading(btn, true);
    try {
      const { error } = await sb.from("groups").update({ name: newName }).eq("id", currentGroupId);
      if (error) { showToast("Couldn't rename group: " + error.message, "error"); return; }
      currentGroupName = newName;
      $("group-view-title").textContent = newName;
      $("group-rename-row").classList.add("hidden");
      $("group-rename-btn").classList.remove("hidden");
      showToast("Group renamed.", "success");
    } finally {
      setButtonLoading(btn, false);
    }
  });
}
if ($("group-rename-input")) {
  $("group-rename-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("group-rename-save").click();
    if (e.key === "Escape") $("group-rename-cancel").click();
  });
}

if ($("group-regen-invite-btn")) {
  $("group-regen-invite-btn").addEventListener("click", async () => {
    const ok = await confirmAction(
      "Generate a new invite code for this group? The old code will stop working right away.",
      { confirmLabel: "Regenerate", danger: true }
    );
    if (!ok) return;
    const btn = $("group-regen-invite-btn");
    setButtonLoading(btn, true);
    try {
      const { data, error } = await sb.rpc("regenerate_invite_code", { target_group_id: currentGroupId });
      if (error) { showToast("Couldn't regenerate the invite code: " + error.message, "error"); return; }
      $("group-invite-code").textContent = `Invite code: ${data}`;
      showToast("New invite code generated.", "success");
    } finally {
      setButtonLoading(btn, false);
    }
  });
}

if ($("delete-group-btn")) {
  $("delete-group-btn").addEventListener("click", async () => {
    const ok = await confirmAction(
      `Permanently delete "${currentGroupName}"? This removes the group and everyone's wishlist items in it. This can't be undone.`,
      { confirmLabel: "Delete group", danger: true }
    );
    if (!ok) return;
    const btn = $("delete-group-btn");
    setButtonLoading(btn, true);
    try {
      const { error } = await sb.from("groups").delete().eq("id", currentGroupId);
      if (error) { showToast("Couldn't delete the group: " + error.message, "error"); return; }
      showToast("Group deleted.", "success");
      goToScreen("dashboard-screen");
      await loadGroups();
    } finally {
      setButtonLoading(btn, false);
    }
  });
}

// ---------- Right-side account/menu drawer ----------
function openDrawer() {
  $("member-drawer").classList.add("open");
  $("drawer-backdrop").classList.remove("hidden");
  $("drawer-close").focus();
}
function closeDrawer() {
  $("member-drawer").classList.remove("open");
  $("drawer-backdrop").classList.add("hidden");
}
// The hamburger button is duplicated in each screen's own header (see
// index.html) rather than being one fixed overlay element, so every
// copy of it needs the same click handler.
document.querySelectorAll(".hamburger-btn").forEach(btn => {
  btn.addEventListener("click", openDrawer);
});
$("drawer-close").addEventListener("click", closeDrawer);
$("drawer-backdrop").addEventListener("click", closeDrawer);

$("drawer-settings-btn").addEventListener("click", () => {
  closeDrawer();
  openSettingsModal();
});

if ($("drawer-admin-btn")) {
  $("drawer-admin-btn").addEventListener("click", () => {
    closeDrawer();
    openAdminScreen();
  });
}
$("back-to-dashboard-from-admin").addEventListener("click", () => goToScreen("dashboard-screen"));

$("drawer-help-btn").addEventListener("click", () => {
  closeDrawer();
  openHelpScreen();
});
$("back-to-dashboard-from-help").addEventListener("click", () => goToScreen("dashboard-screen"));

function openHelpScreen() {
  goToScreen("help-screen");
}

// ---------- Admin: reset any account's password ----------
// Stands in for the old email-based "forgot password" flow, which this
// project's email delivery couldn't make reliable (see git history).
// Only visible/usable by ADMIN_EMAIL -- see isAdmin() above -- and the
// two api/admin-* serverless functions re-check that independently
// using the caller's own auth token, so this isn't just a client-side
// gate.
async function openAdminScreen() {
  goToScreen("admin-screen");
  $("admin-user-list").innerHTML = `<li class="empty-state">Loading accounts…</li>`;
  await loadAdminUsers();
}

async function loadAdminUsers() {
  const list = $("admin-user-list");
  try {
    const { data: sessionData } = await sb.auth.getSession();
    const token = sessionData && sessionData.session && sessionData.session.access_token;
    const res = await fetch("/api/admin-list-users", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      list.innerHTML = `<li class="empty-state">Couldn't load accounts: ${escapeHtml(result.error || "unknown error")}</li>`;
      return;
    }
    const users = result.users || [];
    if (users.length === 0) {
      list.innerHTML = `<li class="empty-state">No accounts found.</li>`;
      return;
    }
    list.innerHTML = users.map(u => {
      const fullName = [u.first_name, u.last_name].filter(Boolean).join(" ") || "(no name on file)";
      return `
        <li>
          <div class="admin-user-row">
            <div>
              <strong>${escapeHtml(fullName)}</strong>
              <div style="font-size:0.8rem; color:var(--evergreen-dark);">${escapeHtml(u.email || "")}</div>
            </div>
            <button class="btn btn-ghost btn-small" data-admin-reset-btn="${u.id}">Reset password</button>
          </div>
          <div class="admin-reset-form hidden" id="admin-reset-form-${u.id}"></div>
        </li>
      `;
    }).join("");

    list.querySelectorAll("[data-admin-reset-btn]").forEach(btn => {
      btn.addEventListener("click", () => showAdminResetForm(btn.dataset.adminResetBtn));
    });
  } catch (err) {
    list.innerHTML = `<li class="empty-state">Couldn't load accounts: ${escapeHtml(err.message)}</li>`;
  }
}

function showAdminResetForm(userId) {
  const container = $("admin-reset-form-" + userId);
  if (!container) return;
  const isOpen = !container.classList.contains("hidden");
  // Toggle: clicking "Reset password" again on an already-open row closes it.
  if (isOpen) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  container.classList.remove("hidden");
  container.innerHTML = `
    <div class="field">
      <label>New password</label>
      <input type="password" id="admin-reset-new-${userId}" minlength="6" autocomplete="new-password" />
    </div>
    <div class="field">
      <label>Confirm new password</label>
      <input type="password" id="admin-reset-confirm-${userId}" minlength="6" autocomplete="new-password" />
    </div>
    <p class="admin-reset-error" id="admin-reset-error-${userId}" role="alert"></p>
    <div style="display:flex; gap:8px;">
      <button class="btn btn-ghost btn-small" style="flex:1;" data-admin-cancel="${userId}">Cancel</button>
      <button class="btn btn-primary btn-small" style="flex:1;" data-admin-save="${userId}">Save new password</button>
    </div>
  `;
  container.querySelector(`[data-admin-cancel="${userId}"]`).addEventListener("click", () => {
    container.classList.add("hidden");
    container.innerHTML = "";
  });
  container.querySelector(`[data-admin-save="${userId}"]`).addEventListener("click", (e) => performAdminReset(userId, e.currentTarget));
}

async function performAdminReset(userId, btn) {
  const newPassword = $("admin-reset-new-" + userId).value;
  const confirm = $("admin-reset-confirm-" + userId).value;
  const errorEl = $("admin-reset-error-" + userId);
  errorEl.style.color = "var(--danger)";
  errorEl.textContent = "";
  if (newPassword.length < 6) {
    errorEl.textContent = "Password must be at least 6 characters.";
    return;
  }
  if (newPassword !== confirm) {
    errorEl.textContent = "Passwords don't match.";
    return;
  }

  setButtonLoading(btn, true, "Saving…");
  try {
    const { data: sessionData } = await sb.auth.getSession();
    const token = sessionData && sessionData.session && sessionData.session.access_token;
    const res = await fetch("/api/admin-reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ target_user_id: userId, new_password: newPassword }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorEl.textContent = "Couldn't update password: " + (result.error || "unknown error");
      return;
    }
    errorEl.style.color = "var(--evergreen)";
    errorEl.textContent = "Password updated.";
    showToast("Password updated.", "success");
  } catch (err) {
    errorEl.textContent = "Couldn't update password: " + err.message;
  } finally {
    setButtonLoading(btn, false);
  }
}

// ---------- Add-to-wishlist modal ----------
function openAddItemModal() {
  $("add-item-backdrop").classList.remove("hidden");
  $("add-item-modal").classList.remove("hidden");
  $("item-name-input").focus();
}
function closeAddItemModal() {
  $("add-item-backdrop").classList.add("hidden");
  $("add-item-modal").classList.add("hidden");
}
$("add-item-close").addEventListener("click", closeAddItemModal);
$("add-item-backdrop").addEventListener("click", closeAddItemModal);
$("add-item-submit").addEventListener("click", async () => {
  const name = $("item-name-input").value.trim();
  const link = $("item-link-input").value.trim();
  const ownDescription = $("item-description-input").value.trim();
  if (!name) { $("item-name-input").focus(); return; }

  let description = ownDescription;
  let image_url = null;

  setButtonLoading($("add-item-submit"), true, "Adding…");
  try {
    // Ask the /api/scrape serverless function for a photo + description
    // from the link, if one was given. The photo is always used when
    // available; the description from the scrape only fills in when the
    // person didn't type their own -- their own words always win.
    if (link) {
      try {
        const res = await fetch("/api/scrape", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: link }),
        });
        if (res.ok) {
          const scraped = await res.json();
          if (!description) description = scraped.description || "";
          image_url = scraped.image || null;
        }
      } catch (err) {
        // Scraper not available (e.g. running before this is deployed on Vercel) — that's fine.
      }
    }

    const { error } = await sb.from("wishlist_items").insert({
      group_id: currentGroupId,
      user_id: currentUser.id,
      name,
      description,
      link: link || null,
      image_url,
    });
    if (error) { showToast("Couldn't add item: " + error.message, "error"); return; }

    $("item-name-input").value = "";
    $("item-description-input").value = "";
    $("item-link-input").value = "";
    closeAddItemModal();
    showToast(`Added "${name}" to your wishlist.`, "success");
    await loadWishlist(currentUser.id);
    notifyGroupOfNewItem(currentGroupId, name);
  } finally {
    setButtonLoading($("add-item-submit"), false);
  }
});
$("item-name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("add-item-submit").click(); });
$("item-link-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("add-item-submit").click(); });
// ---------- Settings modal ----------
function skeletonSettingsRows() {
  const rowLabel = (text) => `<h4 style="font-size:0.78rem; text-transform:uppercase; letter-spacing:0.04em; color:var(--evergreen-dark); margin:0 0 8px;">${text}</h4>`;
  return `
    ${rowLabel("Theme")}
    <div class="skeleton-block line" style="height:38px; margin-bottom:18px;"></div>
    ${rowLabel("Your nickname in this group")}
    <div class="skeleton-block line" style="height:38px; margin-bottom:18px;"></div>
    ${rowLabel("Preferences")}
    <div class="skeleton-block line" style="height:38px; margin-bottom:8px;"></div>
    <div class="skeleton-block line" style="height:38px; margin-bottom:8px;"></div>
    <div class="skeleton-block line" style="height:38px; margin-bottom:18px;"></div>
    ${rowLabel("Notifications")}
    <div class="skeleton-block line" style="height:38px; margin-bottom:18px;"></div>
    ${rowLabel("Account")}
    <div class="skeleton-block line" style="height:38px; margin-bottom:8px;"></div>
    <div class="skeleton-block line" style="height:38px;"></div>
  `;
}

function renderSettingsContent() {
  const sectionLabel = (text, marginTop) => `<h4 style="font-size:0.78rem; text-transform:uppercase; letter-spacing:0.04em; color:var(--evergreen-dark); margin:${marginTop || 0}px 0 8px;">${text}</h4>`;
  const switchRow = (id, label, checked) => `
    <label class="settings-switch-row" style="margin-bottom:8px;">
      <span>${label}</span>
      <input type="checkbox" id="${id}" ${checked ? "checked" : ""} />
      <span class="switch-track"><span class="switch-thumb"></span></span>
    </label>`;

  const inGroup = !!currentGroupId;
  const me = currentMembers.find(m => m.user_id === (currentUser && currentUser.id));

  $("settings-modal-body").innerHTML = `
    ${sectionLabel("Theme")}
    <div class="theme-toggle" id="theme-toggle-modal">
      <button data-theme-choice="light">☀️ Light</button>
      <button data-theme-choice="dark">🌙 Dark</button>
      <button data-theme-choice="system">🖥️ System</button>
    </div>

    ${inGroup ? `
      ${sectionLabel("Your nickname in this group", 18)}
      <div class="nickname-editor">
        <input type="text" id="nickname-input" placeholder="Nickname in this group" value="${me ? escapeHtml(me.nickname) : ""}" />
        <button class="btn btn-ghost btn-small" id="nickname-save-btn">Save</button>
      </div>
    ` : ""}

    ${sectionLabel("Preferences", 18)}
    <div style="margin-bottom:12px;">
      <span style="display:block; font-size:0.9rem; margin-bottom:6px;">Text size</span>
      <div class="theme-toggle" id="text-size-choice">
        <button data-text-size="normal">Normal</button>
        <button data-text-size="large">Large</button>
        <button data-text-size="xlarge">XL</button>
        <button data-text-size="huge">Huge</button>
      </div>
    </div>
    ${switchRow("pref-compact-view", "Compact wishlist cards", prefs.compactView)}
    ${switchRow("pref-confirm-remove", "Confirm before removing an item", prefs.confirmRemove)}

    ${sectionLabel("Notifications", 18)}
    ${switchRow("notif-toggle", "Notify me when someone adds an item", prefs.notifyOnAdd)}

    ${sectionLabel("Account", 18)}
    <p style="font-size:0.85rem; margin:0 0 10px;">Signed in as <strong>${escapeHtml([currentUser.firstName, currentUser.lastName].filter(Boolean).join(" ") || currentUser.email)}</strong></p>
    <button class="btn btn-ghost btn-small" style="width:100%; margin-bottom:8px;" id="settings-logout-btn">Log out</button>
    ${inGroup ? `<button class="btn btn-ghost btn-small" style="width:100%; margin-bottom:8px; color:var(--danger); border-color:var(--danger);" id="settings-leave-group-btn">Leave this group</button>` : ""}

    <div id="delete-account-zone" style="margin-top:8px;"></div>

    <p style="text-align:center; font-size:0.75rem; color:var(--evergreen-dark); margin:18px 0 0;">Wishlist</p>
  `;

  document.querySelectorAll('#theme-toggle-modal [data-theme-choice]').forEach(btn => {
    btn.addEventListener("click", () => setTheme(btn.dataset.themeChoice));
  });
  applyTheme(localStorage.getItem("wishlist-theme") || "system");

  document.querySelectorAll('#text-size-choice [data-text-size]').forEach(btn => {
    btn.classList.toggle("active", btn.dataset.textSize === prefs.textSize);
    btn.addEventListener("click", () => {
      setPref("textSize", btn.dataset.textSize);
      document.querySelectorAll('#text-size-choice [data-text-size]').forEach(b => {
        b.classList.toggle("active", b.dataset.textSize === prefs.textSize);
      });
    });
  });

  $("pref-compact-view").addEventListener("change", (e) => setPref("compactView", e.target.checked));
  $("pref-confirm-remove").addEventListener("change", (e) => setPref("confirmRemove", e.target.checked));

  $("notif-toggle").addEventListener("change", async (e) => {
    const checkbox = e.target;
    if (checkbox.checked) {
      await enableNotifications(checkbox);
    } else {
      await disableNotifications();
    }
  });

  if (inGroup) {
    $("nickname-save-btn").addEventListener("click", async () => {
      const btn = $("nickname-save-btn");
      // Leaving this blank clears the override, so the display name
      // falls back to the member's real first/last name again.
      const nickname = $("nickname-input").value.trim() || null;
      setButtonLoading(btn, true);
      try {
        const { error } = await sb
          .from("group_members")
          .update({ nickname })
          .eq("group_id", currentGroupId)
          .eq("user_id", currentUser.id);
        if (error) { showToast("Couldn't save nickname: " + error.message, "error"); return; }
        showToast("Nickname saved.", "success");
        await loadMembers();
      } finally {
        setButtonLoading(btn, false);
      }
    });

    $("settings-leave-group-btn").addEventListener("click", async () => {
      if (currentGroupOwnerId === currentUser.id) {
        showToast("You're the owner of this group -- make someone else the owner, or delete the group, before leaving.", "error");
        return;
      }
      const ok = await confirmAction("Leave this group? You can rejoin later with the invite code.", { confirmLabel: "Leave group", danger: true });
      if (!ok) return;
      const btn = $("settings-leave-group-btn");
      setButtonLoading(btn, true, "Leaving…");
      try {
        const { error } = await sb
          .from("group_members")
          .delete()
          .eq("group_id", currentGroupId)
          .eq("user_id", currentUser.id);
        if (error) { showToast("Couldn't leave group: " + error.message, "error"); return; }
        closeSettingsModal();
        goToScreen("dashboard-screen");
        await loadGroups();
      } finally {
        setButtonLoading(btn, false);
      }
    });
  }

  $("settings-logout-btn").addEventListener("click", async () => {
    closeSettingsModal();
    await signOutEverywhere();
  });

  renderDeleteAccountInitial();
}

// ---------- Delete account (two-step confirmation, so no accidental
// deletes happen) ----------
function renderDeleteAccountInitial() {
  $("delete-account-zone").innerHTML = `
    <button class="btn btn-ghost btn-small" style="width:100%; color:var(--danger); border-color:var(--danger);" id="delete-account-btn">Delete account</button>
  `;
  $("delete-account-btn").addEventListener("click", renderDeleteAccountConfirm);
}

function renderDeleteAccountConfirm() {
  $("delete-account-zone").innerHTML = `
    <p style="font-size:0.8rem; color:var(--danger); margin:0 0 10px;">This permanently deletes your account: your wishlist items, and your membership in every group. Groups you created stay for everyone else, but you won't be part of them anymore. This can't be undone.</p>
    <div style="display:flex; gap:8px;">
      <button class="btn btn-ghost btn-small" style="flex:1;" id="delete-account-cancel">Cancel</button>
      <button class="btn btn-small" style="flex:1; background:var(--danger); color:#fff;" id="delete-account-confirm">Yes, delete my account</button>
    </div>
  `;
  $("delete-account-cancel").addEventListener("click", renderDeleteAccountInitial);
  $("delete-account-confirm").addEventListener("click", performAccountDeletion);
}

async function performAccountDeletion() {
  $("delete-account-zone").innerHTML = `<p style="font-size:0.85rem;"><span class="spinner"></span> Deleting your account…</p>`;
  try {
    const { data: sessionData } = await sb.auth.getSession();
    const token = sessionData && sessionData.session && sessionData.session.access_token;
    if (!token) {
      showToast("Your session has expired -- please sign in again before deleting your account.", "error");
      renderDeleteAccountInitial();
      return;
    }

    const res = await fetch("/api/delete-account", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
    const result = await res.json().catch(() => ({}));

    if (!res.ok) {
      showToast("Couldn't delete your account: " + (result.error || "unknown error"), "error");
      renderDeleteAccountInitial();
      return;
    }

    closeSettingsModal();
    await sb.auth.signOut();
    currentUser = null;
    currentGroupId = null;
    goToScreen("start-screen");
    showToast("Your account has been deleted.", "success");
  } catch (err) {
    showToast("Couldn't delete your account: " + err.message, "error");
    renderDeleteAccountInitial();
  }
}

function openSettingsModal() {
  $("settings-backdrop").classList.remove("hidden");
  $("settings-modal").classList.remove("hidden");
  $("settings-modal-body").innerHTML = skeletonSettingsRows();
  $("settings-close").focus();
  setTimeout(renderSettingsContent, 300);
}
function closeSettingsModal() {
  $("settings-backdrop").classList.add("hidden");
  $("settings-modal").classList.add("hidden");
}
$("settings-close").addEventListener("click", closeSettingsModal);
$("settings-backdrop").addEventListener("click", closeSettingsModal);
