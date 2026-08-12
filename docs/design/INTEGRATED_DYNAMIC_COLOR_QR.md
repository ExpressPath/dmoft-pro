# Prism Native Full-Field Dynamic Optical Profile

Status: implemented experimental browser profile (`PRISM-FIELD-NATIVE-R3`)

This profile is a native optical physical layer. It is not a QR Code, Micro QR
Code, or a QR-compatible color extension. It uses the complete displayed
rectangle as one dynamic multicolor code:

```text
touching multicolor data cells
+ distributed geometry/phase/color pilot sequences
+ distributed protected control bytes
+ inner Cauchy-MDS repair
+ RFC 6330 RaptorQ outer repair
```

The browser lab verifies frame structure, MDS recovery, CRC32, and reconstructed
test-object CRC32. Production file output must additionally authenticate the
receiver-bound encrypted container and every AEAD chunk before saving data.

## 1. Optimization target

The operating profile is

```text
theta = (outerShape, outerAspect, lattice, cellRegion, nx, ny, M, palette, fps, mask, innerRate, outerOverhead,
         pilotAmplitude, equalizer, acquisitionPolicy)
```

and the engineering target is

```text
theta* = arg max E[correctly reconstructed and authenticated bytes]
                   ------------------------------------------------
                         displayed area * capture time
```

Raw bits per cell are not optimized independently. A larger constellation is
selected only when its measured mutual information, frame acceptance, and
processing rate produce greater verified throughput:

```text
score(profile)
  = mutualInformationBits
  * frameAcceptance
  * processingFPS
  * innerCodeRate
```

The initial automatic bootstrap is C8 at 6 logical FPS. Bidirectional feedback
can later select C16, C24, C32, and a faster cadence from measured receiver
statistics.

## 2. Full-field geometry

The outer silhouette, display aspect, sample-center lattice, and visible cell
region are separate choices. The reference canvas is 960 x 624, contains exactly
2,040 protected cells, and reserves no finder, timing, quiet-zone, header,
calibration, or physical-gap cells.

For a single field inside a rectangular display/camera bounding box, the
bounding-box fill fractions are:

```text
rectangle       1.0000
ellipse          pi/4 = 0.7854
regular hexagon  3/4  = 0.7500
diamond          1/2  = 0.5000
```

Therefore a rectangle remains the area-optimal outer silhouette. Hexagons are
used for the internal Voronoi cells, not for the outer boundary. Replacing the
outer rectangle with a circle or hexagon would discard 21.5% or 25% of the
available screen before channel errors are considered.

If a field with aspect `a` is fitted into a viewport with aspect `r`, its
maximum framing utilization is

```text
U(a,r) = min(a/r, r/a).
```

For a 16:9 sender and a 4:3 receiver, the aspect that equalizes the two framing
losses is the geometric mean

```text
a* = sqrt((16/9)(4/3)) = 1.53960...
```

The implemented 960:624 ratio is `20/13 = 1.53846`, within 0.08% of that target.
It retains more than 86% framing utilization at both 16:9 and 4:3, instead of
optimizing one device while forcing the other down to 75%.

| Geometry | Sample-center lattice | Natural visible region | Nominal rows | Reference minimum center distance |
| --- | --- | --- | ---: | ---: |
| `TRI49` (default) | clipped affine-triangular | nearest-center hexagonal Voronoi | 42 | 17.6 px |
| `TRI57` (wide fallback) | clipped affine-triangular | nearest-center hexagonal Voronoi | 36 | 16.55 px |
| `SQ60` (fallback) | 60 x 34 rectangular | nearest-center square Voronoi | 34 | 16.00 px |

`TRI49` uses 49 centers on each even row and 48 on each odd row. Three selected
odd rows contain one additional alternating boundary center, giving exactly

```text
21 * 49 + 21 * 48 + 3 = 2,040 cells.
```

Before the affine fit to the display rectangle, adjacent triangular-lattice
centers are separated by one unit and consecutive rows by `sqrt(3)/2`. The
natural nearest-center partition is therefore hexagonal. At the 960 x 624
reference size, the balanced `TRI49` fit increases the worst-case adjacent-center
distance by about 10% over `SQ60` while keeping the protected byte envelope
identical. This is an optical-separation gain, not a fabricated payload gain.

The renderer assigns every output pixel to its nearest actual center. Boundary
cells are clipped against the display rectangle, so coverage is exactly 100%
with no inter-cell gaps even where a boundary lattice point is intentionally
omitted. `SQ60` remains available because small integer raster modules or
anisotropic camera blur can make a square lattice faster in practice.

Geometry selection uses measured channel results rather than multiplying by a
theoretical packing factor:

```text
score(geometry)
  = meanCellMutualInformationBits
  * frameAcceptance
  * processingFPS
```

Minimum center distance is only a deterministic tie-breaker. Its effect should
already be present in measured mutual information and acceptance, so counting it
again would exaggerate the gain.

This eliminates permanent spatial overhead, but moves acquisition burden into
signal processing. The old C16 experiment used 1,230 protected color cells in a
2,025-module-pitch footprint. The new C16 field uses 2,040 protected color cells
in 2,040 pitches:

