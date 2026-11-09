#!/usr/bin/env bash
# End-to-end smoke test. Starts the API on a throwaway DB, exercises the
# booking and waitlist flows against the mock payment provider, then stops.
#
#   bash test/e2e.sh

set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3901}"
TOKEN="devtoken"
export DB_PATH="/tmp/spectrum-e2e-$$.db"
export ADMIN_TOKEN="$TOKEN"
export PAYMENT_PROVIDER=mock

rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"

node src/seed.js >/dev/null 2>&1
PORT="$PORT" node src/server.js >/tmp/e2e-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"' EXIT

for _ in $(seq 1 30); do
  curl -sf -m 1 "localhost:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.3
done

API="localhost:$PORT"
PASS=0; FAIL=0

check() { # check <label> <haystack> <needle>
  if grep -q -- "$3" <<<"$2"; then
    echo "  ✓ $1"; PASS=$((PASS+1))
  else
    echo "  ✗ $1"; echo "      expected to find: $3"; echo "      got: ${2:0:220}"; FAIL=$((FAIL+1))
  fi
}

post() { curl -s -m 5 -X POST "$API$1" -H 'Content-Type: application/json' -d "$2"; }
apost() { curl -s -m 5 -X POST "$API$1" -H "x-admin-token: $TOKEN" -H 'Content-Type: application/json' -d "$2"; }
refof() { sed -n 's/.*"ref":"\([^"]*\)".*/\1/p' <<<"$1"; }

# First bookable time on a day, so the script isn't pinned to a clock.
slot_of() { curl -s -m 5 "$API/api/classes/$1/slots" |
  sed -n 's/.*"slots":\[{"start":"\([^"]*\)".*/\1/p'; }

ADDR='1200 SW Main St, Hillsboro, OR 97123'

echo
echo "training days"

OUT=$(curl -s -m 5 "$API/health")
check "health reports the mock provider" "$OUT" '"mock":true'
check "and advertises slot booking"      "$OUT" 'slots'

OUT=$(curl -s -m 5 "$API/api/classes/1/slots")
check "a day offers bookable times" "$OUT" '"available":true'
check "it reports the session length" "$OUT" '"sessionMinutes":240'
check "and the travel buffer"         "$OUT" '"bufferMinutes":90'

echo
echo "booking flow"

SLOT1=$(slot_of 1)
OUT=$(post /api/classes/1/hold "{\"name\":\"Jane Doe\",\"email\":\"jane@example.com\",\"slotStart\":\"$SLOT1\",\"address\":\"$ADDR\"}")
JANE=$(refof "$OUT")
check "a time can be held"            "$OUT" '"status":"held"'
check "the hold window is 20 minutes" "$OUT" '"holdMinutes":20'
check "a mock checkout url comes back" "$OUT" 'mock-checkout'
check "the address is recorded"        "$OUT" 'Hillsboro'

OUT=$(curl -s -m 5 "$API/api/classes/1")
check "the seat count drops to 19" "$OUT" '"seatsAvailable":19'

OUT=$(curl -s -m 5 "$API/api/classes/1/slots")
check "the booked time is no longer offered" "$OUT" '"reason":"booked"'

OUT=$(post "/api/registrations/$JANE/confirm" '{"outcome":"approve"}')
check "an approved payment confirms" "$OUT" '"status":"confirmed"'

OUT=$(post "/api/registrations/$JANE/confirm" '{"outcome":"approve"}')
check "replaying the confirm is safe" "$OUT" '"alreadyConfirmed":true'

OUT=$(curl -s -m 5 "$API/api/classes/1")
check "the replay did not eat a second seat" "$OUT" '"seatsAvailable":19'

echo
echo "declines"

SLOT2=$(curl -s -m 5 "$API/api/classes/1/slots" | tr '}' '\n' | grep '"available":true' | head -1 | sed -n 's/.*"start":"\([^"]*\)".*/\1/p')
OUT=$(post /api/classes/1/hold "{\"name\":\"Bob Smith\",\"email\":\"bob@example.com\",\"slotStart\":\"$SLOT2\",\"address\":\"$ADDR\"}")
BOB=$(refof "$OUT")
OUT=$(post "/api/registrations/$BOB/confirm" '{"outcome":"decline"}')
check "a declined payment is rejected" "$OUT" 'payment_not_approved'

OUT=$(curl -s -m 5 "$API/api/registrations/$BOB")
check "the declined seat stays held until it expires" "$OUT" '"status":"held"'

echo
echo "validation"

OUT=$(post /api/classes/1/hold "{\"name\":\"X\",\"email\":\"jane@example.com\",\"slotStart\":\"$SLOT1\",\"address\":\"$ADDR\"}")
check "a one-character name is refused" "$OUT" 'name_required'

OUT=$(post /api/classes/1/hold "{\"name\":\"Real Name\",\"email\":\"not-an-email\",\"slotStart\":\"$SLOT1\",\"address\":\"$ADDR\"}")
check "a malformed email is refused" "$OUT" 'valid_email_required'

