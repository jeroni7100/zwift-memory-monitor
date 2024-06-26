# zwift-memory-monitor

Works with Zwift version 1.29.1+

Last tested with: Zwift version 1.65.0

Windows only [^1].


## How to Use

````
npm install https://github.com/zwfthcks/zwift-memory-monitor
`````

In your code:

`````
const ZwiftMemoryMonitor = require('@zwfthcks/zwift-memory-monitor');
const zmm = new ZwiftMemoryMonitor();
`````

ZwiftMemoryMonitor is an EventEmitter.

You have to listen for the 'ready' event and subsequently call the ```start``` method.

See also src/examples/example.js

## Pattern / signature files

To avoid having to update the dependency just because the pattern/signature changes, fetch the pattern at run-time from

https://cdn.jsdelivr.net/gh/zwfthcks/zwift-memory-monitor@main/build/data/lookup-playerstateHeuristic.json

See src/examples/example-fetch.js

### Deprecation

Previously the example fetched patterns from https://zwfthcks.github.io/data/lookup-playerstate.json. This is now *deprecated* and the GitHub pages will eventually be removed. Please update your code to use the jsDelivr link instead.


## Miscellaneous

### Calculated fields

- ```cadence``` (rpm) is calculated from ````cadence_uHz```` (uHz)
- ````calories```` (kCal) is calculated from ````work```` (mWh)



## Supported

- Node >=18


## Notes

If zwiftapp.exe is elevated (as it typically will be right after an update) your process must also be elevated for openProcess to succeed.



[^1]: The same pattern scanning technique actually works for macOS, with exactly the same memory patterns as for Windows. It would just require a macOS specific memory scanning library to access Zwift memory from node.js.
