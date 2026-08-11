# Prism Joint-Max Dynamic Color QR

Status: experimental browser profile (`PRISM-C8-QR-RX5`)

This document specifies the implemented optimization that jointly improves
area efficiency, inner error recovery, and reading speed. It distinguishes
measured implementation facts from channel-model predictions.

## 1. Joint objective

Density, redundancy, and frame rate are not optimized independently. For a
profile `theta` and measured channel state `z`, the controller maximizes

```text
eta(theta | z)
  = sourceBytes(theta)
    * effectiveFPS(theta, z)
    * P(frame accepted | theta, z)
    / symbolArea(theta)
```

The numerator counts only source bytes from a frame that passes geometry,
inner-FEC, and CRC checks. A denser but rejected frame contributes zero.

The implemented decision variables are:

```text
theta = (QR version, quiet zone, palette, inner code,
         target FPS, geometry relock interval, erasure threshold, mask)
```

The current optical carrier fixes the first four variables for interoperability
and searches the remaining variables at runtime.

## 2. Geometry and area allocation

### 2.1 Stable luminance bootstrap

The previous profile embedded session, sequence, and mask metadata in the QR
URL. That forced a Version 10/H luminance matrix and regenerated a different QR
matrix for every mask candidate and every frame.

`RX5` keeps dynamic control inside the protected chroma packet. The QR
luminance plane is the constant same-origin URL:

```text
https://<deployment-origin>/o
```

`/o` redirects to `/optical-lab?role=reader`. The stable URL fits Version 5/H,
so the carrier falls from 57 x 57 to 37 x 37 modules while retaining standard
three-finder QR detection, timing, alignment, masking, and level-H
Reed-Solomon protection for the luminance bootstrap.

The acquisition profile uses the standard four-module QR quiet zone. A
two-module margin is valid for Micro QR's different geometry, but applying it
to a normal three-finder Version 5 symbol reduced real camera acquisition.
Compact two-module operation is therefore disabled until negotiated from
measured receiver capability; this profile does not claim Micro QR conformance.

### 2.2 Area equations

The previous `MICROTECH2` footprint was

```text
L_old = 57 + 2*2 = 61 modules
A_old = 61^2 = 3721 module-pitches^2
```

The current footprint is

```text
L_new = 37 + 2*4 = 45 modules
A_new = 45^2 = 2025 module-pitches^2
```

Therefore the same-pitch footprint efficiency is

```text
G_area = A_old / A_new = (61/45)^2 = 1.8375
```

The source payload per accepted frame changes from 256 to 174 bytes. The
verified source density therefore improves by

```text
G_source-density
  = (174 / 45^2) / (256 / 61^2)
  = 1.2492
```

This is the meaningful area result: **24.9% more verified source bytes per
symbol area per accepted frame**, not a claim that every frame carries more
absolute bytes.

### 2.3 Calibration allocation

Version 5/H exposes 1,079 non-function modules for this bootstrap. The current
matrix reserves:

- 32 global pilots: four quadrants for each of eight palette states;
- 44 local pilots: one black and one white anchor in each eligible 8 x 8 tile;
- 1,003 chroma payload cells.

The global pilots estimate all eight camera-space color distributions. A tile's
black and white anchors estimate per-channel gain and offset, which transforms
the global model into a local palette. No external calibration strip or second
QR code exists.

## 3. Dual-use color modulation

Every non-function module preserves its QR luminance bit and adds two chroma
bits. The entire module is first painted black or white according to the QR
bit; only the central `14/16 = 0.875` width is painted with the chroma state.
The one-pixel-per-side luminance guard suppresses display bleed without
fragmenting the QR data plane:

```text
QR DARK  -> {black, red, dark green, blue}
QR LIGHT -> {white, yellow, cyan, magenta}
```

For observation `x`, palette state `j` is scored by diagonal Mahalanobis
distance

```text
d_j(x) = sum_c (x_c - mu_j,c)^2 / sigma_j,c^2
```

