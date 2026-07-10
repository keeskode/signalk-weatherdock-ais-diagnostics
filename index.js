const dgram = require("dgram");

// Meters per nautical mile, used to convert the CPA distance field
// (confirmed from packet captures to be sent in hundredths of a
// nautical mile, e.g. "27" == 0.27nm == ~500m) into SI meters.
const METERS_PER_NM = 1852;

module.exports = function (app) {

    const plugin = {};

    plugin.id = "signalk-weatherdock-ais-diagnostics";
    plugin.name = "WeatherDock AIS Diagnostics";

    let socket;
    let pollTimer;
    let watchdogTimer;

    let pendingPuts = {};

    let lastResponseAt = 0;


    plugin.schema = function () {

        return {

            type: "object",

            properties: {

                aisIp: {
                    type: "string",
                    title: "AIS IP address",
                    default: "192.168.2.1"
                },

                txPort: {
                    type: "number",
                    title: "AIS TX UDP port",
                    default: 10111
                },

                rxPort: {
                    type: "number",
                    title: "AIS RX UDP port",
                    default: 10110
                },

                interval: {
                    type: "number",
                    title: "Polling interval seconds",
                    default: 10
                }

            }

        };

    };


    //
    // ---- $PWDC sentence helpers ----
    //

    function checksum(sentence) {

        let c = 0;

        for (let i = 1; i < sentence.length; i++) {
            c ^= sentence.charCodeAt(i);
        }

        return c
            .toString(16)
            .toUpperCase()
            .padStart(2, "0");

    }


    function makeCommand(command) {

        let body = "$PWDC," + command;

        return body + "*" + checksum(body);

    }


    function send(command) {

        let msg = Buffer.from(command + "\r\n");

        socket.send(
            msg,
            0,
            msg.length,
            plugin.options.txPort,
            plugin.options.aisIp
        );

        app.debug("AIS TX " + command);

    }


    function sendPWDC(command) {

        send(makeCommand(command));

    }


    function sendControlCommand(command) {

        publish("ais.diagnostics.lastCommand", command);
        publish("ais.diagnostics.lastCommandResult", "SENT");

        sendPWDC(command);

    }


    function publish(path, value) {

        app.handleMessage(
            plugin.id,
            {
                updates: [
                    {
                        values: [
                            {
                                path: path,
                                value: value
                            }
                        ]
                    }
                ]
            }
        );

    }


    //
    // ---- PUT confirmation tracking ----
    //
    // A PUT sends a SET command, then a follow-up GET. When the matching
    // RES,<type> comes back we compare its leading fields (as numbers, since
    // the device zero-pads e.g. "0100" vs the "100" we sent) against the
    // params we originally sent in the SET command. Extra trailing fields
    // in the response (whose meaning isn't confirmed yet) are ignored.
    //

    function commandParams(command) {

        // "SET,ANCHOR,100,1" -> ["100","1"]
        return command.split(",").slice(2);

    }


    function startPut(type, setCommand, getCommand, callback) {

        app.debug("AIS PUT start " + type);

        pendingPuts[type] = {

            callback: callback,

            expected: commandParams(setCommand),

            timeout: setTimeout(() => {

                if (pendingPuts[type]) {

                    publish("ais.diagnostics.lastCommandResult", "TIMEOUT");

                    pendingPuts[type].callback({
                        state: "FAILED",
                        statusCode: 504,
                        message: "AIS confirmation timeout"
                    });

                    delete pendingPuts[type];

                }

            }, 5000)

        };

        sendControlCommand(setCommand);

        setTimeout(() => {
            sendPWDC(getCommand);
        }, 500);

        return {
            state: "COMPLETED",
            statusCode: 200
        };

    }


    function completePut(type, params) {

        let pending = pendingPuts[type];

        if (!pending) {
            return;
        }

        let matches = pending.expected.every(
            (exp, i) => Number(params[i]) === Number(exp)
        );

        if (!matches) {

            app.debug(
                "AIS PUT response ignored " + type +
                " expected " + pending.expected.join(",") +
                " got " + params.join(",")
            );

            return;

        }

        clearTimeout(pending.timeout);

        publish("ais.diagnostics.lastCommandResult", "COMPLETED");

        pending.callback({
            state: "COMPLETED",
            statusCode: 200,
            message: "AIS command confirmed"
        });

        app.debug("AIS PUT completed " + type);

        delete pendingPuts[type];

    }


    //
    // ---- Decoders for each $PWDC,RES,<type> ----
    //
    // Confirmed field meanings (verified against packet captures and the
    // manufacturer app's own SET commands): SM, ANCHOR, CPA, MMSI, PRODDATE.
    //
    // Everything else below is published as a raw comma-joined string under
    // ais.configuration.* / ais.diagnostics.* because the individual field
    // meanings aren't confirmed anywhere in the captures. Easy to promote
    // to a decoded path once we know what a field means (e.g. by toggling
    // one setting at a time in the manufacturer app and diffing the RES).
    //

    const decoders = {

        SM: (p) => {
            publish("ais.radio.silentMode", p[0] === "1");
            completePut("SM", p);
        },

        ANCHOR: (p) => {
            publish("ais.alarms.anchor.radius", Number(p[0]));
            publish("ais.alarms.anchor.enabled", p[1] === "1");
            completePut("ANCHOR", p);
        },

        CPA: (p) => {
            // p[0]: hundredths of a nautical mile, e.g. "27" -> 0.27nm -> ~500m
            // p[1]: minutes
            publish(
                "ais.alarms.cpa.distance",
                Math.round((Number(p[0]) / 100) * METERS_PER_NM)
            );
            publish("ais.alarms.cpa.time", Number(p[1]) * 60);
            publish("ais.alarms.cpa.enabled", p[2] === "1");
            completePut("CPA", p);
        },

        MMSI: (p) => publish("ais.configuration.mmsi", Number(p[0])),

        PRODDATE: (p) => publish("ais.configuration.productionDate", p[0]),

        // Untested - no GET,VER/RES,VER pair was ever observed in the
        // captures, but the old plugin polled for it, so keep it wired up.
        VER: (p) => publish("ais.configuration.version", p[0]),

        // No confident guess possible here (see note above the decoders
        // block) - only 2 distinct LED samples and ADC mixes hex/decimal/
        // empty fields with no discernible pattern. Raw only.
        LED: (p) => publish("ais.diagnostics.led", p[0]),
        ADC: (p) => publish("ais.diagnostics.adc", p.join(",")),

        // GUESS: single value, likely "any alarm currently active" count/flag.
        ALM: (p) => {
            publish("ais.diagnostics.alm.active", Number(p[0]));
            publish("ais.diagnostics.alm.raw", p.join(","));
        },

        // "NOCARD" is self-explanatory; anything else means a card is present.
        SD: (p) => {
            publish("ais.diagnostics.sd.present", p[0] !== "NOCARD");
            publish("ais.diagnostics.sd.raw", p.join(","));
        },

        // GUESS: single flag, likely "logging to SD card enabled".
        LOG: (p) => {
            publish("ais.diagnostics.log.enabled", p[0] === "1");
            publish("ais.diagnostics.log.raw", p.join(","));
        },

        // GUESS: single flag, purpose unclear beyond the name ("Simplex AIS"?).
        SAIS: (p) => {
            publish("ais.diagnostics.sais.enabled", p[0] === "1");
            publish("ais.diagnostics.sais.raw", p.join(","));
        },

        // GUESS: 7 output-sentence-category flags per NMEA port, based on
        // the categories a marine multiplexer typically lets you toggle.
        // Order is not confirmed - verify by disabling one category at a
        // time in the manufacturer app and diffing which index flips.
        NMEA1: (p) => decodeNmeaPort("ais.configuration.nmea1", p),
        NMEA2: (p) => decodeNmeaPort("ais.configuration.nmea2", p),

        // GUESS: 7 flags, likely which AIS message classes are
        // transmitted/received.
        AIS_CONF: (p) => {
            const labels = [
                "txClassBEnabled", "rxClassA", "rxClassB",
                "rxAtoN", "rxSar", "rxBaseStation", "longRangeEnabled"
            ];
            labels.forEach((label, i) => {
                publish("ais.configuration.aisConf." + label, p[i] === "1");
            });
            publish("ais.configuration.aisConf.raw", p.join(","));
        },

        // GUESS: 6 flags for the WiFi module's operating mode.
        WIFI_CONF: (p) => {
            const labels = [
                "wifiEnabled", "apMode", "clientMode",
                "dhcpEnabled", "gpsOverWifi", "aisOverWifi"
            ];
            labels.forEach((label, i) => {
                publish("ais.configuration.wifiConf." + label, p[i] === "1");
            });
            publish("ais.configuration.wifiConf.raw", p.join(","));
        },

        // GUESS: 7 flags for which sources feed the internal multiplexer.
        MUX: (p) => {
            const labels = [
                "muxEnabled", "gpsInput", "aisInput",
                "dscInput", "externalInput1", "externalInput2", "reserved"
            ];
            labels.forEach((label, i) => {
                publish("ais.configuration.mux." + label, p[i] === "1");
            });
            publish("ais.configuration.mux.raw", p.join(","));
        },

        // GUESS: two 4-digit numeric fields + a flag - "Nav Data Filter",
        // likely a duplicate/noise-message filter window and threshold.
        NDFILT: (p) => {
            publish("ais.configuration.ndfilt.window", Number(p[0]));
            publish("ais.configuration.ndfilt.threshold", Number(p[1]));
            publish("ais.configuration.ndfilt.enabled", p[2] === "1");
            publish("ais.configuration.ndfilt.raw", p.join(","));
        },

        // GUESS: 8 small integers (0-3), likely a per-sentence GPS output
        // rate/mode selector rather than plain on/off flags.
        GPSCONF: (p) => {
            const labels = [
                "gga", "rmc", "gsa", "gsv", "gll", "vtg", "zda", "reserved"
            ];
            labels.forEach((label, i) => {
                publish("ais.configuration.gpsConf." + label, Number(p[i]));
            });
            publish("ais.configuration.gpsConf.raw", p.join(","));
        },

        // GUESS: 5 flags describing the USB port's function.
        USB: (p) => {
            const labels = [
                "usbEnabled", "massStorageMode", "nmeaOverUsb",
                "chargingOnly", "reserved"
            ];
            labels.forEach((label, i) => {
                publish("ais.configuration.usb." + label, p[i] === "1");
            });
            publish("ais.configuration.usb.raw", p.join(","));
        },

        // GUESS: single flag - "Marine IoT" cloud connectivity toggle.
        MIOT: (p) => {
            publish("ais.configuration.miot.enabled", p[0] === "1");
            publish("ais.configuration.miot.raw", p.join(","));
        }

    };


    // GUESS: field order for NMEA1/NMEA2 output-sentence-category flags.
    // Shared helper since both ports use the same (unconfirmed) layout.
    function decodeNmeaPort(basePath, p) {

        const labels = [
            "aisSentences", "gpsSentences", "dscSentences",
            "headingSentences", "waypointSentences", "alarmSentences", "reserved"
        ];

        labels.forEach((label, i) => {
            publish(basePath + "." + label, p[i] === "1");
        });

        publish(basePath + ".raw", p.join(","));

    }


    // $AIALR is the standard IEC 61162-1 alarm sentence (not a $PWDC
    // proprietary one) - it's broadcast on the general NMEA port alongside
    // GPS/AIS traffic. Format: $AIALR,hhmmss.ss,alarmID,condition,ack,text
    // condition: "A" = threshold exceeded/active, "V" = not exceeded/normal
    // ack: "A" = acknowledged, "V" = not acknowledged
    // The description text comes straight from the device, so this decode
    // is fully confirmed - nothing here is guessed.
    //
    // NOTE: this only reports VSWR (and TX malfunction, low supply voltage,
    // etc) as an exceeded/not-exceeded flag. It does NOT carry a continuous
    // forward power / reverse power / VSWR ratio value - that wasn't present
    // anywhere in the captured logs.
    function parseAIALR(line) {

        let body = line.split("*")[0];
        let fields = body.split(",");

        let alarmId = fields[2];
        let active = fields[3] === "A";
        let acknowledged = fields[4] === "A";
        let message = fields.slice(5).join(",");

        publish("ais.alarms.system." + alarmId + ".active", active);
        publish("ais.alarms.system." + alarmId + ".acknowledged", acknowledged);
        publish("ais.alarms.system." + alarmId + ".message", message);

        // Friendly alias for the one you care about most - alarm ID 002.
        if (alarmId === "002") {
            publish("ais.alarms.vswr.active", active);
            publish("ais.alarms.vswr.acknowledged", acknowledged);
            publish("ais.alarms.vswr.message", message);
        }

    }


    function parse(line) {

        line = line.trim();

        if (line.startsWith("$AIALR,")) {
            parseAIALR(line);
            return;
        }

        if (!line.startsWith("$PWDC,")) {
            return;
        }

        lastResponseAt = Date.now();

        publish("ais.diagnostics.connected", true);
        publish("ais.diagnostics.lastResponse", line);

        app.debug("AIS RX " + line);

        let body = line.split("*")[0];
        let fields = body.split(",");

        // fields: ["$PWDC", "RES"|"SET"|"GET"|"DEBUG", <type>, ...params]
        let msgClass = fields[1];
        let type = fields[2];
        let params = fields.slice(3);

        if (msgClass !== "RES" || type === "ACK") {
            // Generic ACKs and echoed SET/GET/DEBUG commands carry nothing
            // to decode; connected/lastResponse above already captured them.
            return;
        }

        let decoder = decoders[type];

        if (decoder) {
            decoder(params);
        } else {
            publish("ais.diagnostics.raw." + type, params.join(","));
        }

    }


    function poll() {

        let commands = [

            "GET,LED",
            "GET,SM",
            "GET,ANCHOR",
            "GET,CPA",
            "GET,MMSI",
            "GET,VER",
            "GET,PRODDATE",
            "GET,NMEA1",
            "GET,NMEA2",
            "GET,AIS_CONF",
            "GET,ALM",
            "GET,SD",
            "GET,LOG",
            "GET,SAIS"

        ];

        commands.forEach((cmd, i) => {
            setTimeout(() => sendPWDC(cmd), i * 300);
        });

    }


    function watchdog() {

        const alive =
            lastResponseAt > 0 &&
            (Date.now() - lastResponseAt) < 5000;

        publish("ais.diagnostics.connected", alive);

        if (lastResponseAt > 0) {
            publish(
                "ais.diagnostics.lastSeen",
                new Date(lastResponseAt).toISOString()
            );
        }

        if (alive) {

            app.setPluginStatus(
                "AIS connected (" +
                Math.round((Date.now() - lastResponseAt) / 1000) +
                "s ago)"
            );

            return;

        }

        app.setPluginError("AIS offline");

        Object.keys(pendingPuts).forEach(type => {

            app.debug("AIS offline, failing PUT " + type);

            publish("ais.diagnostics.lastCommandResult", "FAILED");

            pendingPuts[type].callback({
                state: "FAILED",
                statusCode: 504,
                message: "AIS device offline"
            });

            clearTimeout(pendingPuts[type].timeout);

            delete pendingPuts[type];

        });

    }


    plugin.start = function (options) {

        plugin.options = options;

        socket = dgram.createSocket("udp4");

        socket.on("message", msg => {
            msg.toString().split("\n").forEach(parse);
        });

        socket.bind(options.rxPort || 10110);

        pollTimer = setInterval(
            poll,
            (options.interval || 10) * 1000
        );

        watchdogTimer = setInterval(watchdog, 1000);

        poll();


        //
        // ---- Control PUT handlers ----
        // Input shapes are unchanged from the previous version for
        // backward compatibility. Note ais.control.cpaAlarm's `distance`
        // is in the device's native units (hundredths of a nautical mile),
        // matching what the old plugin already expected - only the
        // decoded *output* paths (ais.alarms.cpa.distance in meters) are new.
        //

        app.registerPutHandler(
            "vessels.self",
            "ais.control.silentMode",
            (context, path, value, callback) => {

                app.debug("AIS silentMode PUT received: " + value);

                return startPut(
                    "SM",
                    value ? "SET,SM,1" : "SET,SM,0",
                    "GET,SM",
                    callback
                );

            }
        );


        app.registerPutHandler(
            "vessels.self",
            "ais.control.anchorAlarm",
            (context, path, value, callback) => {

                return startPut(
                    "ANCHOR",
                    "SET,ANCHOR," + value.radius + "," + (value.enabled ? 1 : 0),
                    "GET,ANCHOR",
                    callback
                );

            }
        );


        app.registerPutHandler(
            "vessels.self",
            "ais.control.cpaAlarm",
            (context, path, value, callback) => {

                return startPut(
                    "CPA",
                    "SET,CPA," + value.distance + "," + value.minutes + "," + (value.enabled ? 1 : 0),
                    "GET,CPA",
                    callback
                );

            }
        );

        app.debug("AIS PUT handlers registered");

    };


    plugin.stop = function () {

        if (pollTimer) {
            clearInterval(pollTimer);
        }

        if (watchdogTimer) {
            clearInterval(watchdogTimer);
        }

        if (socket) {
            socket.close();
        }

    };


    return plugin;

};
