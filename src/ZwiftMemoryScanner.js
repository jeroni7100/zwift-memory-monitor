const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('crypto');
const memoryjs = require('memoryjs');

const { numberToPattern } = require('./utils.js')

class ZwiftMemoryScanner {

    constructor(zmm, lookup, options = {}) {

        /** @type {Map} */
        this.zmm = zmm
        this._patternAddressCache = zmm._patternAddressCache
        this._zwift = zmm._zwift
        this.log = zmm.log

        this._lookup = lookup
        this._options = options

        this._type = lookup.type

        // bind this for functions
        this._checkBaseAddress = this._checkBaseAddress.bind(this)
        this._getCachedScan = this._getCachedScan.bind(this)
        this._writeCachedScanFile = this._writeCachedScanFile.bind(this)
        this._readCachedScanFile = this._readCachedScanFile.bind(this)
        this._searchWithrulesSignature = this._searchWithrulesSignature.bind(this)
        this.readPlayerData = this.readPlayerData.bind(this)



        this._started = false
        this._baseaddress = 0
        this._addresses = {}
        this._timeout = null
        this._interval = null
        this._cachedScanFileName = null
        this.lasterror = null
    }

    start() {

        this.log('start', this._lookup.type)

        let forceScan = this._options.forceScan || false;

        const hasPlaceholder = (lookup, placeholder) => {
            return lookup.signatures.some((signature) => {
                // return true if signature.pattern includes placeholder
                // or signature.rules.mustBeVariable includes an element that includes placeholder as 3rd element
                return signature.pattern.includes(placeholder) || signature.rules?.mustBeVariable?.some((mustBeVariable) => {
                    return mustBeVariable[2].includes(placeholder)
                })
            })
        }


        if (hasPlaceholder(this._lookup, '<player>')) {
            this._playerId = this._zwift.getPlayerId() || 0;
            if (!this._playerId) {
                this.lasterror = 'Player ID not found'
                // throw new Error('Player ID not found')
                this.zmm.emit('status.scanner.error', this._type, this.lasterror)
                this.stop()
                return
            }
        }
        if (hasPlaceholder(this._lookup, '<flag>')) {
            this._flagId = this._zwift.getFlagId() || 0;
        }
        if (hasPlaceholder(this._lookup, '<sport>')) {
            this._sportId = this._zwift.getSportId() || 0;
        }
        if (hasPlaceholder(this._lookup, '<world>')) {
            this._worldId = this._zwift.getWorldId() || 0;
        }

        const replacePatternPlaceholders = (text) => {
            return (text ?? '').replace(/<player>/ig, numberToPattern(this._playerId ?? 0)).replace(/<flag>/ig, numberToPattern(this._flagId ?? 0)).replace(/<sport>/ig, numberToPattern(this._sportId ?? 0)).replace(/<world>/ig, numberToPattern(this._worldId ?? 0))
        }
        const replaceValuePlaceholders = (text) => {
            return (text ?? '').replace(/<player>/ig, this._playerId ?? 0).replace(/<flag>/ig, this._flagId ?? 0).replace(/<sport>/ig, this._sportId ?? 0).replace(/<world>/ig, this._worldId ?? 0)
        }

        
        let cachedScan = undefined;

        if (!forceScan) {
            cachedScan = this._getCachedScan()
        }

        if (cachedScan?.baseaddress && !forceScan) {
            this._pattern = cachedScan.pattern
            this._checkBaseAddress(null, cachedScan.baseaddress)
        } else {
            this._lookup.signatures.some((signature) => {

                if (!signature.pattern) return;
                if (!signature.rules) return;

                let pattern = replacePatternPlaceholders(signature.pattern)
                this.log(pattern);
                this._pattern = pattern

                let mustBeVariable = signature?.rules?.mustBeVariable?.map((entry) => {
                    return [entry[0], entry[1], replaceValuePlaceholders(entry[2])]
                }) ?? null;

                let addressOffset = signature?.addressOffset || 0;

                this.lasterror = null

                // rules signature
                let rules = {
                    mustRepeatAt: signature.rules.mustRepeatAt ?? null,
                    mustBeVariable: mustBeVariable ?? [],
                    mustMatch: signature.rules.mustMatch ?? [],
                    mustDiffer: signature.rules.mustDiffer ?? [],
                    mustBeGreaterThanEqual: signature.rules.mustBeGreaterThanEqual ?? null,
                    mustBeLessThanEqual: signature.rules.mustBeLessThanEqual ?? null,
                }

                // search for the pattern in memory
                this._searchWithrulesSignature(this._zwift.process, pattern, rules, addressOffset, this._checkBaseAddress)

                return this._started // will break iteration on first pattern found because this._started is set to true in _checkBaseAddress on success

            })
        }

        return this._started
    }

