# Wecsord 5.0

Discord-like web chat with:
- Wecsord branding
- English-only nicknames (A-Z, 0-9, _)
- online users and profiles/avatars
- friend requests and friends list
- private group chats with friends
- text and voice channels
- WebRTC voice/video calls
- visible participant list inside calls
- microphone, camera and screen sharing
- Tenor GIF search and GIF messages (requires TENOR_API_KEY)

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000

## Tenor GIFs

Set these environment variables on the server/hosting platform:
- `TENOR_API_KEY` - your Tenor API key
- `TENOR_CLIENT_KEY` - optional client key, defaults to `wecsord`

The API key stays on the server; the browser calls `/api/gifs`.

## Important

The current data store is in memory. Users, friends, groups and messages reset when the server restarts. A database/authentication layer should be added before production use.

For internet WebRTC calls, HTTPS is required by browsers for camera/microphone access. A TURN server may be needed for some networks.
