# pi-concentrate-provider

Concentrate AI provider package for pi.

It makes Concentrate appear as a first-class pi provider:

- `/login` → `Use an API key` → `Concentrate`
- `/model` → `concentrate/<model-id>`
- `/scoped-models` can enable/disable Concentrate models for `ctrl+p` cycling
- `/glm52` switches straight to `concentrate/glm-5.2`

## install

local dev:

```bash
pi install /absolute/path/to/pi-concentrate-provider
```

git install after publishing:

```bash
pi install https://github.com/<owner>/pi-concentrate-provider
```

then restart pi or run:

```text
/reload
```

## login flow

inside pi:

```text
/login
```

choose:

```text
Use an API key → Concentrate
```

paste your Concentrate key. pi stores it in `~/.pi/agent/auth.json` under the `concentrate` provider id.

## model flow

```text
/model glm-5.2
```

or:

```text
/glm52
```

full model reference:

```text
concentrate/glm-5.2
```

## how it works

The extension registers a custom pi provider using `pi.registerProvider()`:

- provider id: `concentrate`
- display name: `Concentrate`
- base url: `https://api.concentrate.ai/v1`
- api: `openai-responses`
- api key: `$CONCENTRATE_API_KEY` fallback, with `/login` auth taking priority

The model catalog is loaded from Concentrate's public endpoint:

```text
GET https://api.concentrate.ai/v1/models
```

That endpoint does not require auth, so the provider can appear in `/login` before a key is configured. Models only appear in `/model` after auth exists, matching pi's normal provider behavior.

## commands

```text
/concentrate status
/concentrate refresh
/glm52
```

`/concentrate refresh` forces a catalog refresh. a 24h cache is stored under pi's agent cache directory.

## notes

Concentrate's docs recommend the Responses API for production. Their Chat Completions compatibility endpoint exists, but is beta. this package uses `openai-responses`.