with confidence

```text
confidence(x) = d_second(x) - d_best(x)
```

Classification is restricted to the four states allowed by the already-known
QR luminance bit. A cell becomes an erasure when either the best/second-best
margin is too small or the absolute normalized distance from every allowed
state is too large. Pilot patches use channel medians and the four spatial
samples per state use a trimmed estimator, limiting glare sensitivity.

## 4. Inner Cauchy-MDS erasure code

### 4.1 Frame layout

One accepted chroma frame carries:

```text
32-byte protected frame header
174-byte outer source/repair symbol
4-byte CRC32
= 210 data octets
```

The encoder appends 40 parity octets:

```text
[n, k] = [250, 210]
R_inner = 210 / 250 = 0.84
```

The 250-byte codeword maps to exactly 1,000 quaternary cells. Three of the
1,003 available payload cells remain deterministic mask-balanced filler.

The previous implementation transmitted two 320-byte packet copies, a code
rate of 0.50. The new inner redundancy is 16% of the transmitted codeword
instead of a 100% duplicate.

### 4.2 Field and generator

Arithmetic uses `GF(2^8)` with primitive polynomial `0x11d`. The systematic
generator is

```text
G = [I_k ; C]
```

where the Cauchy parity matrix is

```text
C[r,c] = 1 / (x_r + y_c)
y_c = c
x_r = k + r
```

and field addition is XOR. The `x` and `y` sets are disjoint because
`n <= 256`; every square submatrix of `C` is nonsingular, giving the required
MDS erasure property.

The decoder keeps known systematic octets, builds only the `u x u` system for
the `u` missing data octets, and solves it with Gaussian elimination in
`GF(256)`. Recovery succeeds when

```text
u <= number of received parity octets
```

All received parity is recomputed after recovery. If the first parity check
fails, the decoder ranks codeword bytes by the minimum reliability of their
four chroma cells and performs a bounded chase at erasure depths
`{2,4,8,12,20,28,36,40}`. A hard substitution can therefore be recovered when
it lies in the low-reliability set. This remains an erasure decoder with a
soft-decision wrapper; it does not claim general algebraic unknown-error
correction.

### 4.3 Erasure acceptance model

If a quaternary cell has erasure probability `e`, a four-cell byte is erased
with probability

```text
q = 1 - (1-e)^4
```

A conservative independent-erasure estimate is

```text
P_inner(q)
  = sum from i=0 to 40 of C(250,i) q^i (1-q)^(250-i)
```

The implementation evaluates this binomial CDF when choosing the capture
policy. Spatial hashing interleaves adjacent codeword symbols across the QR
matrix to reduce burst correlation. The binomial model remains optimistic for
large correlated glare regions, so physical benchmarks must also report burst
length and tile-level loss.

## 5. Chroma mask optimization

The luminance matrix is constant, but every frame evaluates 16 reversible
chroma masks. For mask `m`, the encoder maximizes a score of the form

```text
J(m) = sum_(u,v in spatial edges) DeltaE(color_u, color_v)
     + lambda_t * sum_u DeltaE(color_u,t, color_u,t-1)
     - lambda_s * sameColorAdjacency
     - lambda_b * withinClassImbalance
```

This spreads similar colors spatially and temporally without changing the QR
dark/light plane. The selected mask ID is inside the MDS-protected packet. The
receiver tries the 16 inverse masks and accepts only the candidate whose MDS
parity, frame profile, embedded mask ID, and CRC all agree.

## 6. Reading-speed controller

### 6.1 Multi-path acquisition and handheld geometry policy

A failed full QR decode does not prove that the finder patterns are absent.
The failure may occur later in extraction, luminance classification, QR
Reed-Solomon recovery, or bootstrap parsing. `RX5` therefore reports QR
bootstrap acquisition separately from chroma and inner-FEC stages.

Each relock evaluates the following acquisition chain:

