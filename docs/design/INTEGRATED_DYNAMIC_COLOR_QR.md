# Prism C16 Custom Dynamic Optical Profile

Status: implemented experimental browser profile (`PRISM-C16-CUSTOM-R1`)

This profile intentionally does **not** preserve ISO QR or Micro QR reader
compatibility. It keeps proven QR-family ideas—finder ratios, timing references,
quiet-zone isolation, masking, interleaving, and erasure-oriented decoding—but
uses the complete integrated symbol as a custom dynamic 16-state optical PHY.

The implemented objective is

```text
eta(theta | z)
  = E[authenticated or CRC-verified source bytes]
    / (display area * capture time)
```

The browser lab currently verifies frames and the reconstructed test object
with CRC32. It does not yet claim cryptographic authentication; a production
DMOFT container must add receiver-bound encryption and AEAD before final output.

## 1. Design constraints

The encoder and reader jointly enforce these invariants:

1. one square optical symbol, not a QR plus a separate color panel;
2. black and white are payload states, not only control colors;
3. all sixteen payload states carry four bits per module;
4. monochrome function modules remain readable under severe color distortion;
5. uncertain colors become erasures instead of forced substitutions;
6. every accepted frame passes inner MDS checks, profile validation, and CRC32;
7. dynamic frames may be received out of order and decoding may start anywhere;
8. density is increased only when verified throughput also increases.

The current robust mobile profile fixes the color count at sixteen. This is the
largest implemented alphabet, not a claim that sixteen is optimal on every
camera. A future negotiated profile may drop to eight or four states when the
measured camera-space constellation is not sufficiently separated.

## 2. Integrated geometry

### 2.1 Grid

```text
logical grid             41 x 41 modules
quiet zone               2 modules per side
display footprint        45 x 45 module pitches
browser module pitch     16 pixels
display image            720 x 720 pixels
colored core             14 / 16 = 0.875 module width
```

The two-module quiet zone and compact in-grid control layout apply the area
reduction principle of Micro QR without claiming Micro QR conformance. Unlike
Micro QR, the robust camera profile uses four 7 x 7 finders because a live
handheld reader needs four directly observed correspondences for stable
projective recovery. A one-finder compact mode is not enabled until it can
match this acquisition reliability on the device benchmark matrix.

### 2.2 Function modules

The grid reserves:

- four monochrome 7 x 7 finders with 1:1:3:1:1 scan ratios;
- one-module white separators inside the symbol boundary;
- asymmetric horizontal and vertical timing rails;
- a 3 x 5 orientation signature;
- no changing URL, sequence number, or mask metadata in the monochrome plane.

All four finders remain visible in every dynamic frame. There is no beacon
frame that temporarily stops data transmission.

The function/data allocation is:

```text
total logical modules       1681
monochrome function modules  320
calibration pilots           124
payload modules             1237
FEC codeword modules        1230
deterministic filler           7
```

Thus 99.43% of the available payload modules carry the protected codeword.

### 2.3 Homography

Finder centers in logical module coordinates are

```text
(3.5, 3.5), (37.5, 3.5), (37.5, 37.5), (3.5, 37.5)
```

For detected image centers `p_i`, the reader solves the eight-parameter
homography `H` from

```text
p_i ~ H q_i
```

and samples every pilot and payload cell through `H`. The reader rejects a
symbol below 3.5 observed pixels/module or with a maximum/minimum side ratio
above 2.4.

## 3. Four-finder acquisition

The custom reader does not call `BarcodeDetector` or `jsQR`.

1. Convert the camera image to luma.
2. Compute an Otsu threshold, constrained to `[72, 190]`.
3. Scan rows for dark/light runs matching `1:1:3:1:1`.
4. Cross-check each candidate vertically and horizontally.
5. Cluster repeated observations and require at least two votes.
6. Evaluate four-candidate quadrilaterals using side length, diagonal balance,
   area, and module-size consistency.
7. Test all eight dihedral orientations (four rotations and four reflections).
8. Project the reserved timing/orientation modules and select the orientation
   with the largest monochrome agreement score.
9. Reject orientation agreement below 0.72.

This directly removes the former failure mode in which a valid color carrier
was discarded because a complete ordinary QR payload could not be decoded.
The acquisition stage needs only the custom monochrome geometry.

For handheld capture the receiver relocks geometry every processed frame. A
previous homography may be reused for at most two frames and 260 ms after a
single detector miss; it is never retained through a geometry or sampling
failure.

## 4. Sixteen-state modulation

### 4.1 Alphabet

The nominal palette is

```text
black, maroon, red, orange,
yellow, lime, green, teal,
cyan, sky blue, blue, violet,
magenta, pink, gray, white
```

The nominal minimum CIE Lab Delta-E distance is 27.22. The runtime calibration
rejects a frame if any estimated palette pair is closer than 18 in its current
camera-space separation check.

Each payload state `s in [0,15]` carries one hexadecimal digit:

```text
I_raw = log2(16) = 4 bits/module
```

Every non-function module is first painted neutral gray. Its central 87.5%
width is then painted with the selected state, leaving a one-pixel guard on
each side at the browser reference pitch. Function modules are full-cell black
or white.

### 4.2 Global and local calibration

The grid contains 64 global pilots: four spatial observations for each of the
sixteen states. A trimmed RGB estimator produces `mu_j` and a diagonal variance
model for each state.

Sixty local pilots provide black/white pairs in eligible 8 x 8 tiles. For
channel `c`, the tile gain is

```text
g_c = clamp(
  (white_local,c - black_local,c)
  / max(24, white_global,c - black_global,c),
  0.35,
  2.5
)
```