OUT=$(post /api/classes/1/hold "{\"name\":\"Real Name\",\"email\":\"a@b.com\",\"address\":\"$ADDR\"}")
check "a booking with no time is refused" "$OUT" 'slot_required'

OUT=$(post /api/classes/1/hold "{\"name\":\"Real Name\",\"email\":\"a@b.com\",\"slotStart\":\"$SLOT1\"}")
check "a booking with no address is refused" "$OUT" 'address_required'

OUT=$(post /api/classes/9999/hold "{\"name\":\"Real Name\",\"email\":\"a@b.com\",\"slotStart\":\"$SLOT1\",\"address\":\"$ADDR\"}")
check "an unknown day is refused" "$OUT" 'no_such_class'

echo
echo "clashing times"

SLOT3=$(curl -s -m 5 "$API/api/classes/2/slots" | sed -n 's/.*"slots":\[{"start":"\([^"]*\)".*/\1/p')
post /api/classes/2/hold "{\"name\":\"Early Bird\",\"email\":\"early@example.com\",\"slotStart\":\"$SLOT3\",\"address\":\"$ADDR\"}" >/dev/null

OUT=$(post /api/classes/2/hold "{\"name\":\"Late Comer\",\"email\":\"late@example.com\",\"slotStart\":\"$SLOT3\",\"address\":\"$ADDR\"}")
check "two bookings cannot share a time" "$OUT" 'slot_taken'
check "and the message says so"           "$OUT" 'just booked that time'

echo
echo "full days and the waitlist"

TOMORROW=$(date -u -d '+30 days' +%Y-%m-%d 2>/dev/null || date -u -v+30d +%Y-%m-%d)
MADE=$(apost /api/admin/classes "{\"courseCode\":\"CPR\",\"title\":\"Tiny day\",\"startsAt\":\"${TOMORROW}T16:00:00Z\",\"endsAt\":\"${TOMORROW}T22:00:00Z\",\"capacity\":1,\"priceCents\":8500}")

# Read the id back rather than assuming one — the seeded set changes.
TINY=$(sed -n 's/.*"classId":\([0-9]*\).*/\1/p' <<<"$MADE")
check "a day can be created from the admin API" "$MADE" '"ok":true'
TSLOT=$(slot_of $TINY)
OUT=$(post "/api/classes/$TINY/hold" "{\"name\":\"First Person\",\"email\":\"first@example.com\",\"slotStart\":\"$TSLOT\",\"address\":\"$ADDR\"}")
FIRST=$(refof "$OUT")
check "the single place is taken" "$OUT" '"status":"held"'

OUT=$(post "/api/classes/$TINY/hold" "{\"name\":\"Second Person\",\"email\":\"second@example.com\",\"slotStart\":\"$TSLOT\",\"address\":\"$ADDR\"}")
check "the next person is blocked"      "$OUT" '"reason":"full"'
check "and is pointed at the waitlist"  "$OUT" '"canJoinWaitlist":true'

OUT=$(post "/api/classes/$TINY/waitlist" '{"name":"Second Person","email":"second@example.com","preferredTime":"09:00","partySize":2}')
SECOND=$(refof "$OUT")
check "they join the waitlist at position 1" "$OUT" '"position":1'
check "and are offered other days"          "$OUT" '"alternatives"'

OUT=$(post "/api/classes/$TINY/waitlist" '{"name":"Second Person","email":"second@example.com"}')
check "the same email cannot double-join" "$OUT" 'already_registered'

OUT=$(post "/api/registrations/$FIRST/cancel" '{"reason":"changed plans"}')
check "cancelling promotes one waiter" "$OUT" '"promoted":1'

OUT=$(curl -s -m 5 "$API/api/registrations/$SECOND")
check "the waiter now holds an offer" "$OUT" '"status":"offered"'

OUT=$(curl -s -m 5 "$API/api/classes/$TINY")
check "the offered place is not public" "$OUT" '"seatsAvailable":0'

echo
echo "another day instead"

OUT=$(curl -s -m 5 "$API/api/classes/1/alternatives?partySize=2")
check "alternatives are offered for a busy day" "$OUT" '"alternatives"'

echo
echo "admin"

OUT=$(curl -s -m 5 "$API/api/admin/classes/1/roster")
check "the roster needs a token" "$OUT" 'unauthorized'

OUT=$(curl -s -m 5 "$API/api/admin/classes/1/roster" -H "x-admin-token: $TOKEN")
check "the roster lists the confirmed student" "$OUT" 'jane@example.com'

OUT=$(curl -s -m 5 "$API/api/admin/outbox" -H "x-admin-token: $TOKEN")
check "a confirmation email was queued" "$OUT" "You're registered"

echo
echo "$PASS passed, $FAIL failed"
echo
[ "$FAIL" -eq 0 ]