    /**
     * @param {*} error 
     * @param {*} address 
     */
    /**
     * Internal method. Used as callback to findPattern in .start
     * Verifies the found address by reading first 4 bytes back from memory.
     * Emits status.started on success
     * @param {*} error
     * @param {*} address
     * @fires status.started
     * @memberof ZwiftMemoryMonitor
     */
    _checkBaseAddress(error, address) {
        this.log(error, address)
        if (error && !address) {
            this.lasterror = error
        }

        this._baseaddress = address
        this.log(`base address: 0x${this._baseaddress.toString(16)}`);

        if (this?._baseaddress) {
            // verify by reading back from memory
            const value = memoryjs.readMemory(this._zwift.process.handle, this._baseaddress, memoryjs.UINT32)
            this.log(`value: ${value} = 0x${value.toString(16)}`);

            // if (value != this._playerid) {
            // if (value != this._patternFirst4Bytes) {
            if (!this._pattern.startsWith(numberToPattern(value))) {
                this._baseaddress = 0
                // this.lasterror = 'Could not verify player ID in memory'
                this.lasterror = 'Could not verify pattern in memory'
                this._deleteCachedScanFile()
            } else {
                this._writeCachedScanFile({
                    pattern: this._pattern,

                    processObject: this._zwift.process,
                    baseaddress: this._baseaddress
                })
            }
        }

        if (this?._baseaddress) {
            Object.keys(this._lookup.offsets).forEach((key) => {
                this._addresses[key] = [this._baseaddress + this._lookup.offsets[key][0], this._lookup.offsets[key][1]]
            })

            // this.log(this._addresses)

            this._interval = setInterval(this.readPlayerData, this._options.timeout)
            this._started = true

            this.zmm.emit('status.started', this._type)

        }

        return this._started

    }


