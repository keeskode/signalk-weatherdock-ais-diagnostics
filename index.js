const dgram = require("dgram");


module.exports = function(app) {

    const plugin = {};

    let socket;
    let pollTimer;
    let watchdogTimer;

    let pendingPuts = {};

    let lastAISResponse = 0;

    plugin.id = "ais-udp";
    plugin.name = "AIS UDP Diagnostics";


    plugin.schema = function() {

        return {

            type:"object",

            properties:{

                aisIp:{
                    type:"string",
                    title:"AIS IP address",
                    default:"192.168.2.1"
                },

                txPort:{
                    type:"number",
                    title:"AIS TX UDP port",
                    default:10111
                },

                rxPort:{
                    type:"number",
                    title:"AIS RX UDP port",
                    default:10110
                },

                interval:{
                    type:"number",
                    title:"Polling interval seconds",
                    default:10
                }

            }

        };

    };



    function checksum(sentence){

        let c=0;

        for(let i=1;i<sentence.length;i++){
            c ^= sentence.charCodeAt(i);
        }

        return c
            .toString(16)
            .toUpperCase()
            .padStart(2,"0");

    }



    function makeCommand(command){

        let body="$PWDC,"+command;

        return body+"*"+checksum(body);

    }



    function send(command){

        let msg=Buffer.from(
            command+"\r\n"
        );


        socket.send(
            msg,
            0,
            msg.length,
            plugin.options.txPort,
            plugin.options.aisIp
        );


        app.debug(
            "AIS TX "+command
        );

    }



function sendPWDC(command){

    send(
        makeCommand(command)
    );

}

function sendControlCommand(command){

    publish(
        "ais.diagnostics.lastCommand",
        command
    );

    publish(
        "ais.diagnostics.lastCommandResult",
        "SENT"
    );

    sendPWDC(command);

}




    function publish(path,value){

        app.handleMessage(
            plugin.id,
            {

                updates:[
                    {
                        values:[
                            {
                                path:path,
                                value:value
                            }
                        ]
                    }
                ]

            }
        );

    }





function completePut(type,value){

    if(!pendingPuts[type]){
        return;
    }


let expected = pendingPuts[type].expected;


if(
    expected !== null &&
    value !== expected
){

    app.debug(
        "AIS PUT response ignored "+type+
        " expected "+expected+
        " got "+value
    );

    return;

}


    clearTimeout(
        pendingPuts[type].timeout
    );


    publish(
        "ais.diagnostics.lastCommandResult",
        "COMPLETED"
    );

    pendingPuts[type].callback(
        {
            state:"COMPLETED",
            statusCode:200,
            message:"AIS command confirmed"
        }
    );


    app.debug(
        "AIS PUT completed "+type
    );


    delete pendingPuts[type];

}






    function parse(line){


        if(!line.startsWith("$PWDC,RES")){
            return;
        }


        lastAISResponse = Date.now();


        publish(
            "ais.diagnostics.connected",
            true
        );


        app.debug(
            "AIS RX "+line
        );



        let fields=line.split(",");


        let type=fields[2];


        let value="";


        if(fields[3]){
            value=fields[3]
                .split("*")[0];
        }




        //
        // Complete pending PUT operations
        //

        if(type==="SM"){
            completePut("SM", value);
        }


        if(type==="ANCHOR"){
            completePut("ANCHOR", value);
        }


        if(type==="CPA"){
            completePut("CPA", value);
        }





        switch(type){


            case "LED":

                publish(
                    "ais.diagnostics.led",
                    value
                );

                break;



            case "SM":

                publish(
                    "ais.diagnostics.silentMode",
                    value
                );

                break;



            case "ANCHOR":

                publish(
                    "ais.diagnostics.anchorAlarm",
                    value
                );

                break;



            case "CPA":

                publish(
                    "ais.diagnostics.cpaAlarm",
                    value
                );

                break;



            case "MMSI":

                publish(
                    "ais.diagnostics.mmsi",
                    value
                );

                break;



            case "VER":

                publish(
                    "ais.diagnostics.version",
                    value
                );

                break;



            case "PRODDATE":

                publish(
                    "ais.diagnostics.productionDate",
                    value
                );

                break;



            default:

                publish(
                    "ais.diagnostics.raw."+type,
                    value
                );

        }


    }
        function poll(){

        let commands=[

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


        commands.forEach((cmd,i)=>{

            setTimeout(
                ()=>sendPWDC(cmd),
                i*300
            );

        });

    }






    function watchdog(){

        const alive =
            lastAISResponse > 0 &&
            (Date.now() - lastAISResponse) < 5000;


        publish(
            "ais.diagnostics.connected",
            alive
        );


        if(alive){

            app.setPluginStatus(
                "AIS connected (" +
                Math.round((Date.now()-lastAISResponse)/1000) +
                "s ago)"
            );

            return;

        }


        app.setPluginError(
            "AIS offline"
        );


        Object.keys(pendingPuts)
        .forEach(type=>{

            app.debug(
                "AIS offline, failing PUT "+type
            );

            publish(
                "ais.diagnostics.lastCommandResult",
                "FAILED"
            );

            pendingPuts[type].callback(
                {
                    state:"FAILED",
                    statusCode:504,
                    message:"AIS device offline"
                }
            );

            clearTimeout(
                pendingPuts[type].timeout
            );

            delete pendingPuts[type];

        });

    }






    function startPut(type,setCommand,getCommand,callback){


        app.debug(
            "AIS PUT start "+type
        );



        pendingPuts[type]={

            callback:callback,

            expected:
                type==="SM"
                ? (setCommand.endsWith(",1") ? "1" : "0")
                : null,


            timeout:setTimeout(()=>{


                if(pendingPuts[type]){

            publish(
                "ais.diagnostics.lastCommandResult",
                "TIMEOUT"
            );


            pendingPuts[type].callback(
                {
                    state:"FAILED",
                    statusCode:504,
                    message:"AIS confirmation timeout"
                }
            );


                    delete pendingPuts[type];

                }


            },5000)

        };



        sendControlCommand(setCommand);


        setTimeout(()=>{

            sendPWDC(getCommand);

        },500);



        return {
            state:"COMPLETED",
            statusCode:200
        };


    }








    plugin.start=function(options){


        plugin.options=options;



        socket=dgram.createSocket("udp4");



        socket.on(
            "message",
            msg=>{


                msg.toString()
                .split("\n")
                .forEach(parse);


            }
        );



        socket.bind(
            options.rxPort || 10110
        );



        pollTimer=setInterval(
            poll,
            (options.interval || 10)*1000
        );



        watchdogTimer=setInterval(
            watchdog,
            1000
        );



        poll();





        //
        // CONTROL HANDLERS
        //



        app.registerPutHandler(

            "vessels.self",

            "ais.control.silentMode",

            (context,path,value,callback)=>{


                app.debug(
                    "AIS silentMode PUT received: "+value
                );



                return startPut(

                    "SM",

                    value
                        ? "SET,SM,1"
                        : "SET,SM,0",


                    "GET,SM",


                    callback

                );


            }

        );







        app.registerPutHandler(

            "vessels.self",

            "ais.control.anchorAlarm",

            (context,path,value,callback)=>{


                return startPut(

                    "ANCHOR",


                    "SET,ANCHOR,"+
                    value.radius+
                    ","+
                    (value.enabled?1:0),


                    "GET,ANCHOR",


                    callback

                );


            }

        );








        app.registerPutHandler(

            "vessels.self",

            "ais.control.cpaAlarm",

            (context,path,value,callback)=>{


                return startPut(

                    "CPA",


                    "SET,CPA,"+
                    value.distance+
                    ","+
                    value.minutes+
                    ","+
                    (value.enabled?1:0),


                    "GET,CPA",


                    callback

                );


            }

        );



        app.debug(
            "AIS PUT handlers registered"
        );


    };









    plugin.stop=function(){



        if(pollTimer){

            clearInterval(
                pollTimer
            );

        }



        if(watchdogTimer){

            clearInterval(
                watchdogTimer
            );

        }




        if(socket){

            socket.close();

        }


    };





    return plugin;


};