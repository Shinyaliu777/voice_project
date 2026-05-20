# Recording queue — manual curl test guide

Verifies the four core flows of the recording-queue API:

- `POST /api/recording/start`
- `GET  /api/recording/queue-status`
- `DELETE /api/recording/queue-status`
- `POST /api/recording/release`

The endpoints require an authenticated session. The simplest local setup
is the dev-user fallback — start the dev server with `ALLOW_DEV_USER_FALLBACK=1`
exported, then every request below will be attributed to the user
`dev@voice.local` (auto-created on first hit).

```bash
export ALLOW_DEV_USER_FALLBACK=1
npm run dev   # in another shell
export BASE=http://localhost:3000
```

For multi-tenant scenarios (e.g. two users contending for the same plan
cap) use Playwright or a real OAuth signin so the requests carry a real
session cookie. The flows below all run against a single user.

## Setup — make sure we start clean

Drop any leftover slots from a previous run so positions reset:

```bash
curl -s -X DELETE $BASE/api/recording/queue-status
curl -s -X POST   $BASE/api/recording/release
```

If you want the user's cap to allow more concurrent recordings (so you
can exercise the slot-not-queue path with multiple sessions in one
terminal), bump it directly via psql:

```bash
docker exec -it voice_postgres psql -U voice -d voice_project \
  -c "UPDATE \"User\" SET \"maxConcurrentRecordings\" = 1 WHERE email = 'dev@voice.local';"
```

(Reset to 1 between scenarios to make the asserts predictable.)

## Scenario A — start with capacity → slot is "ready"

User has 0 active slots, cap=1. Expect `slotStatus: "ready"` and a fresh
`sessionId`.

```bash
curl -s -X POST $BASE/api/recording/start \
  -H 'Content-Type: application/json' \
  -d '{
    "translationSource": "cloud",
    "session": { "sourceLanguage": "en", "targetLanguage": "zh" },
    "init": true
  }' | jq

# Expected:
# {
#   "allowed": true,
#   "slotStatus": "ready",
#   "sessionId": "ck...."
# }
```

Verify queue-status now reports the user is NOT queued (because they
have the active slot):

```bash
curl -s $BASE/api/recording/queue-status | jq

# Expected: { "status": "not_queued" }
```

## Scenario B — cap reached → slot is "queued"

Without releasing scenario A's slot, fire another start. Now the user
already holds an active slot and `maxConcurrent=1`, so we should be
enqueued at position 1.

```bash
curl -s -X POST $BASE/api/recording/start \
  -H 'Content-Type: application/json' \
  -d '{
    "session": { "sourceLanguage": "en", "targetLanguage": "zh" }
  }' | jq

# Expected:
# {
#   "allowed": true,
#   "slotStatus": "queued",
#   "queuePosition": 1
# }
```

Poll queue-status — should report "waiting" because the active slot is
still held:

```bash
curl -s $BASE/api/recording/queue-status | jq

# Expected: { "status": "waiting", "position": 1 }
```

Stack a second queued slot to verify position increments:

```bash
curl -s -X POST $BASE/api/recording/start \
  -H 'Content-Type: application/json' \
  -d '{ "session": { "sourceLanguage": "en", "targetLanguage": "zh" } }' | jq

# Expected: { "allowed": true, "slotStatus": "queued", "queuePosition": 2 }
```

## Scenario C — release frees the front-of-line slot

Release the active slot. The lowest-positioned queued slot (position 1)
should auto-promote to active, and the remaining queue rebases so the
next slot is now position 1.

```bash
curl -s -X POST $BASE/api/recording/release | jq

# Expected: { "ok": true }
```

A poll from the queue-status endpoint should now return "ready" for the
front-of-line slot — but because the server already auto-promoted it,
the user's earliest remaining queued slot is at position 1 again (was
2). Run another start to verify, or inspect the DB directly:

```bash
docker exec -it voice_postgres psql -U voice -d voice_project \
  -c "SELECT id, status, \"queuePosition\" FROM \"RecordingSlot\" \
      WHERE \"userId\" = (SELECT id FROM \"User\" WHERE email='dev@voice.local') \
      ORDER BY status, \"queuePosition\";"

# Expected: one row status=active (queuePosition=NULL),
#           one row status=queued queuePosition=1,
#           two rows status=released
```

Polling `/queue-status` for the remaining queued slot:

```bash
curl -s $BASE/api/recording/queue-status | jq

# Expected: { "status": "waiting", "position": 1 }
# (waiting, not ready, because the active slot is filled again)
```

## Scenario D — DELETE cancels the user's queued slot

```bash
curl -s -X DELETE $BASE/api/recording/queue-status | jq

# Expected: { "ok": true }
```

Confirm no queued slot remains:

```bash
curl -s $BASE/api/recording/queue-status | jq

# Expected: { "status": "not_queued" }
```

## Bonus — stale slot auto-release (previousSessionEnded)

If a previous active slot's Session has not been `updatedAt`'d in
10+ minutes, the next `POST /start` auto-releases it and the response
includes `previousSessionEnded: true`. To simulate without waiting:

```bash
# 1. Start a session and get its slot's sessionId.
SID=$(curl -s -X POST $BASE/api/recording/start \
  -H 'Content-Type: application/json' \
  -d '{ "session": { "sourceLanguage": "en", "targetLanguage": "zh" } }' \
  | jq -r '.sessionId')

# 2. Backdate the session updatedAt by 11 minutes via psql.
docker exec -it voice_postgres psql -U voice -d voice_project \
  -c "UPDATE \"Session\" SET \"updatedAt\" = NOW() - INTERVAL '11 minutes' WHERE id = '$SID';"

# 3. Fire a new start — the prior slot should be auto-released.
curl -s -X POST $BASE/api/recording/start \
  -H 'Content-Type: application/json' \
  -d '{ "session": { "sourceLanguage": "en", "targetLanguage": "zh" } }' | jq

# Expected (note previousSessionEnded:true):
# {
#   "allowed": true,
#   "slotStatus": "ready",
#   "sessionId": "ck...",
#   "previousSessionEnded": true
# }
```

## Recovery flow

A user resuming an unfinished recording (from the "上次录音未结束" banner)
should pass `recoverySessionId` so the server reuses the existing
Session row instead of creating a new one:

```bash
curl -s -X POST $BASE/api/recording/start \
  -H 'Content-Type: application/json' \
  -d "{
    \"session\": { \"sourceLanguage\": \"en\", \"targetLanguage\": \"zh\" },
    \"recoverySessionId\": \"$SID\"
  }" | jq

# Expected: { "allowed": true, "slotStatus": "ready", "sessionId": "$SID" }
# (note sessionId matches what was passed)
```

If `recoverySessionId` belongs to another user, the server returns 404
("Recovery session not found").

## Cleanup

```bash
curl -s -X DELETE $BASE/api/recording/queue-status
curl -s -X POST   $BASE/api/recording/release
```

Or wipe all slots for the dev user via psql:

```bash
docker exec -it voice_postgres psql -U voice -d voice_project \
  -c "DELETE FROM \"RecordingSlot\" WHERE \"userId\" = (SELECT id FROM \"User\" WHERE email='dev@voice.local');"
```
