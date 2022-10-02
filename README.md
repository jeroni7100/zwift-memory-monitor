# zwift-memory-monitor

Works with Zwift version 1.29.1

Windows only.


## How to Use

````
npm install https://github.com/zwfthcks/zwift-memory-monitor
`````

In your code:

`````
const ZwiftMemoryMonitor = require('@zwfthcks/zwift-memory-monitor');
const zmm = new ZwiftMemoryMonitor();
`````

See also src/examples/example.js



## Miscellaneous

### Calculated fields

- ```cadence``` (rpm) is calculated from ````cadence_uHz```` (uHz)
- ````calories```` (kCal) is calculated from ````work```` (mWh)
