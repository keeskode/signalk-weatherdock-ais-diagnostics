# signalk-weatherdock-ais-diagnostics

A Signal K plugin that talks directly to a Weatherdock EasyTRX3 AIS
transponder over its UDP diagnostics/control protocol (`$PWDC`), exposing
device status, alarms, and configuration as structured Signal K paths, and
letting you control Silent Mode, the Anchor Alarm, and the CPA Alarm from
any Signal K-compatible instrument display.

This plugin was reverse-engineered from packet captures of the
manufacturer's own app talking to the device — there is no public protocol
documentation from Weatherdock. Where a field's meaning is confirmed by the
captures it's decoded into a named path. Where it isn't, it's clearly
marked as a guess (see [Confirmed vs. guessed data](#confirmed-vs-guessed-data)
below) and the raw value is always kept alongside it.

---

## Installation

Drop this plugin into your Signal K `plugins` directory (or install it as
you would any local Signal K plugin), restart Signal K, then enable **AIS
UDP Diagnostics** from the Signal K admin UI's Plugin Config page.

## Configuration

All four settings are exposed in the plugin config UI — nothing is
hardcoded in the code itself:

| Setting | Description | Default |
|---|---|---|
| **AIS IP address** | IP address of the EasyTRX3 on your network | `192.168.2.1` |
| **AIS TX UDP port** | Port the plugin sends `$PWDC` commands to | `10111` |
| **AIS RX UDP port** | Port the plugin listens on for responses/broadcasts | `10110` |
| **Polling interval (seconds)** | How often the full diagnostics poll cycle runs | `21600` (6 hours) |

Change any of these in the config UI and restart the plugin — every part
of the code reads from this single config object, so there's nowhere else
that needs updating.

---

## Signal K paths published

### Connection diagnostics

| Path | Type | Notes |
|---|---|---|
| `ais.diagnostics.connected` | boolean | `true` if a response was heard during the last poll cycle (re-evaluated every `interval` seconds, not continuously) |
| `ais.diagnostics.lastSeen` | ISO 8601 string | Timestamp of the last response received |
| `ais.diagnostics.lastResponse` | string | The raw last `$PWDC` sentence received |
| `ais.diagnostics.lastCommand` | string | The raw last command sent to the device |
| `ais.diagnostics.lastCommandResult` | string | `SENT` \| `COMPLETED` \| `TIMEOUT` \| `FAILED` |

The plugin also calls `app.setPluginStatus()` / `app.setPluginError()` so
connection state is visible on the Signal K plugin config page itself.

### Radio

| Path | Type | Notes |
|---|---|---|
| `ais.radio.silentMode` | boolean | Confirmed. `true` = transmitter silenced. Updated by `GET,SM` polling **and** instantly by bit `0x10` of the `LED` broadcast (see below) — the latter is what actually catches changes made outside this plugin between polls |

### Alarms — Anchor / CPA (confirmed)

| Path | Type | Notes |
|---|---|---|
| `ais.alarms.anchor.enabled` | boolean | |
| `ais.alarms.anchor.radius` | number (meters) | |
| `ais.alarms.cpa.enabled` | boolean | |
| `ais.alarms.cpa.distance` | number (meters) | Converted from the device's native hundredths-of-a-nautical-mile |
| `ais.alarms.cpa.time` | number (seconds) | Converted from the device's native minutes |

### Alarms — device system alarms (confirmed, standard IEC 61162 `$AIALR`)

The EasyTRX3 broadcasts standard NMEA `$AIALR` alarm sentences (not
`$PWDC`) with a human-readable description straight from the device — this
decode is not a guess. All 12 alarm codes seen in the captures are exposed
generically, plus a friendly alias for VSWR since that one's usually the
one people care most about:

| Path | Type | Notes |
|---|---|---|
| `ais.alarms.vswr.active` | boolean | Alias for alarm ID `002` |
| `ais.alarms.vswr.acknowledged` | boolean | |
| `ais.alarms.vswr.message` | string | Device's own description text |
| `ais.alarms.system.<id>.active` | boolean | `<id>` is the 3-digit alarm code, e.g. `001`, `072` |
| `ais.alarms.system.<id>.acknowledged` | boolean | |
| `ais.alarms.system.<id>.message` | string | |

Alarm codes confirmed present in the captures:

| Code | Meaning |
|---|---|
| 001 | TX malfunction |
| 002 | Antenna VSWR exceeds limit |
| 003 | Rx channel 1 malfunction |
| 004 | Rx channel 2 malfunction |
| 005 | Rx channel 70 malfunction |
| 007 | UTC sync invalid |
| 008 | MKD connection lost |
| 009 | Internal/external GNSS position mismatch |
| 029 | No valid SOG information |
| 030 | No valid COG information |
| 072 | Low supply voltage |
| 073 | Low supply voltage while sending |

**Important:** `002` (VSWR) is a threshold-exceeded flag, not a continuous
reading. There is no forward power / reverse power / VSWR *ratio* value
anywhere in the captured traffic — see
[Known limitations](#known-limitations) below.

### Configuration (confirmed)

| Path | Type | Notes |
|---|---|---|
| `ais.configuration.mmsi` | number | |
| `ais.configuration.productionDate` | ISO 8601 string | |
| `ais.configuration.version` | string | **Untested** — `GET,VER` was never observed firing in any capture, kept from the original plugin |

### Configuration (best-guess field names — see below)

These types are all still raw multi-field `$PWDC` responses with no
manufacturer documentation. Field *names* below are guesses based on what
a marine multiplexer/AIS transponder typically exposes; every guessed
group also publishes a `.raw` path with the untouched comma-separated
values so nothing is lost if a guess is wrong.

| Path prefix | Guessed fields | Raw path |
|---|---|---|
| `ais.configuration.nmea1.*` / `.nmea2.*` | `aisSentences`, `gpsSentences`, `dscSentences`, `headingSentences`, `waypointSentences`, `alarmSentences`, `reserved` (all booleans) | `.raw` |
| `ais.configuration.aisConf.*` | `txClassBEnabled`, `rxClassA`, `rxClassB`, `rxAtoN`, `rxSar`, `rxBaseStation`, `longRangeEnabled` | `.raw` |
| `ais.configuration.wifiConf.*` | `wifiEnabled`, `apMode`, `clientMode`, `dhcpEnabled`, `gpsOverWifi`, `aisOverWifi` | `.raw` |
| `ais.configuration.mux.*` | `muxEnabled`, `gpsInput`, `aisInput`, `dscInput`, `externalInput1`, `externalInput2`, `reserved` | `.raw` |
| `ais.configuration.ndfilt.*` | `window` (number), `threshold` (number), `enabled` (boolean) | `.raw` |
| `ais.configuration.gpsConf.*` | `gga`, `rmc`, `gsa`, `gsv`, `gll`, `vtg`, `zda`, `reserved` (numbers 0-3, likely a rate/mode selector) | `.raw` |
| `ais.configuration.usb.*` | `usbEnabled`, `massStorageMode`, `nmeaOverUsb`, `chargingOnly`, `reserved` | `.raw` |
| `ais.configuration.miot.enabled` | single boolean ("Marine IoT" cloud toggle, guessed) | `.raw` |

### Diagnostics — no confident guess possible

| Path | Notes |
|---|---|
| `ais.diagnostics.led` | Raw hex value published as-is. **Bit `0x10` is confirmed** (via a real toggle test: `02`=Silent Mode off, `12`=on, consistent with every other LED value seen across all captures) and separately decoded into `ais.radio.silentMode` - see above. The rest of the byte's bits are still unconfirmed |
| `ais.diagnostics.adc` | Raw comma-joined value only. Mixes hex and decimal fields with several always-empty slots — no discernible pattern across any capture |
| `ais.diagnostics.alm.active` (number), `.raw` | Guess: active alarm count/flag |
| `ais.diagnostics.sd.present` (boolean), `.raw` | Confident — `"NOCARD"` is self-explanatory, anything else means a card is present |
| `ais.diagnostics.log.enabled` (boolean), `.raw` | Guess: SD-card logging toggle |
| `ais.diagnostics.sais.enabled` (boolean), `.raw` | Guess: purpose unclear beyond the name |

### Anything else

Any `$PWDC,RES,<type>` not covered above falls through to:

```
ais.diagnostics.raw.<type>
```

as a raw comma-joined string, so nothing the device sends is ever silently
dropped even if it isn't decoded yet.

---

## Control (PUT handlers)

Input shapes are unchanged from the original MVP plugin for backward
compatibility with anything already built against it.

| Signal K PUT path | Payload | Behavior |
|---|---|---|
| `ais.control.silentMode` | `true` \| `false` | Sends `SET,SM,1`/`SET,SM,0`, confirms via `GET,SM` |
| `ais.control.anchorAlarm` | `{ radius: <meters>, enabled: <bool> }` | Sends `SET,ANCHOR,<radius>,<0\|1>`, confirms via `GET,ANCHOR` |
| `ais.control.cpaAlarm` | `{ distance: <hundredths of nm>, minutes: <number>, enabled: <bool> }` | Sends `SET,CPA,<distance>,<minutes>,<0\|1>`, confirms via `GET,CPA` |

**Note:** `cpaAlarm.distance` is still in the device's native units
(hundredths of a nautical mile — e.g. `27` ≈ 500m), matching what the
original plugin already expected. Only the *decoded output* path
(`ais.alarms.cpa.distance`, in meters) is new — the PUT input contract
itself wasn't changed, to avoid breaking anything already calling it.

Every PUT:
1. Sends the `SET` command.
2. Waits 500ms, then sends the matching `GET` command.
3. Waits up to 5 seconds for a `RES` whose relevant fields numerically
   match what was just set (zero-padding differences like `0100` vs `100`
   are handled).
4. Resolves with `COMPLETED` / `TIMEOUT`, or `FAILED` immediately if the
   device is currently offline (per the watchdog, see below).

---

## Protocol notes

- Commands are `$PWDC,<command>*<checksum>` sentences over UDP, sent to
  `aisIp:txPort`, e.g. `$PWDC,GET,MMSI*XX`.
- Checksum is the standard NMEA XOR checksum of everything between `$` and
  `*`, uppercase hex, zero-padded to 2 digits.
- The device responds with `$PWDC,RES,<type>,<params>*XX` on the RX port,
  and also generically ACKs commands with `$PWDC,RES,ACK*XX` (ignored by
  the plugin — it carries nothing to decode).
- The device also broadcasts standard NMEA sentences (GPS, AIS `!AIVDM`,
  and `$AIALR` alarms) on the same RX port, which the plugin's single UDP
  socket also picks up and dispatches accordingly.
- A full poll cycle asks for: `LED`, `SM`, `ANCHOR`, `CPA`, `MMSI`, `VER`,
  `PRODDATE`, `NMEA1`, `NMEA2`, `AIS_CONF`, `ALM`, `SD`, `LOG`, `SAIS` — one
  command every 300ms, repeating every `interval` seconds.
- A watchdog re-checks once per poll cycle (i.e. every `interval` seconds,
  same cadence as `poll()`): if no response has been seen since roughly the
  start of the last cycle - `interval` + ~4.2s (time for the 14 staggered
  commands to go out) + a 5s safety margin - `ais.diagnostics.connected`
  flips to `false`,
  `app.setPluginError("AIS offline")` fires, and any in-flight PUT is
  immediately failed rather than left to time out.

---

## Confirmed vs. guessed data

Everything in this plugin falls into one of three buckets:

1. **Confirmed** — verified directly against packet captures and/or the
   manufacturer app's own `SET` commands, or a real toggle test (e.g. `SM`,
   `ANCHOR`, `CPA`, `MMSI`, `PRODDATE`, `$AIALR` alarms, and bit `0x10` of
   `LED` for Silent Mode). Trust these.
2. **Best guess** — the response shape (field count, value ranges) is
   known from captures, but the *meaning* of each field is inferred from
   what's typical on similar marine multiplexer/AIS hardware, since
   Weatherdock hasn't published protocol docs. These are marked `// GUESS`
   in the code and always have a `.raw` sibling path.
3. **No guess made** — `ADC`, and the rest of `LED`'s bits beyond `0x10`.
   Too few samples or no discernible structure to responsibly guess at, so
   these stay raw-only.

### How to help correct a guess

The most reliable way to verify or fix any guessed field: open the
manufacturer's app, go to the setting in question, toggle **one** flag at
a time while running `tcpdump` on the device's IP, and compare the
before/after `RES` line. Whichever field index flipped is the one that
setting controls — send that over and the label can be corrected in one
line.

---

## Known limitations

- **No continuous forward power / reverse power / VSWR value.** The only
  VSWR-related data found in the captures is the `$AIALR` code `002`
  threshold alarm (exceeded / not exceeded) — there's no numeric ratio or
  power reading anywhere in the traffic captured so far. The `ADC`
  sentence has 4 fields that are always empty across every sample
  collected, including during active transmission, so either this
  firmware doesn't populate them or capturing a value would need a
  narrower/more targeted trigger than what's been tried. See the
  [Protocol notes](#protocol-notes) section above for what a poll cycle
  actually asks for.
- **`GET,VER` is untested** — carried over from the original plugin but
  never seen firing in any of the 4 source captures.
- **`TRX3S-CONF` / `TRX3S-PATH` sync blocks are not implemented.** These
  appear only during the manufacturer app's full device sync and look
  like a bulk config/route data transfer — out of scope for now.
- Several `ais.configuration.*` paths are best-effort field-name guesses
  (see table above) — correct as needed using the process described in
  [Confirmed vs. guessed data](#confirmed-vs-guessed-data).

---

## Changelog vs. the original MVP

- Replaced flat raw-value paths with structured, readable Signal K paths
  grouped under `diagnostics`, `radio`, `alarms`, and `configuration`.
- Added `lastSeen`, `lastResponse`, `lastCommand`, `lastCommandResult`
  diagnostics and `app.setPluginStatus()`/`setPluginError()` dashboard
  integration.
- Added decoding for `$AIALR` system alarms (VSWR, TX/RX malfunction, low
  supply voltage, GNSS/SOG/COG issues), which wasn't handled at all
  before.
- Fixed a latent bug in PUT confirmation: the original code matched
  confirmations against the *radius*/*distance* field of `RES,ANCHOR`/
  `RES,CPA`, not the actual enabled/disabled flag being toggled. PUT
  confirmation now numerically compares all fields sent in the original
  `SET` command against the response (handling zero-padding), so it
  actually confirms the setting that was changed.
- Renamed `plugin.id`/`plugin.name` to `signalk-weatherdock-ais-diagnostics`
  / "Weatherdock AIS Diagnostics" to match the actual package name.
- Fixed a crash (`ERR_SOCKET_DGRAM_NOT_RUNNING`) that occurred if Signal K
  called `plugin.stop()` twice in a row (observed around config saves):
  `stop()` now nulls out the socket/timers after cleanup and tolerates
  being called again. `plugin.start()` is similarly defensive if it's ever
  called twice without an intervening `stop()`.
- Fixed a related crash where one of `poll()`'s 14 staggered command
  timeouts (spread up to ~4.2s apart) could still fire after the plugin
  had already stopped and closed the socket. `send()` — the single choke
  point all outbound commands go through — now no-ops if the socket isn't
  running instead of throwing.
- Changed the default polling interval from 10 seconds to 21600 seconds
  (6 hours), and reworked the watchdog to match: instead of checking every
  1 second whether a response was seen in the last 5 seconds, it now
  re-checks once per poll cycle (every `interval` seconds) whether a
  response was seen since roughly the start of the last cycle. This keeps
  `ais.diagnostics.connected` meaningful at long poll intervals — it stays
  `true` across the whole gap between polls and only changes based on the
  most recent cycle's result, rather than expiring after a few seconds.
- Discovered and decoded bit `0x10` of the `LED` status broadcast as
  Silent Mode state (confirmed via a real toggle test). Since the device
  broadcasts `LED` unprompted every ~5-10s regardless of polling, this
  means `ais.radio.silentMode` now reflects changes made outside this
  plugin (manufacturer app, physical device controls) within seconds,
  without needing a dedicated fast poll for it.
- Kept all 4 config fields (`aisIp`, `txPort`, `rxPort`, `interval`) and
  the 3 control PUT handlers backward-compatible in shape.