    /**
     * Searches for a pattern in memory regions of a process using a rules signature.
     *
     * @param {object} processObject - The process object containing the handle of the target process.
     * @param {string} pattern - The pattern to search for in memory regions.
     * @param {object} rules - The rules object containing the minimum and maximum offset values.
     * @param {number} addressOffset - The offset to be added to the found address.
     * @param {function} callback - The callback function to be called with the found address.
     * @returns {void}
     */
    _searchWithrulesSignature(processObject, pattern, rules, addressOffset, callback) {
        //

        this.log('searchWithrulesSignature', pattern, rules, addressOffset)

        let foundAddresses = [];
        let hexPattern = pattern.split(' ').join('')

        if (this._patternAddressCache.has(hexPattern)) {
            foundAddresses = this._patternAddressCache.get(hexPattern)
        } else {
            const regions = memoryjs.getRegions(processObject.handle);

            // Increased chunk size for fewer reads
            const chunkSize = 1024 * 1024 * 4; // 4MB chunks
            const overlap = hexPattern.length / 2;
            const patternLength = hexPattern.length / 2;

            // Pre-filter regions to only those we care about
            const validRegions = regions.filter(region =>
                !region.szExeFile
                && // Skip executable regions
                region.RegionSize > 0 && // Skip empty regions
                ((region.Protect & 0x02) || (region.Protect & 0x04)) // Only check readable and r/w regions (TODO: Confirm this is correct)
            );

            // Buffer reuse to avoid allocation overhead
            let regionBuffer;

            for (const region of validRegions) {
                // console.log(region.BaseAddress, region.RegionSize, region.AllocationProtect, region.Protect, region.Type, region.State, region.szExeFile)
                // console.log(region)
                let baseAddress = region.BaseAddress;
                const endAddress = region.BaseAddress + region.RegionSize;

                while (baseAddress < endAddress) {
                    const readSize = Math.min(chunkSize, endAddress - baseAddress);

                    try {
                        regionBuffer = memoryjs.readBuffer(processObject.handle, baseAddress, readSize);
                    } catch (e) {
                        // Skip failed reads
                        baseAddress += chunkSize - overlap;
                        continue;
                    }

                    // code by copilot:
                    // let patternIndex = 0;

                    // // Use while loop instead of do-while for better performance
                    // while ((patternIndex = regionBuffer.indexOf(hexPattern, patternIndex, 'hex')) !== -1) {
                    //   const address = baseAddress + patternIndex;

                    //   // Verify pattern at address
                    //   foundAddresses.push(address);

                    //   patternIndex += patternLength;
                    // }
                    // < end of code by copilot

                    // My original code:

                    let patternIndex;
                    let byteOffset = 0;

                    do {
                        patternIndex = regionBuffer.indexOf(hexPattern, byteOffset, 'hex');  // the first occurrence of the pattern (if any)

                        if (patternIndex >= 0) {

                            let readBack = memoryjs.readBuffer(processObject.handle, baseAddress + patternIndex, hexPattern.length / 2).toString('hex')
                            if (readBack == hexPattern) {
                                foundAddresses.push(baseAddress + patternIndex)
                            }
                            byteOffset = patternIndex + patternLength + 1
                        }
                    } while (patternIndex >= 0)

                    // < end of my original code


                    baseAddress += chunkSize - overlap;
                }
            }

        }

        // filter out duplicates and verify that the pattern still is at the found address
        foundAddresses = [...new Set(foundAddresses)].filter((address) => {
            // return hexPattern == memoryjs.readBuffer(processObject.handle, parseInt(address, 16), hexPattern.length / 2).toString('hex')
            return hexPattern == memoryjs.readBuffer(processObject.handle, address, hexPattern.length / 2).toString('hex')
        })

        this._patternAddressCache.set(hexPattern, foundAddresses)

        this.log('FOUND ADDRESSES:', foundAddresses.length)
        // this.log(foundAddresses.map((address) => address.toString(16).toUpperCase()))

        // loop through foundAddresses and calculate the offset between two adjacent elements
        let offsets = new Map();
        let lastAddress = 0;
        foundAddresses.forEach((address) => {
            offsets.set(address, address - lastAddress)
            lastAddress = address;
        })

        // this.log('OFFSETS:')
        // this.log(offsets.map((offset) => address.toString(16).toUpperCase() + ' ' + offset.offset))

        // the wanted address is the one that has offset approx. 120 (8 + 28*4) from the previous one
        let wantedAddress = 0;
        let wantedOffset;

        // offsets.some((offset) => {
        foundAddresses.some((address) => {


            this.log('CHECKING this address:', address)


            let offset = offsets.get(address) ?? 0;

            if (rules.mustRepeatAt) {
                if (!(offset >= (rules.mustRepeatAt.min ?? 0)) && (offset <= (rules.mustRepeatAt.max ?? 0) && offset % 4 == 0)) {
                    this.log('Not the wanted address:', address.toString(16).toUpperCase(), '(failed mustRepeatAt)')
                    return false
                }
            }

            if (rules.mustBeVariable && rules.mustBeVariable?.length > 0) {
                //   mustBeVariable: [
                //     [0x48, 'uint32', '<sport>'], // offset, type, variable
                //     [0x108, 'uint32', '<world>'], // offset, type, variable
                // ],
                // return false if any of the entries in mustBeVariable fails to match

                let isCandidate = rules.mustBeVariable.every((mustBeVariableEntry) => {
                    let offsetToRead = mustBeVariableEntry[0];
                    let type = mustBeVariableEntry[1];
                    let variable = mustBeVariableEntry[2];

                    let readValue = memoryjs.readMemory(processObject.handle, address + offsetToRead, type);
                    return readValue == variable;
                })
                if (!isCandidate) {
                    this.log('Not the wanted address:', address.toString(16).toUpperCase(), '(failed mustBeVariable)')
                    return false;
                }

            }

            if (rules.mustMatch && rules.mustMatch?.length > 0) {

                let match = rules.mustMatch.every((mustMatchEntry) => {
                    return memoryjs.readMemory(processObject.handle, address - offset + mustMatchEntry, memoryjs.UINT32) ==
                        memoryjs.readMemory(processObject.handle, address + mustMatchEntry, memoryjs.UINT32)
                })
                this.log('match = ', match)
                if (!match) {
                    this.log('Not the wanted address:', address.toString(16).toUpperCase())
                    return false;
                }

            }

            if (rules.mustDiffer && rules.mustDiffer?.length > 0) {

                let differ = rules.mustDiffer.every((mustDifferEntry) => {
                    return memoryjs.readMemory(processObject.handle, address - offset + mustDifferEntry, memoryjs.UINT32) !=
                        memoryjs.readMemory(processObject.handle, address + mustDifferEntry, memoryjs.UINT32)
                })
                this.log('differ = ', differ)
                if (!differ) {
                    this.log('Not the wanted address:', address.toString(16).toUpperCase())
                    return false;
                }

            }

            if (rules.mustBeGreaterThanEqual) {

                // mustBeGreaterThanEqual: {
                //   power: [0x34, 'uint32', 0],
                //   heartrate: [0x30, 'uint32', 0]
                // },

                // loop over the mustBeGreaterThanEqual object and check that the value at the address is greater than or equal to the value
                let greaterThanEqual = Object.keys(rules.mustBeGreaterThanEqual).every((key) => {
                    let value = rules.mustBeGreaterThanEqual[key][2];
                    let type = rules.mustBeGreaterThanEqual[key][1];
                    let offsetToRead = rules.mustBeGreaterThanEqual[key][0];

                    let readValue = memoryjs.readMemory(processObject.handle, address + offsetToRead, type);
                    return readValue >= value;
                });
                this.log('greaterThanEqual = ', greaterThanEqual);
                if (!greaterThanEqual) {
                    this.log('Not the wanted address:', address.toString(16).toUpperCase());
                    return false;
                }
            }

            if (rules.mustBeLessThanEqual) {

                // mustBeLessThanEqual: {
                //   power: [0x34, 'uint32', 0],
                //   heartrate: [0x30, 'uint32', 0]
                // },

                // loop over the mustBeLessThanEqual object and check that the value at the address is greater than or equal to the value
                let lessThanEqual = Object.keys(rules.mustBeLessThanEqual).every((key) => {
                    let value = rules.mustBeLessThanEqual[key][2];
                    let type = rules.mustBeLessThanEqual[key][1];
                    let offsetToRead = rules.mustBeLessThanEqual[key][0];

                    let readValue = memoryjs.readMemory(processObject.handle, address + offsetToRead, type);
                    return readValue <= value;
                });
                this.log('lessThanEqual = ', lessThanEqual);
                if (!lessThanEqual) {
                    this.log('Not the wanted address:', address.toString(16).toUpperCase());
                    return false;
                }
            }


            // this.log('ALL CHECKS TRUE for', address)
            this.log('ALL CHECKS TRUE for', address.toString(16).toUpperCase())

            // wantedAddress = parseInt(address, 16);
            wantedAddress = address;
            wantedOffset = offset;
            return true;

        })

        this.log('WANTED ADDRESS and OFFSET:')
        this.log(wantedAddress.toString(16).toUpperCase(), wantedOffset ? `${wantedOffset} ( = 8 + ${(wantedOffset - 8) / 4}*4 )` : '')

        if (wantedAddress) {
            callback(null, wantedAddress + addressOffset)
        }

    }

