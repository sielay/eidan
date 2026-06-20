# HTTP · matbot engine plugin

Lets the eidan agent make outbound HTTP requests to web APIs and remote resources — picking the method, headers, and body, and reading the response back as plain text or parsed JSON. The agent reaches for it whenever a task needs live data or an action that lives behind a web endpoint: calling a REST API, fetching a page or feed, posting a webhook, or hitting any service that isn't already wrapped by a dedicated tool.

It is a plugin from the matbot engine (Apache-2.0, github.com/MatAtBread/matbot), available to enable in eidan. It runs in both the node and browser matbot runtimes and is a thin wrapper over the platform `fetch`.

## Tools

| Tool | Purpose |
|---|---|
| `http` | Make a single HTTP request and return the response body. Inputs: `url` (required); `method` (`GET`/`POST`/`PUT`/`DELETE`/`PATCH`, default `GET`); `headers` (string→string map); `body` (request body for POST/PUT/PATCH); `responseType` (`text` or `json`, default `text`). On a non-2xx status it returns an error event carrying `HTTP <status>: <body>` and the status code. With `responseType: 'json'` the body is `JSON.parse`d; a non-JSON body yields an error with the first 200 characters. |

## Example

```
http { "url": "https://api.example.com/v1/items", "responseType": "json" }
→ result: [ { "id": 1, "name": "first" }, … ]

http { "url": "https://hooks.example.com/notify",
       "method": "POST",
       "headers": { "Content-Type": "application/json" },
       "body": "{\"text\":\"done\"}" }
→ result: "ok"
```

## Notes

- Requires network capability — the package description marks it as needing the network capability.
- No retry or timeout handling beyond what `fetch` does by default (redirects follow `fetch`'s defaults); the request is aborted if the surrounding tool call is cancelled (it honours the tool context abort signal).
- The whole response body is read into memory as text before being returned, so it is not suited to very large or streaming downloads.
- Authentication, content-type, and any other request shaping must be supplied explicitly via `headers`; the tool adds nothing on its own.