```text
native mobile QR detector (when available)
  -> centered raw RGB/grayscale QR decode
  -> centered normalized max-channel carrier decode
  -> full-frame raw decode
  -> full-frame normalized max-channel carrier decode
  -> bounded reuse of the last authenticated bootstrap geometry
```

The centered search matches the visible camera guide. The carrier projection
first normalizes each RGB channel at its observed 98th percentile and computes

```text
v(x) = max(R/R_98, G/G_98, B/B_98)
```

The RX5 palette constrains chromatic dark-state peaks below the carrier guard
band and chromatic light-state peaks above it. The projection threshold is
therefore clamped inside that deliberately empty band rather than being allowed
to collapse toward the large black finder population.

A frozen four-corner homography is not long-term tracking. However, discarding
a valid location after one transition frame also destroys synchronization.
RX5 reuses a detected location for at most three processed frames and 360 ms.
Geometry or sampling failures invalidate it immediately. This is short enough
to bound handheld drift while bridging an exposure that overlaps a color
transition.

The sender also inserts one pure monochrome acquisition beacon before every
four chroma payload frames. The beacon occupies the same Version 5 QR symbol;
it is temporal control-plane redundancy, not a second code or extra screen
region. Sequence numbers advance only on payload frames, so a beacon cannot
silently consume a source or repair symbol.

### 6.2 Processing and acceptance model

For target frame rate `f`, chroma decode time `t_c`, and QR detection time
`t_q`, the processing-limited rate is

```text
f_effective = min(f, 1000 / (t_c + t_q))
```

The controller evaluates

```text
f in {4, 6, 8, 10}
r = 1, with bounded 3-frame / 360-ms geometry reuse after a missed relock
```

and maximizes

```text
eta(f)
  = 174 * f_effective * P_detect * P_inner / 45^2
```

Measured QR time, chroma time, frame-detection rate, mean confidence, and cell
erasure rate are updated online. The selected FPS directly controls the camera
loop. Decoder diagnostics separately count finder, geometry, calibration,
sampling, and inner-FEC failures so a rejected frame has a visible cause.

## 7. Measured implementation delta

On the same development machine and Node process, frame preparation measured:

| Profile | Mean preparation | Compute ceiling | Notes |
| --- | ---: | ---: | --- |
| `MICROTECH2` | 328.72 ms | 3.04 FPS | dynamic V10 QR regenerated for 16 masks |
| `JOINTMAX3` | 64.40 ms | 15.53 FPS | historical unguarded 2-module-margin profile |
| `RX4` | pending device matrix | target 10 FPS | guarded chroma, 4-module acquisition, destructive relock failure |
| `RX5` | pending device matrix | target 10 display FPS | iso-luminant chroma, 1:4 monochrome beacon, native/carrier fallback, bounded tracking |

This is a CPU preparation microbenchmark, not camera throughput. It establishes
that the original encoder computation bottleneck was removed; real effective
throughput still requires device-pair measurements.

## 8. Outer repair and authentication boundary

The browser laboratory still uses eight source symbols and a startless
systematic `GF(2)` XOR repair stream across frames. It is not RaptorQ. Production
work should replace this with a reviewed RFC 6330 implementation while keeping
the inner Cauchy-MDS code for cell/byte erasures.

CRC32 verifies laboratory reconstruction and mask inference. It is not
cryptographic authentication. The encrypted-container pipeline must still
perform receiver-bound key decapsulation, manifest authentication, chunk AEAD,
whole-object digest verification, and safe temporary-file handling before a
file is saved.

## 9. Primary references

- [RFC 5510: Reed-Solomon FEC Schemes](https://www.rfc-editor.org/info/rfc5510/)
- [RFC 6330: RaptorQ FEC Scheme](https://www.rfc-editor.org/info/rfc6330/)
- [DENSO WAVE: QR geometry and correction](https://www.denso.com/global/home/business/innovation/qrcode/)
- [DENSO WAVE: Micro QR Code](https://www.qrcode.com/en/codes/microqr.html)
