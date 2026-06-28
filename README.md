# PX-init.js-deobf
Deobfuscator for PerimeterX's init.js file using babel.

> Disclaimer: This is published for security research and education.
> It makes an already public, client delivered script readable.
> Studying how anti-bot products work is part of how security improves.
> Use it only on code you are **authorized** to analyze, and respect the terms of any service you test.
>
> Not affiliated with HUMAN Security / PerimeterX. Rights holders or other authorized parties who want this removed can contact me and I'll take it down promptly.

## Which PX build this targets

I reverse engineered this against the Human branded sensor whose obfuscation uses:

- `basE91 string tables`: A big `hD[]` array decoded by `hE()` and `with(state) switch(sum)` control flow flattening.

A quick check to see if it's the right vers:
```
grep -c '8191 & c' init.js   (>0 -> basE91 tables present)
grep -c 'with ('   init.js   (>0 -> with/switch flattening)
```

## Usage
```
node pxclean.js init.js out.js --report
```
Dependencies: 
```
npm i @babel/parser @babel/traverse @babel/generator @babel/types
```

The output is for reading/analysis, not for re-running on the site (pre sure PX self checks its own source). It's guaranteed to be valid syntax wise, the tool reparses the result and aborts without writing if anything is malformed.

## Write-up
I had AI help me with a few things, specifically with the flattening. I haven't seen anyone post a deobf for the init yet so I thought I'd give it a crack. 

PX hides a functions logic inside a dispatcher loop. The "program counter" is the sum of 2-4 accumulator variables. Each switch case is a basic block that does some work, then adds constants to the accumulators to pick the next block, and break's back to the loop:
```js
function hI() {
  for (var …, hA = UF[0], hI = UF[1], hK = …; hA + hI !== 234; )  // (234 = terminal PC)
    with (hK.ci || hK)                                            // (exposes the state object)
      switch (hA + hI) {                                          // (PC = hA + hI)
        case hI - -58:  …work…; hA += -329, hI += 368; break;     // (next block)
        case -157:      …work…; hI += 233;                        // (falls through to next PC)
        case hA - -347: default: return …;                        // (terminal block)
      }
}
var hK = hI(58, -254);                                            // (initial accumulators)
```
Three things make this hard to read:

- The block order is **scrambled**: You can't tell what runs after what without doign the accumulator arithmetic.
- Case labels can be computed: (`case hA - -347:`), so which case matches depends on the accumulator values at that moment.
- String lookups are **dynamic**: Inside a block you see `hF[hE(hA + 403)]` instead of `hF["length"]` because the index `hA + 403` is only known once you know `hA` at that block.

### `hD` and why it can't be fully eliminated statically
The main goal behind the un-flattening was to resolve every `hE(..)` call so the `hD` string table (and its decoder) become unreferenced and the dead code elimination can delete them. That worked for the codec but 6 dynamic `hE` calls remain unresolved so `hD` stays.

Those 6 calls live in data gated blocks that static execution can't reach.

They're not in the straight line codec, they're inside:
- event-handler cleanup loops: e.g. `removeEventListener` loops at L2810/L4523 that only run after a specific detection event has fired and stashed state, and
- ambiguous loops: (L5238, L5967) where the surrounding control blow branches on runtime data.

To reach those blocks the symbolic executor would have to know things that only exist at runtime:

- whether a detection actually trigered
- what the event object/dom state contains
- how many iteration a data driven loop runs

When the execuotr hits one of those branches it marks the relevent accumulator TOP and refuses to follow it or to guess an index. Guessing would be worse than leaving it, inlining a wrong string would corrupt the analysis. So the tool stops at the boundary of what is provable from the source alone.

Static reasoning gets you the entire payload codec and roughly 79% of the dynamic string indices, the remaining 21% are control flow reachable only with live runtime data, so closing the gap on `hD` requires running the script and extracting the values during execution.
