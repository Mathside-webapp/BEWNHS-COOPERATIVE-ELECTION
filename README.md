# BEWNHS Cooperative Election — Shared PIN edition

## Try the updated website
1. Extract this ZIP into a new folder and open `index.html`.
2. Click **CAST VOTE**. Demo PIN: **202610**.
3. Select your name from the eligible teachers who have not voted.
4. Choose 5 Board and 3 Audit candidates using the bottom Next / Back controls, then submit and confirm.
5. Open **Admin Portal → Voters & access** to inspect voting status, submission time, configure the PIN, and reset disputed votes.

The demo has 23 teachers and 18 fictional preloaded ballots. Only the remaining five names appear initially. Reset a sample vote to make that teacher available again. Demo changes are local to your browser; they are not real election records and do not synchronize across devices.

## New live installation
1. Run `supabase/schema.sql` in Supabase SQL Editor. It includes the shared-PIN upgrade, roster, tables and transaction functions. Members start ineligible; approve them in the admin panel.
2. Create your administrator through Supabase Auth and grant access:
   `insert into public.admin_users(user_id) select id from auth.users where email='YOUR_ADMIN_EMAIL';`
3. Set the Edge Function secret `RATE_LIMIT_SALT` to a random string of at least 24 characters.
4. Deploy the included function: `supabase functions deploy election-api --no-verify-jwt`.
5. Put the project URL and public anon key into `js/site-config.js`. Never put the service role key, election PIN or administrator password into frontend configuration.
6. Host the folder on an HTTPS host, such as your GitHub Pages site.
7. Sign in to Admin Portal. Approve eligible teachers, assign candidates, and use **Voters & access → Set shared PIN** to choose 6–12 digits. Share the PIN with eligible teachers.
8. Set election status to Open when ready. Test first in a separate project.

## Upgrade an existing installation
1. Back up your database.
2. Run **`supabase/shared-pin-upgrade.sql`** once in the existing project's SQL Editor. Do not delete existing tables or ballots.
3. Redeploy **`supabase/functions/election-api/index.ts`** using the command above.
4. Replace the website files, retaining your existing `js/site-config.js` connection values.
5. Set your shared PIN in Voters & access. No default PIN exists for the live election.

Old individual-code submissions remain counted and their voters remain blocked. Because those old ballots were anonymous, they cannot be connected retrospectively to a teacher and cannot be individually reset. The admin panel labels them **Legacy ballot — cannot reset**. New shared-PIN submissions support the reset process below. The old code-based voting endpoint is disabled by this upgrade.

## What a vote reset does
- Admin selects the teacher and clicks **Reset vote**.
- A confirmation dialog requires a reason of 5–1000 characters.
- One database transaction removes that teacher's previous ballot and its selections from totals, clears their participation, invalidates their previous entry, and logs the admin ID, teacher ID, reason and time.
- The name becomes available again when the entry list is loaded or refreshed.
- Old open ballots are rejected after a reset; the teacher must enter again.
- Tie decisions are cleared because their totals may have changed.
- Resetting a closed election moves it to Paused; the administrator must deliberately reopen it. Certified elections cannot be reset.

The Voter Management panel shows all names, eligibility, voting status and submission time in Philippine time. It never returns individual candidate selections or ballot IDs. The reset history shows the administrator's account ID.

## Privacy and trust model
The shared PIN is stored hashed, checked on the server, and required to fetch the entry list and submit. It is not identity verification: a person who knows the PIN can choose another available teacher's name. This is the trust-based approach requested for this election.

New ballots are internally linked to members in a restricted participation table so the correct disputed vote can be removed. Candidate choices are hidden from the admin website, but an operator with privileged database access can technically join that link to the ballot. This edition does not promise unlinkable secret ballots.

Database transactions lock the member record to prevent simultaneous duplicate submissions. A stale voter list does not allow a second ballot. No browser has direct access to participation records or ballots through Supabase table APIs.

## Interface
The homepage has the requested logo/label cleanup. Preparation and submission animations remain. Only the bottom navigation controls are shown; the redundant committee tabs and inline Continue button were removed. The ballot uses the burgundy-and-gold design.

## Source files
- `js/app.bundle.js`: ready-to-open browser bundle
- `js/app.js`, `js/demo.js`, `js/api.js`: editable sources
- `node build-offline.cjs`: rebuild after source edits
- `supabase/schema.sql`: full new-project setup
- `supabase/shared-pin-upgrade.sql`: existing-project upgrade
- `supabase/functions/election-api/index.ts`: server API

Local demo checks cover PIN entry/rotation, name selection, submission, hidden voted names, duplicate rejection, reset confirmation/reason, tally count correction, reset log, restored name and stale-entry rejection. Live Supabase deployment and database concurrency must be verified against your project; no live deployment was performed in this update.

## Interface refinement
The success screen no longer shows the demonstration confirmation reference. PIN inputs show the typed digits by default, with a Hide / Show control. Voting identity is a simple text line. The Select / Review / Complete tracker appears in the bottom bar instead of Board / Audit counts. Candidate counts remain above each candidate list.

Admins can add members after voting starts: add the teacher under Voters & access, enable eligibility, then nominate them under Candidates. Existing nominations cannot be removed once ballots exist. Closed/certified elections reject additions. Earlier submitted ballots are not changed when a nominee is added. For existing shared-PIN installations, redeploy the updated Edge Function and replace frontend files; this refinement requires no new SQL migration.

## Always-visible administrator PIN
The Voters & access panel displays the current saved PIN and pre-fills the change field. The display updates after saving and persists across reloads. Only authenticated election administrators receive the saved PIN from the backend. The voter interface still requires PIN entry and cannot fetch the saved PIN.

For an existing shared-PIN installation, run `supabase/admin-pin-display-upgrade.sql`, redeploy the Edge Function, and replace frontend files. A previous PIN stored only as a hash cannot be recovered for display; it remains valid for voting, but an admin must save that PIN (or a new PIN) once. New installations using the included full schema already contain this upgrade.

To support retrieval, the PIN is now also stored in a restricted database field accessible to the service role and privileged database operators. It is excluded from public snapshots and audit logs.


## Candidate and voter separation update

- Under **Candidates**, add a candidate and choose Board, Audit, or Both. This does **not** give voting rights.
- Under **Voters & access**, add a voter. This does **not** nominate the person.
- Adding the same name under the other role updates the existing person rather than creating a second entry.
- Under **Results & rankings**, after closing voting, choose **Download PNG** for a printable image with candidate rankings and vote counts.
- **Existing Supabase projects:** run `supabase/candidate-voter-separation-upgrade.sql` in the SQL Editor and redeploy `supabase/functions/election-api/index.ts`. This is essential: the old ballot validation rejects candidate-only nominees.
- **New Supabase projects:** `supabase/schema.sql` already includes the updated candidate validation.
