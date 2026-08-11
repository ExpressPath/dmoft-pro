# Prism Joint-Max Dynamic Color QR

Status: experimental browser profile (`PRISM-C8-QR-JOINTMAX3`)

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

`JOINTMAX3` moves dynamic control into the protected chroma packet. The QR
luminance plane is the constant same-origin URL:

```text
https://<deployment-origin>/o
```

`/o` redirects to `/optical-lab?role=reader`. The stable URL fits Version 5/H,
so the carrier falls from 57 x 57 to 37 x 37 modules while retaining standard
three-finder QR detection, timing, alignment, masking, and level-H
Reed-Solomon protection for the luminance bootstrap.

The custom profile retains the Micro-QR-derived two-module quiet zone. It is
not a standards-compliant Micro QR symbol because it still uses a normal QR
Version 5 matrix.

### 2.2 Area equations

The previous `MICROTECH2` footprint was

```text
L_old = 57 + 2*2 = 61 modules
A_old = 61^2 = 3721 module-pitches^2
```

The current footprint is

```text
L_new = 37 + 2*2 = 41 modules
A_new = 41^2 = 1681 module-pitches^2
```

Therefore the same-pitch footprint efficiency is

```text
G_area = A_old / A_new = (61/41)^2 = 2.2136
```

The source payload per accepted frame changes from 256 to 174 bytes. The
verified source density therefore improves by

```text
G_source-density
  = (174 / 41^2) / (256 / 61^2)
  = 1.5049
```

This is the meaningful area result: **50.5% more verified source bytes per
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
bits:

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

Low-confidence cells and states that contradict the underlying QR luminance
class become erasures. They are never forced into payload symbols.

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

All received parity is recomputed after recovery. An unmarked substitution is
rejected by the parity check and CRC rather than silently accepted. This is an
erasure decoder; it does not claim general unknown-error correction.

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

### 6.1 Geometry tracking

Running a complete QR detector for every camera sample is wasteful on a stable
handheld view. After a valid frame, the receiver caches the four QR corners and
reuses the homography. It periodically relocks after `r` frames, where

```text
r in {1, 2, 3, 5}
```

Any MDS/CRC failure invalidates cached geometry immediately. Corner movement at
the next detection updates an exponentially weighted motion-risk estimate.

### 6.2 Processing and acceptance model

For target frame rate `f`, chroma decode time `t_c`, QR detection time `t_q`,
and relock interval `r`, the processing-limited rate is

```text
f_effective = min(f, 1000 / (t_c + t_q/r))
```

Tracked-frame survival is modeled as

```text
P_track = exp(-motionRisk * (r-1))
```

and average geometry acceptance is

```text
P_geometry
  = P_detect * (1 + (r-1)*P_track) / r
```

The controller evaluates every pair

```text
f in {6, 8, 10, 12, 15}
r in {1, 2, 3, 5}
```

and maximizes

```text
eta(f,r)
  = 174 * f_effective * P_geometry * P_inner / 41^2
```

Measured QR time, chroma time, frame-detection rate, mean confidence, cell
erasure rate, and corner motion are updated online. The selected FPS and relock
interval directly control the camera loop.

## 7. Measured implementation delta

On the same development machine and Node process, frame preparation measured:

| Profile | Mean preparation | Compute ceiling | Notes |
| --- | ---: | ---: | --- |
| `MICROTECH2` | 328.72 ms | 3.04 FPS | dynamic V10 QR regenerated for 16 masks |
| `JOINTMAX3` | 64.40 ms | 15.53 FPS | cached stable V5 QR, dynamic chroma only |

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