```text
protected-symbol gain = 2040 / 1230 = 1.6585

verified source-density gain
  = (808 / 2040) / (480 / 2025)
  = 1.6638
```

These are packing ratios, not measured handheld throughput.

## 3. Superimposed distributed pilots

No cell is dedicated to calibration. For physical cell `i`, frame phase `p`,
payload state `s`, and nominal palette color `C_s`, the renderer computes

```text
Y(i,p,s) = clamp(
  C_s
  + 7 * g(i,p) * [1, 1, 1]
  + 3 * t(i,p) * [1,-1, 1]
  + 3 * [r(i,p), q(i,p), b(i,p)]
)
```

where `g`, `t`, `r`, `q`, and `b` are deterministic balanced PRBS signs in
`{-1,+1}` derived from cell index, phase, and channel identifier. The terms
serve different estimators:

- `g`: border geometry, orientation, and sub-cell grid correlation;
- `t`: frame phase and temporal continuity;
- `r/q/b`: per-channel color response and white-balance refinement.

The pilot is an additive perturbation of every payload color. It never replaces
the protected payload symbol. Sixteen phase sequences allow a receiver to join
at any visible frame without waiting for a beacon or animation restart.

The R3 robust bootstrap holds each logical frame for about 167 ms (6 FPS). A
30 FPS camera can therefore observe several exposures per logical frame, which
reduces the fraction intersecting a display transition or rolling-shutter seam.
Higher cadence is an adaptive mode and must be justified by measured accepted
throughput, not configured merely to raise the displayed FPS number.

## 4. Borderless acquisition

The reader does not call `BarcodeDetector`, `jsQR`, or a QR finder scanner.

1. Build a coarse field-evidence map from local chroma and color gradients.
2. Accept the camera bounds only when field evidence independently touches all
   four image edges. Otherwise bin evidence in both axes and robustly fit top,
   bottom, left, and right boundary lines.
3. Intersect the fitted lines to form a coarse quadrilateral. Camera aspect ratio
   is never accepted as field-boundary evidence.
4. Evaluate `TRI49`, `TRI57`, and `SQ60`, all eight dihedral orientations, and bounded
   scale hypotheses.
5. Remove the likely payload component by nearest-palette blind clustering.
6. Correlate the residual signal against all sixteen geometry/phase PRBS
   sequences.
7. Shortlist geometry/orientation/phase candidates with the broad C16 reference,
   then re-score the best 24 with C8, C16, C24, and C32 palette models. The
   wider shortlist prevents a third geometry from displacing the correct
   high-order-color candidate before profile-specific scoring.
8. Refine each corner by coordinate descent over decreasing sub-cell offsets.
9. Reject correlation below `0.028` or resolution below `3.2 px/cell`.

For a tracked quadrilateral, only phase correlation is repeated on the selected
lattice. Geometry is
reused for no more than two processed frames and 240 ms. A geometry or sampling
failure invalidates the track.

Because a borderless edge estimate can be a fraction of a cell inward, the
decoder evaluates a bounded set of uniform-scale and single-corner lattice
hypotheses. MDS, distributed control validation, and CRC32 select the unique
valid hypothesis. Geometry is never selected solely because it produced
plausible colors.

## 5. Adaptive color modulation

All palettes include black and white as data states.

| Profile | States | Information/cell | Inner layout | Protected packet | RaptorQ envelope | Source symbol |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| C8 | 8 | 3 bits | 3 x `[255,213]` | 639 B | 596 B | 592 B |
| C16 | 16 | 4 bits | 4 x `[255,213]` | 852 B | 812 B | 808 B |
| C24 | 24 | 4.585 theoretical | 5 x `[229,191]` | 955 B | 916 B | 912 B |
| C32 | 32 | 5 bits | 5 x `[255,213]` | 1,065 B | 1,028 B | 1,024 B |

The four-byte difference between a RaptorQ envelope and source symbol is its
Payload ID. RFC 6330 source symbols are kept eight-byte aligned; the remaining
1–7 bytes in the optical packet are protected zero padding. Each protected
packet also contains a 32-byte distributed control record and a four-byte frame
CRC32.

### 5.1 C24 grouped radix packing

Twenty-four is not a power of two. Treating it as five bits would be incorrect,
while limiting it to four bits would waste eight states. The implementation uses
local radix groups:

```text
16 base-24 cells carry 9 binary bytes
8 base-24 cells carry 4 binary bytes

127 * 16 + 8 = 2,040 cells
127 * 9  + 4 = 1,147-byte radix capacity
```

The C24 MDS codeword uses 1,145 bytes and zero-pads the remaining two radix
bytes. Conversion is performed independently per group with `BigInt`, so a
missing color digit marks at most nine bytes as erasures. It cannot propagate a
carry error across the entire frame.

## 6. Blind color calibration and soft decisions

The reader never compares pixels directly with fixed RGB constants.

1. Sample a bounded central kernel according to observed cell pitch: one pixel
   below 8 px/cell, 3 x 3 at 8--18 px/cell, and 5 x 5 above 18 px/cell.
