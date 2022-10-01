const ZwiftMemoryMonitor = require('../index.js');

const zmm = new ZwiftMemoryMonitor(
  {
    // activating logging in this example
    log: console.log,
    // only read data every 4 seconds
    timeout: 4000,
    
    // a version based lookup table
    lookup: [
      {
        versions: "*",
        offsets: {
          weight: [4*4, 'uint32'], // g
          ftp: [5*4, 'uint32'], // W
          height: [42*4, 'uint32'], // mm
          maxhr: [43*4, 'uint32'], // bpm
        },
        signature: {
          start: '00 00 00 00 00 00 00 00',
          // end: '00 00 00 00 ? 00 00 00 00 00 00 00 ? ? ? 00 ? ? 00 00 00 00 00 00',
          end: '00 00 00 00 00 00 00 00 00 00 00 00 ? ? ? 00 ? ? 00 00 00 00 00 00',
          // end: '00 00 00 00 01 00 00 00 00 00 00 00',
          addressOffset: 8
        },
      },
      
    ],
  }
  )
  
  console.log('last error:', zmm.lasterror)
  
  zmm.on('data', (playerProfile) => {
    console.log(playerProfile)
  })
  
  zmm.on('status.started', () => {
    console.log('status.started')
    
    // stop after 40 seconds 
    setTimeout(() => {
      zmm.stop()    
    }, 40000);
    
  })
  
  zmm.on('status.stopped', () => {
    console.log('status.stopped')
  })
  
  zmm.on('status.stopping', () => {
    console.log('status.stopping')
  })
  
  try {
    zmm.start()
    
    console.log('last error:', zmm.lasterror)
    
  } catch (e) {
    console.log('error in zmm.start(): ', zmm.lasterror)
  }
  