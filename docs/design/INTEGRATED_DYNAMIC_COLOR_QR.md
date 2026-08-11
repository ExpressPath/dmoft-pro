# Integrated Dynamic Color QR Profile

Status: experimental browser profile (`PRISM-C8-QR-INTEGRATED1`)

## Non-negotiable geometry

The optical symbol is one square QR-family matrix. It is not a monochrome QR
placed beside a separate color payload panel. Geometry, bootstrap control,
calibration, and dynamic payload all occupy the same 57 × 57 module matrix.

The implementation preserves these QR mechanisms without approximation:

- four-module quiet zone;
- three finder patterns and separators;
- timing patterns;
- Version 10 alignment patterns;
- format and version information;
- QR mask selection;
- Reed–Solomon error correction level H for the bootstrap luminance plane;
- perspective recovery from the detected QR corners.

Every QR functional module remains pure black or pure white. Non-functional
data modules carry both the ordinary QR luminance bit and a dynamic chroma
symbol.

## Dual-use module encoding

Each data module has an underlying QR bit `b` and a two-bit dynamic chroma
symbol `s`.

```text
b = DARK  -> s selects black, red, dark green, or blue
b = LIGHT -> s selects white, yellow, cyan, or magenta
```

The active display palette is:

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
decoder extracts two additional chroma bits from each eligible module.

Black and white are therefore active data states and camera references. They
are not an external strip or decorative border.

## Encoder

For every displayed frame:

1. Build a self-describing 256-byte dynamic frame packet.
2. Generate a same-origin reader URL containing session, sequence, and chroma
   mask identifiers.
3. Encode that URL as a fixed Version 10/H QR matrix.
4. Preserve all QR-reserved modules as pure black or white.
5. Inside each usable 8 × 8 tile, select four dark and four light QR data
   modules as deterministic local palette pilots when the tile contains enough
   candidates.
6. Spatially interleave two packet copies across the remaining QR data modules.
7. Constrain every two-bit payload symbol to the quartet allowed by its
   underlying QR luminance bit.
8. Evaluate all 16 reversible chroma masks.
9. Choose the mask with the best CIE Lab neighbor separation, lowest same-color
   adjacency, best within-class color balance, and useful temporal separation
   from the preceding frame.
10. Render every module at full pitch with integer pixel boundaries. Do not add
    an external color panel or per-cell white gap.

Full-pitch modules maximize area use. Readability is recovered through the QR
luminance constraint, pure monochrome function patterns, palette separation,
mask optimization, center sampling, local pilots, erasures, and FEC rather than
through unused space between cells.

## Decoder

For every camera image:

1. Decode the integrated symbol as an ordinary QR luminance image.
2. Validate the same-origin bootstrap URL and recover session, sequence, and
   chroma mask identifiers.
3. Recreate the exact Version 10/H module matrix from the decoded URL.
4. Use the detected QR corners to compute a projective homography.
5. Sample the centers of deterministic pilot and payload modules.
6. Estimate all eight camera-space color distributions globally and refine
   them per calibrated tile.
7. Classify payload modules by Mahalanobis distance.
8. Convert low-confidence observations to erasures.
9. Also erase any color whose dark/light class contradicts the underlying QR
   bit. Never force that contradiction into a payload symbol.
10. Reverse the chroma mask and spatial interleaving.
11. Accept only packet copies with a valid frame CRC32.
12. Feed valid systematic or repair equations to the outer decoder.
13. Reconstruct and verify the complete object CRC32 after rank reaches eight.

## Current laboratory capacity

- QR matrix: 57 × 57 modules (Version 10)
- Chroma information: 2 bits per eligible data module
- Dynamic frame packet: 256 bytes
- Packet copies per optical frame: 2
- Outer source symbol: 192 bytes
- Source symbols per test object: 8
- Test object: 1,536 bytes
- Target display rate: 8 FPS

The exact number of pilot and payload modules changes slightly with the QR
bootstrap bits, but frame construction must always prove capacity for both
packet copies before rendering.

## Error-correction boundary

The bootstrap luminance plane uses standard QR level-H Reed–Solomon protection.
The current browser payload prototype uses two interleaved CRC-protected packet
copies as its inner protection and a startless systematic GF(2) XOR repair
stream as its outer protection. It must not be described as RaptorQ.

Production standardization still requires a real inner Reed–Solomon profile,
physical-device benchmarking, calibrated acceptance thresholds, and a reviewed
fountain or RaptorQ implementation.