The local palette is an affine transform of the global palette. A damaged
local pair falls back to the global model rather than invalidating the frame.

### 4.3 Soft classification

For observation `x` and palette state `j`, the decoder computes

```text
d_j(x) = sum_c (x_c - mu_j,c)^2 * inverseVariance_j,c
confidence(x) = d_second(x) - d_best(x)
```

A state becomes an erasure when either

```text
confidence(x) < erasureThreshold
```

or

```text
d_best(x) > 36
```

The reader retains `confidence / (1 + d_best)` as byte reliability for the
bounded soft-erasure chase.

## 5. Frame packing and inner FEC

### 5.1 Protected packet

One dynamic frame contains

```text
32-byte frame/control header
480-byte systematic or repair source symbol
4-byte frame CRC32
= 516 data bytes
```

The packet is divided into three 172-byte stripes. Each stripe is encoded as a
systematic Cauchy MDS code over `GF(2^8)`:

```text
[n, k] = [205, 172]
parity  = 33 bytes/stripe
R_inner = 516 / 615 = 0.8390
```

The three codewords total 615 bytes, which map to 1,230 hexadecimal color
modules. Each stripe can recover any 33 known byte erasures when all other
symbols are available.

The Cauchy generator is

```text
G = [I_k ; C]
C[r,c] = 1 / (x_r + y_c)
```

using primitive polynomial `0x11d` with disjoint `x` and `y` sets. Received
parity is recomputed after recovery. The packet is accepted only after frame
structure and CRC32 also agree.

### 5.2 Reliability chase

Two four-bit cells form one GF(256) byte. If hard classifications fail MDS or
CRC validation, bytes are ranked by the minimum reliability of their two
cells. The reader retries bounded erasure depths from

```text
{0, 1, 2, 4, 8, 12, 20, 28, budget}
```

independently within each stripe. This can recover likely hard substitutions
without claiming a general unknown-error decoder. A candidate is valid only if
its embedded mask ID, three MDS stripes, frame profile, and CRC all agree.

### 5.3 Acceptance model

If cell erasure probability is `e`, byte erasure probability is estimated as

```text
q = 1 - (1-e)^2
```

For one stripe,

```text
P_stripe(q)
  = sum(i=0..33) C(205,i) q^i (1-q)^(205-i)
```

and the conservative independent-stripe estimate is

```text
P_inner = P_stripe^3
```

Physical benchmarks must still measure correlated glare and blur because the
binomial model assumes independent erasures.

## 6. Spatial and temporal masks

Every frame evaluates sixteen reversible hexadecimal masks. For candidate `m`,
the encoder scores

```text
J(m)
  = sum_spatial DeltaE(state_u, state_v)
  + 0.28 * sum_temporal DeltaE(state_u,t, state_u,t-1)
  - 150 * same-state adjacency
  - 0.9 * palette histogram imbalance
```

The highest-scoring candidate is rendered. The selected mask ID is protected
inside the frame, while the receiver can infer it by trying all sixteen inverse
masks and requiring full MDS/profile/CRC agreement.

Payload codeword cells are spatially hash-interleaved, so consecutive bytes do
not occupy one contiguous glare-sensitive region.

## 7. Dynamic outer repair

The test object contains eight 480-byte source symbols:

```text
object size = 8 * 480 = 3840 bytes
```

Frames 0 through 7 are systematic. Later frames contain deterministic XOR
equations of degree two through five. The decoder performs GF(2) elimination,
accepts frames out of order, ignores duplicate sequences, and reconstructs once
rank reaches eight. Row insertion eliminates every existing pivot before a new
pivot is committed, preventing false full-rank states.

This outer code is an implemented startless engineering code, not RaptorQ.
Standards-oriented production work should replace it with a reviewed RaptorQ
or equivalent fountain implementation while retaining the optical PHY.

## 8. Area and throughput result

The prior 61-module footprint had

```text
A_old = 61^2 = 3721 module-pitches^2
source_old = 256 bytes/frame
```

The C16 footprint has

```text
A_C16 = 45^2 = 2025 module-pitches^2
source_C16 = 480 bytes/frame
```

Therefore

```text
G_area = 3721 / 2025 = 1.8375

G_verified-density
  = (480 / 2025) / (256 / 3721)
  = 3.4454
```

Against the former RX5 source payload of 174 bytes in the same 45 x 45
footprint, accepted payload per frame is

```text
480 / 174 = 2.7586 times
```

These are implementation capacity ratios, not measured handheld throughput.
The runtime controller still maximizes

```text
verifiedRate
  = 480 * effectiveFPS * P(finder) * P_inner
```

over 4, 6, 8, and 10 FPS. A frame failing geometry, calibration, MDS, profile,
or CRC contributes zero.

## 9. Verification scope

Automated tests currently cover:

- direct 16-state encode/decode and all sixteen reversible masks;
- three-stripe MDS erasure recovery and bounded hard-substitution recovery;
- rejection beyond a stripe's repair budget;
- frame and reconstructed-object CRC rejection;
- out-of-order repair-only outer reconstruction;
- four-finder acquisition in centered and wide camera frames;
- 90-degree rotation, reflection, projective warp, channel gain/offset, and
  mild optical blur;
- exact homography projection and adaptive throughput calculations.

Still required before a production claim:

- the full iOS/Android/OLED/LCD physical benchmark matrix;
- rolling-shutter and display-refresh phase measurements;
- correlated glare/occlusion measurements;
- camera-specific palette negotiation and C16 to C8/C4 fallback;
- authenticated encrypted-container integration;
- independent protocol and cryptographic review.
