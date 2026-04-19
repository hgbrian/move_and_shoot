# Move and Shoot

Barebones browser prototype for the multiplayer game spec we locked down:

- online room-code play
- 3 rounds
- free-for-all battle royale scoring
- 10 second planning turns
- 2 second simultaneous movement
- post-move simultaneous bullets
- line-of-sight hiding during planning
- random 2x2-screen maps with rotated rectangle buildings

## Run

```bash
npm start
```

Then open `http://localhost:3000` on two or more devices or browser windows.

## Notes

- The server is authoritative and keeps room state in memory.
- The prototype uses plain Node HTTP endpoints plus polling, so there are no external dependencies.
- Room codes are 4-character uppercase codes.
- Joining mid-match is blocked in v1.

## Main Files

- `server.js`: room management, match state, map generation, planning, movement, and shooting resolution.
- `public/client.js`: canvas rendering, camera, planning input, lobby flow, and simple sound effects.
- `public/styles.css`: HUD and menu styling.

## Deploy

The easiest deployment path is a plain Node host like Render, Fly.io, Railway, or your own VPS.

### Render / Railway style deployment

1. Push this folder to a Git repo.
2. Create a new Node web service.
3. Set the start command to:

```bash
npm start
```

4. Set the Node version if your host asks for it.
5. Deploy.

This app listens on `process.env.PORT`, so it should work on typical Node hosts without code changes.

### Simple VPS deployment

1. Copy the project to the server.
2. Install Node.js.
3. Run:

```bash
npm start
```

4. Put Nginx or Caddy in front of it as a reverse proxy.
5. Keep it alive with `pm2`, `systemd`, or Docker.

### Important v1 limitation

Everything is currently stored in memory on one server process:

- rooms disappear if the server restarts
- there is no database
- there is no cross-server room sharing

That is fine for a prototype, but if you want real deployment next, the next step would be persistent rooms plus websocket networking.
