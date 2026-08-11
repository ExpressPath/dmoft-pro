# Integrated Dynamic Color QR Profile

Status: experimental browser profile (`PRISM-C8-QR-MICROTECH2`)

## Standards boundary

This is a **Micro QR-derived QR-family profile**, not a standards-compliant
Micro QR symbol. Standard Micro QR uses one finder, an 11 × 11 through 17 × 17
matrix, and a two-module quiet zone. Its largest M4/L binary payload is only 15
bytes, so replacing the dynamic frame with an actual M1-M4 symbol would reduce
rather than increase authenticated throughput.

The profile therefore borrows the space-saving mechanisms that are compatible
with this use case:

- a two-module quiet zone instead of the normal QR four-module quiet zone;
- compact global calibration plus two local luminance anchors per usable tile;
- dense full-pitch data modules with no separate color panel or calibration
  strip.

It deliberately retains the Version 10 three-finder geometry so an ordinary
phone QR reader can discover and open the receiver URL from the same displayed
symbol. Calling this profile "Micro QR compliant" would be incorrect.

References:

- [DENSO WAVE: Micro QR Code](https://www.qrcode.com/en/codes/microqr.html)
- [DENSO WAVE: QR Code versions](https://www.qrcode.com/en/about/version.html)
- [DENSO WAVE: QR quiet-zone guidance](https://www.qrcode.com/en/howto/code.html/index.html)

## Integrated geometry

The optical symbol is one square QR-family matrix. It is not a monochrome QR
placed beside a separate color payload panel. Geometry, bootstrap control,
calibration, and dynamic payload all occupy the same 57 × 57 module matrix.

The implementation preserves these QR mechanisms:

- three finder patterns and separators;
- timing patterns;
- Version 10 alignment patterns;
- format and version information;
- QR mask selection;
- Reed-Solomon error correction level H for the bootstrap luminance plane;
- perspective recovery from the detected QR corners.

Every QR functional module remains pure black or pure white. Non-functional
data modules carry both the ordinary QR luminance bit and a dynamic chroma
symbol.

The two-module experimental margin changes the total symbol footprint from
65 × 65 to 61 × 61 pitches while leaving the 57 × 57 carrier unchanged:

```text
area-efficiency gain = (65 / 61)^2 = 1.1353, or +13.5%
```

This reduced margin is valid Micro QR technology, but it is not the standard
margin for a regular Version 10 QR. Cross-device recognition must therefore be
benchmarked; the sender also performs a browser luminance self-test before
declaring the frame healthy.

## Dual-use module encoding

Each data module has an underlying QR bit `b` and a two-bit dynamic chroma
symbol `s`.

```text
b = DARK  -> s selects black, red, dark green, or blue
b = LIGHT -> s selects white, yellow, cyan, or magenta
```

| State | RGB | QR luminance class | Role |
| ---: | --- | --- | --- |
| 0 | `(0, 0, 0)` | dark | payload, black reference |
| 1 | `(195, 20, 25)` | dark | payload |
| 2 | `(0, 115, 45)` | dark | payload |
| 3 | `(25, 55, 190)` | dark | payload |
| 4 | `(255, 255, 255)` | light | payload, white reference |
| 5 | `(250, 225, 20)` | light | payload |
| 6 | `(35, 215, 225)` | light | payload |
| 7 | `(245, 135, 225)` | light | payload |

The dark and light quartets are separated by a required luminance margin. A
camera can threshold the same modules as an ordinary QR code while the custom
decoder extracts two additional chroma bits from each eligible module. Black
and white are active data states and optical references.

## Compact calibration allocation

The earlier profile spent eight pilots in every eligible 8 × 8 tile. This
profile separates global classification from local illumination correction:

1. Place four spatially interleaved observations for each of the eight palette
   states: 32 global pilots total.
2. In each tile that has both luminance classes, reserve one black and one white
   local anchor.
3. Estimate the full eight-state camera-space model from global pilots.
4. Fit per-channel gain and offset from each tile's black/white anchors and
   transform the global model into the local model.
5. Fall back to the global model if a tile cannot place both anchors.

The local model therefore costs two modules per calibrated tile rather than
eight. This is the main in-matrix capacity recovery in `MICROTECH2`.

## Encoder

For every displayed frame:

1. Build a self-describing 320-byte dynamic frame packet with a 256-byte source
   symbol and CRC32.
2. Generate a same-origin reader URL containing session, sequence, and chroma
   mask identifiers.
3. Encode that URL as a fixed Version 10/H QR luminance matrix.
4. Preserve all QR-reserved modules as pure black or white.
5. Allocate the compact global and local pilots.
6. Spatially interleave two complete packet copies across the remaining data
   modules.
7. Constrain every two-bit payload symbol to the quartet allowed by its
   underlying QR luminance bit.
8. Evaluate all 16 reversible chroma masks.
9. Choose the mask with the best CIE Lab neighbor separation, lowest same-color
   adjacency, best within-class color balance, and useful temporal separation.
10. Render every module at full pitch with integer pixel boundaries.

## Decoder

For every camera image:

1. Decode the integrated symbol as an ordinary QR luminance image.
2. Validate the same-origin bootstrap URL and recover session, sequence, and
   chroma mask identifiers.
3. Recreate the exact Version 10/H module matrix from that URL.
4. Use the detected corners to compute a projective homography.
5. Sample global pilots, local anchors, and payload module centers.
6. Estimate the eight camera-space distributions globally.
7. Apply black/white per-tile gain and offset corrections.
8. Classify payload modules by Mahalanobis distance.
9. Convert low-confidence observations and luminance contradictions to
   erasures.
10. Reverse the chroma mask and spatial interleaving.
11. Accept only packet copies with a valid frame CRC32.
12. Feed valid systematic or repair equations to the outer decoder.
13. Reconstruct and verify the complete object CRC32 after rank reaches eight.

## Current laboratory capacity

- QR carrier: Version 10/H, 57 × 57 modules
- Rendered footprint: 61 × 61 pitches including two-module margin
- Chroma information: 2 bits per eligible data module
- Dynamic frame packet: 320 bytes
- Packet copies per optical frame: 2
- Outer source symbol: 256 bytes
- Source symbols per test object: 8
- Test object: 2,048 bytes
- Target display rate: 8 FPS
- Object-capacity increase over `INTEGRATED1`: 33.3%
- Symbol-footprint efficiency increase from the margin alone: 13.5%

Frame construction proves that both packet copies fit before rendering. The
exact pilot and payload count may change slightly with bootstrap QR bits.

## Error-correction boundary

The bootstrap luminance plane uses standard QR level-H Reed-Solomon protection.
The current browser payload prototype uses two interleaved CRC-protected packet
copies as inner protection and a startless systematic GF(2) XOR repair stream
as outer protection. It must not be described as RaptorQ.

Production standardization still requires a real erasure-aware inner
Reed-Solomon profile, physical-device benchmarking of the reduced margin,
calibrated acceptance thresholds, and a reviewed fountain or RaptorQ
implementation.