    /**
     *
     *
     * @fires status.stopped
     * @fires status.retrying
     * @memberof ZwiftMemoryScanner
     */
    stop() {

        // if (!this._ready) return false;

        this._started = false

        if (this?._timeout) {
            clearTimeout(this._timeout)
            this._timeout = null
        }
        if (this?._interval) {
            clearInterval(this._interval)
            this._interval = null
        }


        this.zmm.emit('status.scanner.stopped', this._type)

    }

    /**
     *
     * @fires playerData
     * @fires status.stopping
     * @memberof ZwiftMemoryScanner
     */
    readPlayerData() {

        var playerData = {}

        if (this._started) {
            try {
                Object.keys(this._lookup.offsets).forEach((key) => {
                    playerData[key] = memoryjs.readMemory(this?._zwift.process?.handle, this._addresses[key][0], this._addresses[key][1])
                })

                // verify by reading player id back from memory
                // if (this._playerid != memoryjs.readMemory(this._zwift.process.handle, this._baseaddress, memoryjs.UINT32)) {
                if (!this._pattern.startsWith(numberToPattern(memoryjs.readMemory(this._zwift.process.handle, this._baseaddress, memoryjs.UINT32)))) {
                    // Probably because Zwift was closed...
                    this.lasterror = 'Could not verify pattern in memory'
                    throw new Error(this.lasterror)
                }

                // if playerData has both f19 and f20, then we have a valid playerData object
                if ((playerData.f19 ?? undefined) != undefined && (playerData.f20 ?? undefined) != undefined) {
                    this.extendPlayerStateData(playerData)
                }
                // if playerData has flag and age, then we have a valid playerData object
                if ((playerData.flag ?? undefined) != undefined && (playerData.age ?? undefined) != undefined) {
                    this.extendPlayerProfileData(playerData)
                }

                playerData.packetInfo = {
                    source: 'zmm',
                    type: this._type
                }

                this.zmm.emit('data', playerData)

            } catch (e) {
                // 
                this.log(e)

                this.zmm.emit('status.scanner.error', this._type, error.message)
                this.stop()
            }

        }
    }


