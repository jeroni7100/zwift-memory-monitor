const EventEmitter = require('events')
const memoryjs = require('memoryjs');

const fs = require('fs');
const path = require('path')
const os = require('os')


class ZwiftMemoryMonitor extends EventEmitter {
  constructor (options = { }) {
    super()

    this._options = {
      zwiftlog: path.resolve(os.homedir(), 'documents', 'Zwift', 'Logs', 'Log.txt'),
      zwiftapp: 'ZwiftApp.exe',
      offsets: {
        counter: [ 0x84, memoryjs.UINT32 ],
        climbing: [ 0x60, memoryjs.UINT32 ],
        speed: [ 0x3c, memoryjs.UINT32 ],
        distance: [ 0x30, memoryjs.UINT32 ],
        time: [ 0x64, memoryjs.UINT32 ],
        cadenceUHz: [ 0x48, memoryjs.UINT32 ],
        heartrate: [ 0x50, memoryjs.UINT32 ],
        power: [ 0x54, memoryjs.UINT32 ],
        player: [ 0x20, memoryjs.UINT32 ],
        x: [ 0x88, memoryjs.FLOAT ], // ? To be verified
        y: [ 0xa0, memoryjs.FLOAT ], // ? To be verified
        altitude: [ 0x8c, memoryjs.FLOAT ], // ? To be verified
        watching: [ 0x90, memoryjs.UINT32 ],
        world: [ 0x110, memoryjs.UINT32 ],
        // calories: [ 0x??, memoryjs.UINT32 ],
      },
      signature: {
        start: '1E 00 00 00 00 00 00 00 00 00 00 00',
        end: '00 00 00 00',
        addressOffset: 12
      },
      timeout: 100,
      ...options
    }
    
    this._started = false
    
    
  }
  
  start() {
    
    this._started = false
    
    // Find the Zwift process
    try {
      this._processObject = memoryjs.openProcess(this._options.zwiftapp);
    } catch (e) {
      this.lasterror = 'Error in openProcess'
      throw new Error('Error in openProcess', `${this._options.zwiftapp}` )
    }
    
    this._addresses = {}
    
    this._playerid = this._options?.playerid || 0
    
    if (!this._playerid) {

      // Determine player ID from log.txt
      console.log('Zwift log file:', this._options.zwiftlog)
      if (fs.existsSync(this._options.zwiftlog)) {
        let logtxt = fs.readFileSync(this._options.zwiftlog, 'utf8');
        
        // [12:02:30] NETCLIENT:[INFO] Player ID: 793163
        let patterns = {
          user :    /\[(?:[^\]]*)\]\s+NETCLIENT:\[INFO\] Player ID: (\d*)/g ,
        }
        
        let match;
        
        while ((match = patterns.user.exec(logtxt)) !== null) {
          this._playerid = parseInt(match[1]);
        }
        console.log(`Zwift seems to run with player ID: ${this._playerid} = ${('00000000' + this._playerid.toString(16)).substr(-8)}`)
        
      }
    }
    
    if (this?._playerid > 0) {
      
      let signature = `${this._options?.signature?.start} ${('00000000' + this._playerid.toString(16)).substr(-8).match(/../g).reverse().join(' ')} ${this._options?.signature?.end}`
      console.log(signature);
      let addressOffset = this._options.signature?.addressOffset || 0;
      
      memoryjs.findPattern(this._processObject.handle, signature, memoryjs.NORMAL, addressOffset, (error, address) => {
        console.log(error, address)
        if (error && !address) {
          this.lasterror = error
        }

        this._baseaddress = address  
        console.log(`base address: 0x${this._baseaddress.toString(16)}`);
        
        if (this?._baseaddress) {
          // verify by reading back from memory
          const value = memoryjs.readMemory(this._processObject.handle, this._baseaddress, memoryjs.UINT32)
          console.log(`value: ${value} = 0x${value.toString(16)}`);
          
          if (value != this._playerid) {
            this._baseaddress = 0
            this.lasterror = 'Could not verify player ID in memory'
          }
        }
        
        if (this?._baseaddress) {
          Object.keys(this._options.offsets).forEach((key) => {
            this._addresses[key] = [ this._baseaddress - this._options.offsets?.player[0] + this._options.offsets[key][0],  this._options.offsets[key][1] ]
          })
          
          console.log(this._addresses)
          
          this._interval = setInterval(this.readPlayerState.bind(this), this._options.timeout)
          this._started = true

          this.emit('status.started')
          
        } 
        
      });
      
    } else {
      this.lasterror = 'Player ID not found'
    }
    
    
  }
  
  stop() {
    
    this._started = false

    clearInterval(this._interval)
    
    try {
      memoryjs.closeProcess(this?.processObject?.handle)
    } catch (e) {
      // 
    }

    this.emit('status.stopped')
    
  }
  
  readPlayerState () {
    
    var playerState = {}

    if (this._started) {
      try {
        Object.keys(this._options.offsets).forEach((key) => {
          playerState[key] = memoryjs.readMemory(this?._processObject?.handle, this._addresses[key][0], this._addresses[key][1])
        })

        playerState.cadence = Math.floor(playerState?.cadenceUHz / 1000000 * 60)

        this.emit('playerState', playerState)

      } catch (e) {
        // 
        this.emit('status.stopping')
        this.stop()
      }

    }


  }
  
}


module.exports = ZwiftMemoryMonitor

