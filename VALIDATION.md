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
pi --model 'concentrate/glm-5.2:high' 'reply exactly: ok'
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
- `POST /v1/responses`: production endpoint recommended by Concentrate
- integration overview: base url `https://api.concentrate.ai/v1`, bearer auth, model ids
