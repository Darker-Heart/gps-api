const DEBUG = process.env.DEBUG ? process.env.DEBUG==='YES' : true
const Influx = require('influx')
const escape = require('influx').escape
let connection = null
let tachometerTick = 30

/**
 * Is value numeric.
 * @param {*} n String, integer or float.
 * 
 * @returns true|false True if proviced value can be converted to a float.
 */

function isNumeric(n) {
    return !isNaN(parseFloat(n)) && isFinite(n);
  }

/**
 * Create a date compatible with InfluxDB database from an event data object.
 * @param {*} data Object containing properties utc (time) and position_utc (date)
 * 
 * @returns Date object
 */

function influxDate(data){
    
    if(typeof data.utc === 'string' && typeof data.position_utc === 'string'){
        const year = '20' + data.position_utc.substring(4)
		const month =  data.position_utc.substring(2,4)
		const day = data.position_utc.substring(0,2)
		const hour = data.utc.substring(0,2)
		const minute =  data.utc.substring(2,4)
        const second =  data.utc.substring(4,6)
        return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);   
    }else{
        return new Date()
    }

}

/**
 * Connect to InfluxDB
 * 
 * @param {*} config Config params
 * @param {*} dataInterval Desired time interval in seconds between speed measurements.
 */
const connect = (config,dataInterval=30) => {
    if(!config){
        throw "Unable to use null config for influxdb."
    }

    tachometerTick = dataInterval

    connection = new Influx.InfluxDB(
        Object.assign({
            schema: [
                {
                    measurement: 'speed',
                    fields: { value: Influx.FieldType.FLOAT },
                    tags: ['unit','lat','long']
                },
                {
                    measurement: 'duration',
                    fields: { value: Influx.FieldType.INTEGER },
                    tags: ['unit','lat','long']
                }
            ]
        },config)
    )
}

/**
 * Get various measurements from the database.
 */

const get = {
    /**
     * Get available unit ids.
     */
    units: async () => {
        const result = await connection.query("show tag values from speed with key=unit")
        const units = []

        for( key in result ){
            if(result[key].value){
                const startChar = result[key].value.indexOf(":")
                const unit = result[key].value.substring(startChar+1)
                if( unit !== 'undefined' && result[key].key === "unit" ){
                    units.push({id: unit})
                }
            }
        }    
        return units;
    },
    /**
     * Get events.
     */
    events: async (unitId,group="d",timezone="UTC",dateRange) => {
        let {startDate,endDate} = dateRange
        endDate = escape.stringLit(endDate)
        startDate = escape.stringLit(startDate)
        unitId = escape.measurement(unitId)
        group = escape.measurement(group)
        timezone = escape.stringLit(timezone)
        const query = `select sum(value) from "duration" where time > ${startDate} and time < ${endDate} and unit =~ /.*${unitId}/ group by time(1${group}) TZ(${timezone})`
        const result = await connection.query(query)
        return result;
    },
    /**
     * Get distance traveled in date range.
     */
    distance: async (unitId,timezone="UTC",dateRange) => {
        let {startDate,endDate} = dateRange
        endDate = escape.stringLit(endDate)
        startDate = escape.stringLit(startDate)
        unitId = escape.measurement(unitId)
        timezone = escape.stringLit(timezone)
        const query = `select integral(value) / 3600 from "speed" where time > ${startDate} and time < ${endDate} and unit =~ /.*${unitId}/ TZ(${timezone})`
        const result = await connection.query(query)
        const distance = Array.isArray(result) && result.length > 0 ? result[0].integral : 0
        return distance;
    }
}

/**
 * Write to InfluxDB
 * @param {*} records Records to write.
 * @param {*} model Model to use.
 * @param {*} retry Number of retry attempts so far.
 */

const write = (records,model,retry) => {
    if( connection ){
        const filteredRecords = records.filter( (r) => {
            return isNumeric(r.gs)
        })
        return new Promise( (resolve, reject) => {
            if(connection){
                const queryPromises = filteredRecords.map( (record) => {
                    const duration = parseFloat(record.gs) > 2 ? tachometerTick : 0
                    const ts = influxDate(record)

                    return connection.writePoints(
                        [
                            {
                                measurement: 'speed',
                                fields: {value: record.gs},
                                tags: {unit: record.imei, lat: record.lat_loc + record.lat, long: record.long_loc + record.long},
                                timestamp: ts
                            },
                            {
                                measurement: 'duration',
                                fields: {value: duration},
                                tags: {unit: record.imei, lat: record.lat_loc + record.lat, long: record.long_loc + record.long},
                                timestamp: ts
                            }
                        ]
                    )
                })

                Promise.all(queryPromises)
                    .then( () => {
                        if(DEBUG) console.log(`Wrote ${filteredRecords.length} record(s) to influxdb.`)
                        resolve()
                    })
                    .catch( (err) => {
                        if(DEBUG) console.log("Error: "+ err.code + " while writing to influxdb.")
                        reject(err)
                    })
            }
        })
    }
}

/**
 * Disconnect from database.
 */

const disconnect = () => {
    connection = null
}

module.exports.connect = connect
module.exports.disconnect = disconnect
module.exports.get = get
module.exports.write = (record,model) => write([record],model,0)