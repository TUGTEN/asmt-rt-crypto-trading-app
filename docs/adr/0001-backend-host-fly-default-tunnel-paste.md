# Backend host: Fly.io default, NixOS quick tunnel as runtime paste

Fly.io serves the canonical public API (stable WSS for the Vercel UI and the recording); the NixOS box exposes only the API port via `cloudflared tunnel --url http://localhost:8080`, and its random `trycloudflare.com` URL is pasted at runtime through the existing Backend panel, never baked as a build default.
