# Ocarina

Ocarina is the frontend for shared Spotify listening rooms. The Ocean backend owns authentication, Spotify access, room state, and social data; the browser communicates with it over REST and Socket.IO.

## Features

- Spotify sign-in creates a room automatically when an active Spotify device is available. Otherwise, sign-in opens the friends dashboard.
- Guests can join an active room with a name and room code without a Spotify account.
- Discover friends' live rooms, see the current track and recent listening context, send quick drops, and accept friend requests.
- Search Spotify from a room, contribute tracks, vote, and see a fair-turn queue. Hosts can lock queue positions.
- Send two-song chains, review played/queued drops and echo feedback, and leave post-session notes.
- Revisit unplayed recommendations from the 48-hour backlog.

## Local setup

For local Spotify OAuth, register `http://127.0.0.1:5000/auth/callback` in the Spotify app. Start Vite and Ocean, then open Ocarina at `http://127.0.0.1:5173` (not `localhost`): Spotify requires an explicit loopback IP, and the session cookie must stay on the same host. Ocean's local `FRONTEND_URL` should be `http://127.0.0.1:5173`. Set `VITE_BACKEND_URL` in `.env.local` only if Ocean is hosted separately; by default the frontend uses its own hostname on port 5000. No Supabase credentials or Spotify secrets belong in the frontend.

Run Ocarina from this folder:

```bash
npm install
npm run dev
```

Run Ocean separately from `../Ocean`:

```bash
npm install
node server.js
```

Configure Ocean's `FRONTEND_URL` to match the Ocarina origin so credentialed API and Socket.IO requests can use the `ocarina_session` cookie. Set `SPOTIFY_REDIRECT_URI` to the exact registered redirect URI in `Ocean/.env`. Keep the frontend, callback, and API on the same hostname so the browser sends the session cookie after OAuth. Ocean also requires a private `JWT_SECRET` in `Ocean/.env` to sign browser sessions; keep it out of source control and use a strong random value.

For an existing database, run `../SQL/ocean_backend_migration.sql` in the Supabase SQL editor. The original `ini.sql` and `initiation.sql` describe the earlier Supabase-auth backend and do not create Ocean's `spotify_tokens` or `backlogs` tables or all of Ocean's room/drop columns. Run the read-only backend checks from `../Ocean` with `npm run validate`; they check required environment variables, Supabase DNS and schema, Spotify API access, OAuth redirect configuration, backend health, and credentialed CORS. This does not perform Spotify browser consent or create a room; complete those once from the browser after the validator passes. Ocean accesses Supabase and Spotify server-side.

## Playback and rooms

Spotify's active device is the source of playback. The Ocean backend synchronizes playback and room presence, while Socket.IO broadcasts queue changes, votes, lock state, recent plays, echoes, and room closure. A second Ocarina device can observe and contribute to a room, but does not create a second Spotify playback stream.
# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