2. Estimate channel low/high quantiles from all 2,040 samples and obtain a
   diagonal bootstrap transform.
3. Classify against the phase-specific dithered constellation.
4. Keep the best and second-best distances.
5. Select the most reliable 55% of decisions and fit a full 3 x 3 color mixing
   matrix plus offset by regularized least squares:

   ```text
   observed_RGB = A(3x3) * nominal_RGB + offset_RGB
   ```

6. Reclassify the full field. If the full transform overfits, retry the diagonal
   bootstrap model; MDS and CRC32 choose the valid candidate.

For distances `d1 <= d2`, confidence and reliability are

```text
confidence  = (d2 - d1) / max(6, d2)
reliability = max(0, confidence) / (1 + d1/48)
```

A cell becomes an erasure when confidence is below the active threshold or the
best camera-space distance exceeds 82. Known erasures are preferable to silent
substitutions.

## 7. Computational deblurring for touching cells

The central kernel remains below the cell inradius so it suppresses sensor
subpixel, demosaicing, and moire noise without intentionally crossing a cell
edge. At low observed resolution, the receiver applies a bounded first-order
inverse of nearest-neighbor leakage:

```text
x_hat(i) = y(i) + lambda * (y(i) - mean(neighbors(i)))

lambda = 0.12,  observed pitch < 6 px
lambda = 0.06,  observed pitch < 9 px
lambda = 0,     otherwise
```

This is deliberately bounded; a future measured PSF estimator can replace it
without changing the packet layer.

## 8. Distributed control and inner FEC

The 32-byte control record contains:

```text
magic, version, profile, geometry, phase, mask,
session nonce, sequence,
RaptorQ packet length, object length, object CRC32,
palette size, stripe count, field columns, field rows
```

It is inside the same MDS-protected and spatially interleaved field as the
payload. There is no permanent header region on screen.

Each stripe uses a systematic Cauchy MDS code over `GF(2^8)`:

```text
G = [I_k ; C]
C[r,c] = 1 / (x_r + y_c)
```

with primitive polynomial `0x11d`. The decoder recovers known byte erasures,
recomputes parity, and then validates control structure and CRC32. When hard
color decisions fail, bytes are ranked by cell reliability and retried at
bounded erasure depths:

```text
{0, 1, 2, 4, 8, 12, 20, 28, budget}
```

Only a candidate whose MDS stripes, embedded mask, phase, profile, geometry,
nominal dimensions, and CRC32 all agree is accepted.

## 9. Interleaving and reversible masks

The complete codeword is hash-interleaved over the selected 2,040-cell geometry. Consecutive
header, payload, and parity bytes therefore do not form one glare-sensitive
region.

Every frame evaluates sixteen reversible masks. Candidate score includes:

```text
sum spatial RGB separation
+ 0.24 * sum temporal RGB separation
- 180 * same-state adjacency
```

The receiver can infer the selected mask by trying inverse masks and requiring
MDS plus CRC agreement. The mask ID is also protected in distributed control,
so conflicting candidates are rejected.

## 10. RFC 6330 RaptorQ outer repair

The implementation uses the Apache-2.0 `raptorq` WebAssembly codec implementing
RFC 6330. The `.wasm` module is served locally by the same web application.

For the lab object, each profile uses eight source symbols. The sender first
emits systematic packets and then repair packets. Every serialized Encoding
Packet is placed unchanged in the inner protected packet. The receiver accepts
packets out of order, ignores duplicate `(sourceBlock, encodingSymbolId)` pairs,
and reconstructs as soon as the RaptorQ decoder has sufficient rank.

This replaces the earlier custom XF1/XOR outer code. There is no required first
frame and no stream restart dependency.

## 11. Implemented verification

Automated tests cover:

- exact 2,040-cell square and affine-triangular geometries with full-pixel
  Voronoi coverage and zero reserved cells;
- C8, C16, C24, and C32 direct blind decode;
- grouped radix-24 reversibility and local erasure propagation;
- sixteen reversible masks;
- MDS erasure recovery and reliability-guided hard-substitution recovery;
- distributed phase acquisition without finder/timing patterns;
- dedicated geometry correlation and decoding for `TRI49`, `TRI57`, and `SQ60`;
- display/camera channel gain and offset;
- non-integer camera resampling, blur, RGB channel mixing, chromatic displacement,
  lens shading, and sensor noise;
- same-aspect projected fields, ensuring camera-frame aspect is not mistaken for
  the actual optical-field boundary;
- wider camera framing, 90-degree rotation, mild blur, and projective warp;
- real RFC 6330 reconstruction after systematic loss and packet reordering;
- frame and reconstructed-object CRC32 validation.

Still required before a production performance or security claim:

- physical iOS/Android/OLED/LCD benchmark matrix;
- rolling-shutter/display-refresh phase estimation on real hardware;
- glare, occlusion, autofocus, exposure, and motion measurements;
- receiver feedback and measured profile upgrades/downgrades;
- authenticated encrypted-container integration in this browser lab;
- independent protocol, cryptographic, and implementation review.