    extendPlayerStateData(playerData) {
        //


        if (playerData?.cadence_uHz >= 0) {
            playerData.cadence = Math.round(playerData?.cadence_uHz / 1000000 * 60)
        }

        if (playerData?.work >= 0) {
            playerData.calories = Math.round(playerData?.work * 3600 / 1000 / 4.184 / 0.25 / 1000)
        }

        if (playerData?.roadtime >= 0) {
            playerData.roadtime = (playerData?.roadtime - 5_000) / 1_000_000
        }


        playerData.powerMeter = (playerData.f19 & 0x1) ? true : false;
        playerData.companionApp = (playerData.f19 & 0x2) ? true : false;
        playerData.forward = (playerData.f19 & 0x4) ? true : false;
        playerData.uTurn = (playerData.f19 & 0x8) ? true : false;

        playerData.rideons = (playerData.f19 >> 24) & 0xFF;

        playerData.roadId = (playerData.f20 >> 8) & 0xFFFF;
        playerData.isPortalRoad = (playerData.roadId >= 10000) || false;

        playerData.gradientScalePct = 50 + playerData.gradientScale * 25;


        playerData.units = {
            distance: 'm',
            elevation: 'm',
            speed: 'mm/h',
            power: 'W',
            heartrate: 'bpm',
            cadence: 'rpm',
            calories: 'kcal',
        }

    }


    extendPlayerProfileData(playerData) {
        //

        playerData.units = {
            height: 'cm',
            maxhr: 'bpm',
        }

    }



    /**
     * Get a cached scan object if it exists and matches the currently running Zwift process
     *
     * @return {*} 
     * @memberof ZwiftMemoryMonitor
     */
    _getCachedScan() {
        let cachedScan = undefined

        cachedScan = this._readCachedScanFile()

        if (cachedScan) {
            // compare with the current Zwift process object:
            if ((this._zwift.process.th32ProcessID !== cachedScan?.processObject?.th32ProcessID) ||
                (this._zwift.process.th32ParentProcessID !== cachedScan?.processObject?.th32ParentProcessID) ||
                (this._zwift.process.szExeFile !== cachedScan?.processObject?.szExeFile)) {
                // Cached scan is not for the current process object so ignore and delete it
                cachedScan = null
                this._deleteCachedScanFile()
            }
        }

        return cachedScan
    }

    /**
     * Delete cached scan file in temp folder
     *
     * @memberof ZwiftMemoryMonitor
     */
    _deleteCachedScanFile() {
        try {
            fs.rmSync(this._getCachedScanFileName())
        } catch (e) { }
    }


    /**
     * Write object to cached scan file in temp folder
     *
     * @param {*} cachedScan
     * @memberof ZwiftMemoryMonitor
     */
    _writeCachedScanFile(cachedScan) {
        try {
            fs.writeFileSync(this._getCachedScanFileName(), JSON.stringify(cachedScan))
        } catch (e) {
            // delete cache in case of any error during write
            this._deleteCachedScanFile()
        }
    }



    /**
     * Read cached scan file from temp folder and return the saved object if found.
     * In case of errors, the cache file will be deleted.
     *
     * @return 
     * @memberof ZwiftMemoryMonitor
     */
    _readCachedScanFile() {

        let cachedScan = undefined

        if (fs.existsSync(this._getCachedScanFileName())) {
            try {
                cachedScan = JSON.parse(fs.readFileSync(this._getCachedScanFileName(), 'utf8') || '{}')
            } catch (e) {
                cachedScan = null
                // this._deleteCachedScanFile()
                this._deleteCachedScanFile()
            }

        }

        return cachedScan
    }

    /**
     *
     * @return 
     * @memberof ZwiftMemoryMonitor
     */
    _getCachedScanFileName() {

        if (!this._cachedScanFileName) {
            // console.log('must find cache filename')
            // const crypto = require('crypto');
            // console.log('required crypto')

            // Creating Hash
            const hash = crypto.createHash('sha256');
            // console.log('has defined hash')
            // Use the combination of lookup, offsets, and signature to obtain a hash value for the cache name
            // hash.update(JSON.stringify([this?._options?.lookup, this?._options?.offsets,this?._options?.signature]));
            hash.update(JSON.stringify(this?._lookup));
            // console.log('has updated hash')
            const suffix = hash.digest().toString('hex')
            // console.log('got suffix',suffix)

            this._cachedScanFileName = path.join(os.tmpdir(), `zwift-memory-monitor_${suffix}`)
            this.log('Cache file:', this._cachedScanFileName)
        }

        return this._cachedScanFileName
    }

}

module.exports = ZwiftMemoryScanner;