# validation

commands run during package creation:

```bash
pi -e /Users/lucifer/Documents/Lucifer/projects/pi-concentrate-provider --list-models \
  | awk 'BEGIN{IGNORECASE=1} /concentrate|glm-5\\.2/ {print}'
```

confirmed:

```text
concentrate   glm-5.2   1.0M   256K   yes   no
```

live model call:

```bash
pi -e /Users/lucifer/Documents/Lucifer/projects/pi-concentrate-provider --model 'concentrate/glm-5.2:low' --no-session 'reply exactly: ok'
```

confirmed:

```text
ok
```

pi docs used:

- `docs/packages.md`: package install and `pi` manifest
- `docs/custom-provider.md`: `pi.registerProvider`, dynamic providers, API types
- `docs/extensions.md`: provider registration and `pi.setModel`
- `docs/providers.md`: `/login` API-key flow and auth storage behavior

concentrate docs used:

- `GET /v1/models`: public model catalog; no auth required
- `POST /v1/chat/completions`: OpenAI-compatible client endpoint used by pi
- `POST /v1/responses`: raw API endpoint; useful for direct curl checks
- integration overview: base url `https://api.concentrate.ai/v1`, bearer auth, model ids
