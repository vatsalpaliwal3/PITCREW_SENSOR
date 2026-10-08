# sensor-app

Phone bump detector for the Road-Repair Prioritizer (constitution section 11). A static web page: it reads the
accelerometer and GPS on the phone, detects bumps on-device, and posts `SensorEvent`s to
`POST /v1/sensor-events` (offline queue flushes through `/v1/sensor-events/batch`).

## Deploy on Vercel (3 minutes)

1. Put this folder in the repo as `sensor-app/` (or make it its own repo).
2. Vercel -> **Add New Project** -> import the repo. **Root Directory = `sensor-app`**. Framework preset: Other
   (`vercel.json` already sets the build command and output directory).
3. **Environment Variables** (Production and Preview):
   | Name | Value |
   |---|---|
   | `API_BASE_URL` | your backend HTTPS URL, no trailing slash, no `/v1` |
   | `SENSOR_KEY` | same value as `SENSOR_API_KEY` on Render (optional; can be typed in the app instead) |
4. Deploy. Open the Vercel URL **on your phone**.
5. **CORS (required):** copy the page's exact origin (Settings -> "This page's origin", e.g. `https://<project>.vercel.app`)
   and add it to `ALLOWED_ORIGINS` on Render, then redeploy/restart the backend. The origin must match exactly:
   `https` scheme, no trailing slash. The Vercel regex in the constitution only covers the frontend project.
6. The pill at the top turns green ("Online · v1.1.0") when everything is connected.

No CLI? Deploy from this folder with `npx vercel --prod` and add the two variables with `npx vercel env add`.

## Using it

- **Start detecting** (grant motion and location permission). Keep the screen on; a screen wake lock is requested.
- **Demo mode** (default ON) sends bumps even when you are not moving, so you can shake the phone on stage. Turn it
  off for real drives: bumps below 5 km/h are then ignored.
- **Send test event** posts one synthetic bump at your current GPS position (needs a GPS fix inside a ward, or the server
  answers `OUTSIDE_SERVICE_AREA`).
- **Replay drive** runs the same detector over `replay_drive.csv` and posts the result through the batch endpoint.
  Replay IDs are deterministic, so running it twice is harmless (second run reports "already known").
  The bundled file is **synthetic** and located near the example ward center; use **Use my CSV...** for
  `contracts/fixtures/replay_drive.csv` (columns `recorded_at,lat,lng,x,y,z,speed_kmh`).
- Offline: events are queued (persisted) and flushed automatically every 10 s or via **Flush queue**.

## Detection (matches constitution 4.2 / 5.4)

`peak_z_deviation = abs(z - 9.81)` where z is the vertical acceleration including gravity. "Any orientation" mode
projects the reading on the gravity direction (identical to raw Z when the phone lies flat), so a phone upright in a
holder does not fire constantly. "Lying flat" uses the raw Z axis. An event is sent only when the deviation is
`>= MIN_PEAK_Z_DEVIATION` (read from `/v1/config`, default 3.0), with a 1.5 s cooldown. The sent payload is exactly
the 8 contract fields.

## Local checks

```
npm test                # 37 tests: detector, payload, CSV, sender/queue vs a mock backend, build script
npm run check:urls      # constitution 12.1: no URL literals in source
npm run build           # writes dist/ (reads API_BASE_URL, SENSOR_KEY)
node scripts/serve.mjs dist 4173   # serves dist/ with the same security headers as Vercel
```

## Constitution notes

- `SENSOR_APP_STACK = static web page (vanilla JS ES modules, no dependencies), hosted on Vercel, root dir sensor-app`
- `PRIOR_WORK_POLICY`: the old detector is not reused; everything here is new, so no "reused module" disclosure is needed.
- Clarification worth a `contract-change` PR: 4.2 says `abs(z - 9.81)`; this app computes it on the vertical axis
  (see above). The server only receives the number.
- The sensor key shipped in a browser is not a secret (section 11). Real protection is server-side validation and rate limits.
- Web limitation (say it in the pitch): the page must stay open with the screen on; a native build could run as a
  background service.
