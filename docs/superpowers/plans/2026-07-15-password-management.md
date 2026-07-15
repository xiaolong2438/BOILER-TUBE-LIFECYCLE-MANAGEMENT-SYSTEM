# Password Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add self-service password changes and admin password resets to the boiler-tube lifecycle system.

**Architecture:** Store an explicit `role` on each user, expose that role through the auth session API, and add two small JSON endpoints: one for a logged-in user to change their own password after confirming the old password, and one for an admin to reset any user's password. Keep the UI in the existing main page by adding a compact modal with two tabs so the feature stays close to the current login/logout controls.

**Tech Stack:** Cloudflare Pages Functions, D1, vanilla HTML/CSS/JS, PBKDF2 password hashing in Python for seeding and Web Crypto for login/runtime hashing.

---

### Task 1: Make auth data role-aware

**Files:**
- Modify: `migrations/0001_init.sql`
- Modify: `scripts/hash_password_sql.py`
- Modify: `functions/api/auth/login.js`
- Modify: `functions/api/auth/session.js`

- [ ] **Step 1: Update the schema and auth contract**

Add a `role TEXT NOT NULL DEFAULT 'user'` column to `users`, keep `username` as the primary key, and have login/session responses include `role` so the UI can tell whether the signed-in user is an admin.

```sql
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user',
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Make the seed script accept the same username/password inputs as today, but insert `role = 'admin'` for the seeded operator account:

```sql
INSERT INTO users (username, role, password_hash, salt, iterations, updated_at) ...
```

- [ ] **Step 2: Verify the auth contract is stable**

Run:

```bash
python -m py_compile scripts/hash_password_sql.py
```

Expected: exit code `0`.

Also confirm the login/session JSON now includes a `role` field for authenticated users.

---

### Task 2: Add password-change APIs

**Files:**
- Create: `functions/api/auth/password.js`
- Create: `functions/api/admin/users/[username]/password.js`
- Modify: `functions/api/auth/login.js`
- Modify: `functions/_middleware.js` only if a new route needs explicit allowance

- [ ] **Step 1: Add self-service password change**

Create a `/api/auth/password` POST endpoint that:

```js
{
  currentPassword: string,
  newPassword: string,
  confirmPassword: string
}
```

It must:
- require an active session
- verify `currentPassword`
- require `newPassword === confirmPassword`
- reject short passwords
- update the current user’s hash and salt
- delete that user’s sessions so they must sign in again

- [ ] **Step 2: Add admin reset**

Create a `/api/admin/users/:username/password` POST endpoint that:

```js
{
  newPassword: string,
  confirmPassword: string
}
```

It must:
- require an active session
- require `role === 'admin'`
- reject unknown target users
- update the target user’s hash and salt
- clear the target user’s sessions

Use the same PBKDF2 hash helper in both endpoints so the login hash format stays identical.

- [ ] **Step 3: Verify the API shape**

Run a quick local syntax check:

```bash
python -m py_compile scripts/hash_password_sql.py
```

Then exercise each endpoint once in preview or deployed mode with a valid session and confirm:
- self-change succeeds with the correct old password
- admin reset succeeds for another user
- non-admin reset returns `403`

---

### Task 3: Add the in-page password manager

**Files:**
- Modify: `炉管全生命周期管理系统.html`

- [ ] **Step 1: Add the trigger and modal**

Add a small `密码管理` button beside the current logout control. The modal should contain two tabs:

```html
<!-- Tab 1 -->
<form id="change-password-form">
  <input name="currentPassword" type="password" />
  <input name="newPassword" type="password" />
  <input name="confirmPassword" type="password" />
</form>

<!-- Tab 2, admin only -->
<form id="reset-password-form">
  <input name="targetUsername" />
  <input name="newPassword" type="password" />
  <input name="confirmPassword" type="password" />
</form>
```

The admin tab should only appear when the current session role is `admin`.

- [ ] **Step 2: Wire the client-side actions**

Add handlers that POST to:
- `/api/auth/password`
- `/api/admin/users/<username>/password`

On success:
- show a short success message
- clear the forms
- force a logout so the user signs in again with the new password

On failure:
- show the server’s message inline in the modal

- [ ] **Step 3: Keep the UI aligned with the current page**

Reuse the existing dark industrial styling, keep the modal compact, and avoid adding a new page or separate navigation layer.

---

### Task 4: Verify end to end

**Files:**
- No new files; verify the modified ones above

- [ ] **Step 1: Run syntax checks**

```bash
python -m py_compile scripts/hash_password_sql.py
```

Expected: exit code `0`.

- [ ] **Step 2: Run a live auth check**

Deploy or preview the updated app, then verify:
- admin can open the password manager
- self-service password change works
- admin reset works for another account
- old credentials stop working after reset

- [ ] **Step 3: Record the outcome**

If everything passes, stage the touched files and keep the plan doc for reference alongside the implementation.
